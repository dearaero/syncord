import {BodyMutationObserver} from "../../ui/bodyObserver";
import { onLocaleChange, t as i18nText } from "../../i18n";
import type { PluginContext } from "../../api/plugin";
import {
  componentSource,
  ensureReact,
  kit,
  kitReady,
  openNativeMenu,
  scanKit,
  type MenuViewProps,
  type ReactNs,
  type Root,
} from "../../discordKit";

const HOST_ID = "Syncord-fake-voice-host";
const SLOT_ID = "Syncord-fake-voice-slot";
const BTN_ID = "Syncord-fake-voice";
const CHEVRON_ID = "Syncord-fake-voice-chevron";

const PANEL_LABELS = [
  "User status and settings",
  "Kullanıcı durumu ve ayarlar",
  "Kullanıcı durumu ve ayarları",
];

type Face = {
  main: string;
  chevron: string;
};

type Box = {
  width: string;
  height: string;
  borderRadius: string;
  padding: string;
};

type AudioChrome = {
  parentClass: string;
  off: Face;
  on: Face;
  contentsClass: string;
  iconClass: string;
  chevronIconClass: string;
  migration: string | null;
  gap: string;
  mainBox: Box;
  chevronBox: Box;
};

type Paint = {
  backgroundColor: string;
  color: string;
  boxShadow: string;
  backgroundImage: string;
};

/** Live mute/deafen faces. Remember both so the red style stays available after they toggle. */
let knownOff: Face | undefined;
let knownOn: Face | undefined;
/** Computed danger colors. Hover must keep these instead of the default gray. */
let knownDanger: { main: Paint; chevron: Paint } | undefined;
/** Off colors measured outside the account panel, so mute/deafen danger CSS cannot tint them. */
let knownNeutral: { main: Paint; chevron: Paint } | undefined;
let neutralKey = "";

export type FakeVoiceUi = {
  read: () => { active: boolean; mute: boolean; deaf: boolean };
  toggleActive: () => void;
  setMute: (value: boolean) => void;
  setDeaf: (value: boolean) => void;
};

function controlLabel(el: Element): string {
  return [
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("data-tooltip-text"),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .trim()
    .toLowerCase();
}

function isSettingsControl(el: Element): boolean {
  const label = controlLabel(el);
  // Discord changes/localises this label independently of the visible UI.
  // Keep the match semantic instead of pinning the exact English/Turkish string.
  return label.includes("settings") || label.includes("ayar");
}

function isVisibleBox(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.closest("[inert], [hidden]")) return false;
  const style = getComputedStyle(el);
  if (style.visibility !== "visible" || style.display === "none") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 8 && rect.height > 8
    && rect.bottom > 0 && rect.right > 0
    && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function verticalCenter(el: Element): number {
  const rect = el.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

function visibleSettingsControls(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll("button, [role='button']")]
    .filter((control): control is HTMLElement =>
      isSettingsControl(control)
      && isVisibleBox(control)
      && control.id !== BTN_ID
      && !control.closest(`#${HOST_ID}`),
    )
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
}

function findAccountPanel(): HTMLElement | null {
  const candidates: HTMLElement[] = [];

  // Keep Discord's explicit account-panel labels as hints, but do not blindly
  // trust the first match: overlays/popouts can expose another matching region.
  for (const label of PANEL_LABELS) {
    for (const el of document.querySelectorAll(`[aria-label="${label}"]`)) {
      if (isVisibleBox(el)) candidates.push(el);
    }
  }

  // The real user panel always contains the bottom-most visible User Settings
  // control. Walk upward from each settings control and keep the *smallest*
  // ancestor that also contains native audio controls.
  for (const control of visibleSettingsControls()) {
    let node = control.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      if (!isVisibleBox(node)) continue;
      if (audioControls(node).length > 0 || node.querySelector('[class*="audioButtonParent_"]')) {
        candidates.push(node);
        break;
      }
    }
  }

  if (candidates.length === 0) return null;

  // The account panel lives at the bottom of Discord's sidebar. Prefer the
  // lowest viable candidate, and for ties prefer the smaller container so a
  // broad ancestor spanning the whole app cannot win.
  const unique = [...new Set(candidates)];
  unique.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const bottomDelta = br.bottom - ar.bottom;
    if (Math.abs(bottomDelta) > 4) return bottomDelta;
    return (ar.width * ar.height) - (br.width * br.height);
  });
  return unique[0] ?? null;
}

function buttonHost(panel: HTMLElement): { parent: HTMLElement; before: Element | null } | null {
  const settings = visibleSettingsControls(panel)[0];
  if (!settings?.parentElement) return null;
  return { parent: settings.parentElement, before: settings };
}

type NativeAudioControl = {
  parent: HTMLElement;
  main: HTMLButtonElement;
  chevron: HTMLButtonElement;
};

function audioControls(panel: HTMLElement): NativeAudioControl[] {
  const found: NativeAudioControl[] = [];
  const seen = new Set<HTMLElement>();

  const add = (parent: Element, main?: Element | null, chevron?: Element | null): void => {
    if (!(parent instanceof HTMLElement) || seen.has(parent) || parent.closest(`#${HOST_ID}`)) return;
    if (!(main instanceof HTMLButtonElement) || !(chevron instanceof HTMLButtonElement) || main === chevron) return;
    seen.add(parent);
    found.push({ parent, main, chevron });
  };

  // Preferred path for Discord builds that still expose the historical hashed
  // class fragments.
  for (const parent of panel.querySelectorAll('[class*="audioButtonParent_"]')) {
    const buttons = [...parent.querySelectorAll("button")];
    const main =
      parent.querySelector('button[role="switch"], button[aria-checked], button[aria-pressed]') ??
      buttons[0] ??
      null;
    const chevron =
      parent.querySelector('button[class*="buttonChevron_"]') ??
      buttons.find((button) => button !== main) ??
      null;
    add(parent, main, chevron);
  }
  if (found.length > 0) return found;

  // Compatibility fallback for Discord builds that renamed the CSS modules.
  // The mute/deafen control is still a small two-button group: the state button
  // plus its dropdown chevron. Find the smallest ancestor with that shape rather
  // than depending on generated class names.
  const mains = panel.querySelectorAll(
    'button[role="switch"], button[aria-checked], button[aria-pressed]',
  );
  for (const candidate of mains) {
    if (!(candidate instanceof HTMLButtonElement) || candidate.closest(`#${HOST_ID}`)) continue;
    let parent = candidate.parentElement;
    for (let depth = 0; parent && parent !== panel && depth < 4; depth += 1, parent = parent.parentElement) {
      const buttons = [...parent.querySelectorAll("button")].filter(
        (button) => !button.closest(`#${HOST_ID}`) && !isSettingsControl(button),
      );
      if (buttons.length < 2 || buttons.length > 3 || !buttons.includes(candidate)) continue;
      const chevron = buttons.find((button) => button !== candidate);
      if (chevron) {
        add(parent, candidate, chevron);
        break;
      }
    }
  }
  return found;
}

function controlIsOn(main: HTMLButtonElement): boolean {
  const explicit = main.getAttribute("aria-checked") ?? main.getAttribute("aria-pressed");
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return /color(?:red|danger)/i.test(main.className);
}

const COLOR_TOKEN = /\bcolor(?:Brand|Red|Danger|Primary|Secondary|Grey|Gray|Transparent|White)(_[\w-]+)/;

function swapColor(className: string, next: "colorRed" | "colorBrand"): string {
  return className.replace(COLOR_TOKEN, `${next}$1`);
}

/** Drop classes Discord's deafen animator uses to find icons in that toolbar. */
function independentClass(className: string): string {
  return className
    .split(/\s+/)
    .filter((token) => token && !/audio|lottie|headphone|deafen/i.test(token))
    .join(" ");
}

function boxOf(el: HTMLElement): Box {
  const style = getComputedStyle(el);
  return {
    width: `${el.offsetWidth}px`,
    height: `${el.offsetHeight}px`,
    borderRadius: style.borderRadius,
    padding: style.padding,
  };
}

function colorToken(className: string): string | undefined {
  return className.split(/\s+/).find((token) => COLOR_TOKEN.test(token));
}

/** Chevron keeps its own classes, but uses the same color token as the main button. */
function paintChevron(chevronClass: string, mainClass: string): string {
  const color = colorToken(mainClass);
  if (!color) return chevronClass;
  if (COLOR_TOKEN.test(chevronClass)) return chevronClass.replace(COLOR_TOKEN, color);
  return `${chevronClass} ${color}`;
}

function paintVisible(paint: Paint): boolean {
  return paint.backgroundColor !== "transparent" && paint.backgroundColor !== "rgba(0, 0, 0, 0)";
}

function probeDanger(face: Face): void {
  if (knownDanger && paintVisible(knownDanger.main)) return;
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none";
  const main = document.createElement("button");
  main.className = face.main;
  main.setAttribute("aria-checked", "true");
  const chevron = document.createElement("button");
  chevron.className = face.chevron;
  chevron.setAttribute("data-danger", "true");
  holder.append(main, chevron);
  document.body.append(holder);
  const paint = { main: readPaint(main), chevron: readPaint(chevron) };
  holder.remove();
  if (paintVisible(paint.main)) knownDanger = paint;
}

function readPaint(el: HTMLElement): Paint {
  const style = getComputedStyle(el);
  return {
    backgroundColor: style.backgroundColor,
    color: style.color,
    boxShadow: style.boxShadow,
    backgroundImage: style.backgroundImage,
  };
}

function holdPaint(selector: string, tone: Paint): string {
  return `${selector}, ${selector}:hover, ${selector}:active, ${selector}:focus, ${selector}:focus-visible {
  background-color: ${tone.backgroundColor} !important;
  background-image: ${tone.backgroundImage} !important;
  box-shadow: ${tone.boxShadow} !important;
  color: ${tone.color} !important;
  --__lottieIconColor: ${tone.color} !important;
}
${selector} *, ${selector}:hover *, ${selector}:active *, ${selector}:focus *, ${selector}:focus-visible * {
  color: ${tone.color} !important;
  --__lottieIconColor: ${tone.color} !important;
}`;
}

/** Off state keeps the neutral button colors, including while Discord mute/deafen are red. */
function neutralCss(paint: { main: Paint; chevron: Paint }): string {
  const rest = (selector: string, tone: Paint) => `${selector} {
  background-color: ${tone.backgroundColor} !important;
  background-image: ${tone.backgroundImage} !important;
  box-shadow: ${tone.boxShadow} !important;
  color: ${tone.color} !important;
  --__lottieIconColor: ${tone.color} !important;
}
${selector} * {
  color: ${tone.color} !important;
  --__lottieIconColor: ${tone.color} !important;
}
${selector}:hover, ${selector}:active, ${selector}:focus, ${selector}:focus-visible {
  background-color: var(--background-modifier-hover, ${tone.backgroundColor}) !important;
  background-image: none !important;
  box-shadow: ${tone.boxShadow} !important;
  color: var(--interactive-hover, ${tone.color}) !important;
  --__lottieIconColor: var(--interactive-hover, ${tone.color}) !important;
}
${selector}:hover *, ${selector}:active *, ${selector}:focus *, ${selector}:focus-visible * {
  color: var(--interactive-hover, ${tone.color}) !important;
  --__lottieIconColor: var(--interactive-hover, ${tone.color}) !important;
}`;
  return [
    rest(`#${BTN_ID}[aria-checked="false"]`, paint.main),
    rest(`#${CHEVRON_ID}[data-danger="false"]`, paint.chevron),
  ].join("\n");
}

function buttonCss(
  neutral: { main: Paint; chevron: Paint } | undefined,
  danger: { main: Paint; chevron: Paint } | undefined,
): string {
  return [
    `#${BTN_ID} svg, #${CHEVRON_ID} svg { animation: none !important; transition: none !important; }`,
    neutral ? neutralCss(neutral) : "",
    danger
      ? [
          holdPaint(`#${BTN_ID}[aria-checked="true"]`, danger.main),
          holdPaint(`#${CHEVRON_ID}[data-danger="true"]`, danger.chevron),
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function probeNeutral(face: Face): void {
  const key = `${face.main}\n${face.chevron}`;
  if (knownNeutral && neutralKey === key) return;
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none";
  const main = document.createElement("button");
  main.className = face.main;
  main.setAttribute("aria-checked", "false");
  const chevron = document.createElement("button");
  chevron.className = face.chevron;
  holder.append(main, chevron);
  document.body.append(holder);
  knownNeutral = { main: readPaint(main), chevron: readPaint(chevron) };
  neutralKey = key;
  holder.remove();
}

function readAudioChrome(panel: HTMLElement): AudioChrome | undefined {
  let shape: Omit<AudioChrome, "off" | "on"> | undefined;
  for (const { parent, main, chevron } of audioControls(panel)) {
    const face: Face = { main: main.className, chevron: chevron.className };
    if (controlIsOn(main)) {
      knownOn = face;
      knownDanger = { main: readPaint(main), chevron: readPaint(chevron) };
    } else knownOff = face;

    const contents = main.querySelector('[class*="contents_"]');
    if (!shape) {
      const parentStyle = getComputedStyle(parent);
      shape = {
        parentClass: parent.className,
        contentsClass: contents instanceof HTMLElement ? contents.className : "",
        iconClass: "",
        chevronIconClass: "",
        migration: null,
        gap: parentStyle.columnGap || parentStyle.gap || "0px",
        mainBox: boxOf(main),
        chevronBox: boxOf(chevron),
      };
    }
  }
  if (!shape) return undefined;
  if (knownOn && !knownOff) {
    knownOff = { main: swapColor(knownOn.main, "colorBrand"), chevron: swapColor(knownOn.chevron, "colorBrand") };
  }
  if (knownOff && !knownOn) {
    knownOn = { main: swapColor(knownOff.main, "colorRed"), chevron: swapColor(knownOff.chevron, "colorRed") };
  }
  if (!knownOff || !knownOn) return undefined;
  const off: Face = {
    main: swapColor(knownOff.main, "colorBrand"),
    chevron: swapColor(knownOff.chevron, "colorBrand"),
  };
  probeDanger(knownOn);
  probeNeutral(off);
  return {
    ...shape,
    off,
    on: {
      main: knownOn.main,
      chevron: paintChevron(knownOn.chevron, knownOn.main),
    },
  };
}

function tooltipText(active: boolean, mute: boolean, deaf: boolean): string {
  if (!active) return i18nText("ui.fake_voice_c141e5a");
  if (mute && deaf) return i18nText("ui.fake_voice_muted_and_deafened");
  if (mute) return i18nText("ui.fake_voice_muted");
  if (deaf) return i18nText("ui.fake_voice_deafened");
  return i18nText("ui.fake_voice_c141e5a");
}

function headphones(react: ReactNs, active: boolean): unknown {
  const paths = [
    react.createElement("path", {
      d: "M3 18v-6a9 9 0 0 1 18 0v6",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
    }),
    react.createElement("path", {
      d: "M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z",
      fill: "currentColor",
    }),
  ];
  if (active) {
    paths.push(
      react.createElement("path", {
        d: "M5 5l14 14",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
      }),
    );
  }
  return react.createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 24 24",
      width: "24",
      height: "24",
      preserveAspectRatio: "xMidYMid meet",
      "aria-hidden": true,
      style: { width: "100%", height: "100%" },
    },
    ...paths,
  );
}

function withTooltip(
  react: ReactNs,
  text: string,
  renderButton: (tip: Record<string, unknown>) => unknown,
): unknown {
  const tip = kit.tooltip;
  const src = componentSource(tip);
  if (!tip || !src.includes("onMouseEnter")) return renderButton({});
  if (src.includes("cloneElement") && !/children\(/.test(src)) return renderButton({});
  return react.createElement(tip, { text, position: "top" }, (props: Record<string, unknown>) =>
    renderButton(props ?? {}),
  );
}

function tipProps(tip: Record<string, unknown>, props: Record<string, unknown>): Record<string, unknown> {
  const tipStyle = tip.style != null && typeof tip.style === "object" ? tip.style as Record<string, string> : {};
  const propStyle = props.style != null && typeof props.style === "object" ? props.style as Record<string, string> : {};
  return {
    ...tip,
    ...props,
    style: { ...tipStyle, ...propStyle },
    onMouseEnter: tip.onMouseEnter,
    onMouseLeave: tip.onMouseLeave,
    onFocus: tip.onFocus,
    onBlur: tip.onBlur,
  };
}

function buttonBox(box: Box): Record<string, string> {
  return {
    boxSizing: "border-box",
    flex: "0 0 auto",
    width: box.width,
    height: box.height,
    borderRadius: box.borderRadius,
    padding: box.padding,
  };
}

/**
 * Same control as mute/deafen: audio button plus the chevron that opens the menu.
 */
export function installFakeVoiceUi(ctx: PluginContext, ui: FakeVoiceUi): () => void {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  let slot: HTMLDivElement | undefined;
  let accountPanel: HTMLElement | undefined;
  let accountSettings: HTMLElement | undefined;
  let raf = 0;
  let warnedMenu = false;
  let logged = false;
  let painted = "";
  let resizeObs: ResizeObserver | undefined;
  const rejectedRows = new WeakMap<HTMLElement, number>();

  const openMenu = (event: { preventDefault?: () => void }) => {
    scanKit();
    event.preventDefault?.();
    const react = kit.react;
    if (!react || !kit.menu || !kit.menuCheckbox) {
      if (!warnedMenu) {
        warnedMenu = true;
        ctx.log.warn("Discord context menu unavailable");
      }
      return;
    }

    // Mute and deafen are independent, so these are checkboxes: ticking one
    // must leave the other alone.
    const MenuView = ({ navId, label, onClose }: MenuViewProps) => {
      const [, bump] = react.useState(0);
      const prefs = ui.read();
      const item = (
        id: string,
        text: string,
        checked: boolean,
        set: (value: boolean) => void,
      ) =>
        react.createElement(kit.menuCheckbox, {
          id,
          label: text,
          checked,
          action: () => {
            set(!checked);
            bump((n: number) => n + 1);
            render();
          },
        });
      const mute = item("Syncord-fake-mute", i18nText("ui.appear_muted"), prefs.mute, ui.setMute);
      const deaf = item("Syncord-fake-deafen", i18nText("ui.appear_deafened"), prefs.deaf, ui.setDeaf);
      const body = kit.menuGroup
        ? react.createElement(kit.menuGroup, { label: i18nText("ui.fake_voice") }, mute, deaf)
        : [mute, deaf];
      return react.createElement(
        kit.menu,
        { navId, "aria-label": label, onClose },
        ...(Array.isArray(body) ? body : [body]),
      );
    };

    if (!openNativeMenu(event, MenuView, "Syncord-fake-voice", i18nText("ui.fake_voice_c141e5a"))) {
      ctx.log.error("context menu failed");
    }
  };

  const render = () => {
    const react = kit.react;
    if (!root || !react || !host?.isConnected) return;
    const panel = findAccountPanel();
    const chrome = panel ? readAudioChrome(panel) : undefined;
    if (!chrome) return;

    const prefs = ui.read();
    const face = prefs.active ? chrome.on : chrome.off;
    const next = buttonCss(knownNeutral, knownDanger);
    if (next && next !== painted) {
      painted = next;
      ctx.css.inject(next);
    }
    const dangerColor = prefs.active ? knownDanger?.main.color : undefined;
    const icon = react.createElement(
      "div",
      {
        style: {
          display: "flex",
          width: "20px",
          height: "20px",
          color: dangerColor ?? "inherit",
          backgroundColor: "transparent",
          pointerEvents: "none",
        },
      },
      headphones(react, prefs.active),
    );

    const main = withTooltip(react, tooltipText(prefs.active, prefs.mute, prefs.deaf), (tip) =>
      react.createElement(
        "button",
        tipProps(tip, {
          id: BTN_ID,
          type: "button",
          role: "switch",
          className: independentClass(face.main),
          style: buttonBox(chrome.mainBox),
          "aria-checked": prefs.active ? "true" : "false",
          "data-danger": prefs.active ? "true" : "false",
          "aria-label": i18nText("ui.fake_voice"),
          onClick: (event: { preventDefault?: () => void }) => {
            event.preventDefault?.();
            ui.toggleActive();
            render();
          },
          onContextMenu: (event: { preventDefault?: () => void }) => {
            event.preventDefault?.();
            openMenu(event);
          },
        }),
        icon,
      ),
    );

    const chevronIcon = react.createElement(
      "svg",
      {
        "aria-hidden": true,
        role: "img",
        xmlns: "http://www.w3.org/2000/svg",
        width: "12",
        height: "12",
        fill: "none",
        viewBox: "0 0 24 24",
        style: { pointerEvents: "none" },
      },
      react.createElement("path", {
        fill: "currentColor",
        d: "M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z",
      }),
    );
    const chevron = withTooltip(react, i18nText("ui.fake_voice_options"), (tip) =>
      react.createElement(
        "button",
        tipProps(tip, {
          id: CHEVRON_ID,
          type: "button",
          className: independentClass(face.chevron),
          style: buttonBox(chrome.chevronBox),
          "data-danger": prefs.active ? "true" : "false",
          "aria-label": i18nText("ui.fake_voice_options"),
          onClick: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
            event.preventDefault?.();
            event.stopPropagation?.();
            openMenu(event);
          },
          onContextMenu: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
            event.preventDefault?.();
            event.stopPropagation?.();
            openMenu(event);
          },
        }),
        chevronIcon,
      ),
    );

    root.render(
      react.createElement(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            width: "100%",
            height: "100%",
            gap: chrome.gap,
          },
        },
        main,
        chevron,
      ),
    );
  };

  ctx.disposable(onLocaleChange(render));

  const nativeControl = (panel: HTMLElement): HTMLElement | undefined => {
    const settings = visibleSettingsControls(panel)[0];
    const controls = audioControls(panel)
      .filter(({ parent }) => !parent.closest(`#${SLOT_ID}`) && isVisibleBox(parent));

    if (controls.length === 0) return undefined;
    if (!settings) {
      return controls.sort(
        (a, b) => b.parent.getBoundingClientRect().bottom - a.parent.getBoundingClientRect().bottom,
      )[0]?.parent;
    }

    // Pick the audio group on the same row as the bottom-most settings button.
    // This prevents a titlebar/headphones control elsewhere in a broad ancestor
    // from being used as the Fake Voice size/position reference.
    const targetY = verticalCenter(settings);
    controls.sort(
      (a, b) =>
        Math.abs(verticalCenter(a.parent) - targetY)
        - Math.abs(verticalCenter(b.parent) - targetY),
    );
    return controls[0]?.parent;
  };

  const ensureSlot = (panel: HTMLElement): HTMLDivElement | undefined => {
    const stale=document.getElementById(SLOT_ID);
    if(stale instanceof HTMLElement&&(stale.offsetHeight>64||stale.offsetWidth>128)){
      stale.remove();if(slot===stale)slot=undefined;
    }
    const anchor = buttonHost(panel);
    if (!anchor) return undefined;
    const rowWidth=anchor.parent.getBoundingClientRect().width;
    if(rejectedRows.get(anchor.parent)===rowWidth)return undefined;
    const baseline=anchor.before?.getBoundingClientRect();
    const sample = nativeControl(panel);
    const found = document.getElementById(SLOT_ID);
    let node: HTMLDivElement;
    if (found instanceof HTMLDivElement && found.isConnected) {
      node = found;
      if (node.parentElement !== anchor.parent) {
        if (anchor.before) anchor.parent.insertBefore(node, anchor.before);
        else anchor.parent.appendChild(node);
      }
    } else {
      found?.remove();
      node = document.createElement("div");
      node.id = SLOT_ID;
      node.setAttribute("aria-hidden", "true");
      node.style.flex = "0 0 auto";
      node.style.pointerEvents = "none";
      if (anchor.before) anchor.parent.insertBefore(node, anchor.before);
      else anchor.parent.appendChild(node);
    }
    if (sample) {
      const buttons=[...sample.querySelectorAll('button')];
      const rects=buttons.map(button=>button.getBoundingClientRect());
      const height=Math.max(0,...rects.map(rect=>rect.height));
      const width=rects.reduce((sum,rect)=>sum+rect.width,0);
      if(height>0&&width>0){
        node.style.width=`${Math.min(128,width)}px`;
        node.style.height=`${Math.min(64,height)}px`;
        node.style.maxHeight='64px';node.style.alignSelf='center';
      }
    }
    // Adding our control must never wrap/reposition Discord's own settings/audio buttons.
    const after=anchor.before?.getBoundingClientRect();
    if(baseline&&after&&Math.abs((baseline.top+baseline.height/2)-(after.top+after.height/2))>4){
      node.remove();slot=undefined;rejectedRows.set(anchor.parent,anchor.parent.getBoundingClientRect().width);return undefined;
    }
    slot = node;
    return node;
  };

  const place = () => {
    const panel = accountPanel?.isConnected && accountSettings?.isConnected && accountPanel.contains(accountSettings) ? accountPanel : findAccountPanel();
    accountPanel = panel ?? undefined;
    const reserved = panel ? ensureSlot(panel) : undefined;
    if (!host) return;
    if (!reserved) { host.hidden = true; return; }
    const rect = reserved.getBoundingClientRect();
    const settings = panel ? visibleSettingsControls(panel)[0] : undefined;
    accountSettings = settings;
    const sameRow = settings
      ? Math.abs(verticalCenter(settings) - (rect.top + rect.height / 2))
        <= Math.max(4, settings.getBoundingClientRect().height/4)
      : false;
    const nearBottom = rect.top >= window.innerHeight * 0.6;
    const visible = rect.width > 2 && rect.height > 2 && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth
      && sameRow && nearBottom;
    host.hidden = !visible;
    if (!visible) {
      if(settings&&slot&&(!sameRow||!nearBottom)){
        const row=slot.parentElement;slot.remove();slot=undefined;
        if(row)rejectedRows.set(row,row.getBoundingClientRect().width);
      }
      return;
    }
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
    if (slot) resizeObs?.observe(slot);
  };

  const tryMount = (): boolean => {
    ensureReact();
    scanKit();
    if (!logged && kitReady()) {
      logged = true;
      ctx.log.info(
        `ui audio-button menu=${kit.menu && kit.menuCheckbox ? "discord" : "missing"}`,
      );
    }
    if (!kit.react || !kit.createRoot) return false;

    const panel = findAccountPanel();
    accountPanel = panel ?? undefined;
    if (!panel || !readAudioChrome(panel) || !ensureSlot(panel)) return false;

    if (host?.isConnected && root) {
      render();
      place();
      return true;
    }
    document.getElementById(HOST_ID)?.remove();

    const node = document.createElement("div");
    node.id = HOST_ID;
    node.style.position = "fixed";
    node.style.zIndex = "100";
    node.style.margin = "0";
    node.style.pointerEvents = "auto";
    document.body.appendChild(node);

    const mounted = kit.createRoot(node);
    host = node;
    root = mounted;
    render();
    place();
    resizeObs?.disconnect();
    resizeObs = new ResizeObserver(() => place());
    resizeObs.observe(panel);
    if (slot) resizeObs.observe(slot);
    return true;
  };

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!host?.isConnected) tryMount();
      else place();
    });
  };

  const onMove = () => schedule();
  window.addEventListener("resize", onMove);
  window.addEventListener("scroll", onMove, true);

  tryMount();
  const observer = new BodyMutationObserver(records => {
    // Chat messages and utility-panel updates do not move the account controls.
    // Keep native subtree changes and React replacements observable.
    if (!host?.isConnected || !slot?.isConnected || !accountPanel?.isConnected || !accountSettings?.isConnected || !accountPanel.contains(accountSettings)
      || records.some(record => accountPanel?.contains(record.target))) schedule();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });

  const bootTries = window.setInterval(() => {
    if (tryMount()) window.clearInterval(bootTries);
  }, 500);
  const bootStop = window.setTimeout(() => {
    window.clearInterval(bootTries);
    if (document.getElementById(HOST_ID)) return;
    if (!kit.react || !kit.createRoot) ctx.log.warn("Discord React root unavailable");
    else if (!findAccountPanel()) ctx.log.warn("account panel not found");
    else ctx.log.warn("audio button not found");
  }, 30_000);

  return () => {
    observer.disconnect();
    resizeObs?.disconnect();
    accountPanel = accountSettings = undefined;
    window.removeEventListener("resize", onMove);
    window.removeEventListener("scroll", onMove, true);
    if (raf) cancelAnimationFrame(raf);
    window.clearInterval(bootTries);
    window.clearTimeout(bootStop);
    try {
      kit.closeContextMenu?.();
    } catch {
      /* menu already closed */
    }
    try {
      root?.unmount();
    } catch {
      /* host already removed */
    }
    host?.remove();
    slot?.remove();
    root = undefined;
    host = undefined;
    slot = undefined;
  };
}
