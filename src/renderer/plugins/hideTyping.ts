import { t as i18nText } from "../i18n";
import { definePlugin } from "../api/plugin";
import { definePluginSettings } from "../api/plugin/settingsDef";
import { installComposerButton, type ComposerHandle } from "./hideTyping/composer";
import {
  ALWAYS_TYPING_INITIAL_MS,
  ALWAYS_TYPING_INTERVAL_MS,
  effectiveMode,
  isTypingMode,
  shouldDriveTyping,
  shouldDropOutgoing,
  type TypingMode,
} from "./hideTyping/mode";

/**
 * Dispatched by the settings panel after it writes one of this plugin's keys, so
 * the change lands without waiting for the next reconcile tick.
 */
export const hideTypingChangeEvent = "Syncord-hide-typing-change";

/** Stable empty map so Flux subscribers do not re-render on every read. */
const NO_TYPERS: Record<string, never> = Object.freeze({});

type TypingStore = {
  getTypingUsers?: (channelId: string) => Record<string, number>;
  isTyping?: (channelId: string, userId: string) => boolean;
  emitChange?: () => void;
};

type Dispatcher = {
  dispatch?: (action: unknown) => unknown;
};

function typingStore(): TypingStore | undefined {
  const fromCommon = window.Syncord?.common?.stores.TypingStore as
    | TypingStore
    | undefined;
  if (typeof fromCommon?.getTypingUsers === "function") return fromCommon;

  const live = window.Syncord?.webpack.findByStoreName("TypingStore") as
    | TypingStore
    | undefined;
  if (typeof live?.getTypingUsers === "function") return live;
  return undefined;
}

function fluxDispatcher(): Dispatcher | undefined {
  const fromCommon = window.Syncord?.common?.flux.FluxDispatcher as
    | Dispatcher
    | undefined;
  if (typeof fromCommon?.dispatch === "function") return fromCommon;

  const live = window.Syncord?.webpack.findByProps("dispatch", "subscribe") as
    | Dispatcher
    | undefined;
  return typeof live?.dispatch === "function" ? live : undefined;
}

function selectedChannelId(): string | undefined {
  const store = window.Syncord?.common?.stores.SelectedChannelStore as
    | { getChannelId?: () => string | undefined }
    | undefined;
  const get = store?.getChannelId;
  if (typeof get !== "function") return undefined;
  try {
    const id = get.call(store);
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

const settings = definePluginSettings({
  easyChange: {
    type: "boolean",
    default: false,
    get title() { return i18nText("ui.easy_change"); },
    get description() { return i18nText("ui.add_a_button_to_the_chat_input_for_switching_how_your_typing_indicator"); },
  },
  typingMode: {
    type: "string",
    default: "hide",
    get title() { return i18nText("ui.typing_mode"); },
    get description() { return i18nText("ui.hide_typing_always_typing_or_leave_discord_alone"); },
  },
});

/**
 * Controls both halves of the typing indicator.
 *
 * Hiding the indicator on your own screen is not enough on its own: Discord has
 * already told the server by then, so everyone else still sees it. The three
 * modes therefore act on the outgoing signal:
 *
 *   hide     the outgoing action is dropped, so nothing is ever sent
 *   always   the action is allowed, and one is dispatched on a timer so the
 *            indicator never expires
 *   default  nothing is touched
 */
export const HideTypingPlugin = definePlugin({
  id: "hide-typing",
  name: i18nText("ui.hide_typing"),
  get description() { return i18nText("ui.hide_the_typing_line_and_member_list_typing_dots_and_control_whether_y"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  /**
   * Patches the typing indicator and the composer, and injects a stylesheet.
   * `webpackPatch` is declared explicitly because it is the strongest capability
   * in the system; `clipboard` is declared because the plugin copies a message
   * for the "always show" flow. No network at all.
   */
  permissions: {
    webpackPatch: true,
    media: true,
    clipboard: true,
    discordStores: ["message", "channel"],
    discordActions: ["message-send"],
  },

  start(ctx) {
    const cfg = settings.bind(ctx.plugin.id);

    const mode = (): TypingMode =>
      effectiveMode(cfg.store.easyChange, cfg.store.typingMode);

    const selectMode = (next: TypingMode): void => {
      if (!isTypingMode(next)) return;
      cfg.store.typingMode = next;
      ctx.log.info(`typing mode: ${next}`);
      // Both depend on the mode, so restart them immediately.
      stopDriving();
      startDriving();
      composer?.refresh();
    };

    ctx.css.inject(`
      [class*="typing_"],
      [class*="typingDots_"] {
        display: none !important;
      }
    `);

    let hidden = false;
    let intercepted = false;
    let suppressed = 0;

    /**
     * Blank the visible typing state.
     *
     * This hides everyone's typing, including our own, in every mode. That is
     * not the reason Always typing looks inactive locally: Discord never
     * renders your own typing back to you at all. The group-DM typing check
     * filters `userId !== getCurrentUser().id` outright, and the channel bar
     * lists other people's names. So the mode's effect is only ever visible
     * from another account or client, and the button reflects it locally
     * instead of pretending otherwise.
     */
    const hideIncoming = (): boolean => {
      if (hidden) return true;
      const store = typingStore();
      if (typeof store?.getTypingUsers !== "function") return false;

      ctx.patch.instead(store, "getTypingUsers", () => NO_TYPERS);
      if (typeof store.isTyping === "function") {
        ctx.patch.instead(store, "isTyping", () => false);
      }
      store.emitChange?.();
      hidden = true;
      ctx.log.info("typing indicator hidden");
      return true;
    };

    const intercept = (): boolean => {
      if (intercepted) return true;
      const flux = fluxDispatcher();
      if (typeof flux?.dispatch !== "function") return false;

      // The mode is read here rather than captured, so switching modes — from
      // the panel or the chat-input button — takes effect with no reload. The
      // action name is matched first, so the settings read only happens for
      // something that really is an outgoing typing action.
      ctx.patch.instead(flux, "dispatch", (args, original) => {
        if (shouldDropOutgoing(mode(), args[0])) {
          // Dropped silently. Typing is dispatched repeatedly while a message
          // is composed, so logging here would be pure noise.
          suppressed += 1;
          return undefined;
        }
        return original(...args);
      });

      intercepted = true;
      ctx.log.info("outgoing typing interception ready");
      return true;
    };

    // ── "always typing" driver ────────────────────────────────────────
    let driveTimer = 0;
    let firstDrive = 0;
    let lastChannel: string | undefined;

    const emitOnce = (): void => {
      if (!shouldDriveTyping(mode(), !document.hidden)) return;
      const channelId = selectedChannelId();
      if (!channelId) {
        lastChannel = undefined;
        return;
      }
      lastChannel = channelId;
      const flux = fluxDispatcher();
      flux?.dispatch?.({ type: "TYPING_START_LOCAL", channelId });
    };

    const startDriving = (): void => {
      stopDriving();
      if (mode() !== "always") return;
      // Immediate, so switching to this mode does not wait out a full cycle.
      firstDrive = window.setTimeout(emitOnce, ALWAYS_TYPING_INITIAL_MS);
      driveTimer = window.setInterval(emitOnce, ALWAYS_TYPING_INTERVAL_MS);
      ctx.log.info("always-typing driver started");
    };

    const stopDriving = (): void => {
      if (driveTimer) window.clearInterval(driveTimer);
      if (firstDrive) window.clearTimeout(firstDrive);
      driveTimer = 0;
      firstDrive = 0;
      lastChannel = undefined;
    };

    // ── chat-input switch ─────────────────────────────────────────────
    let composer: ComposerHandle | undefined;

    /**
     * Mount or remove the chat-input button to match the setting.
     *
     * This has to run on every reconcile, not just at start: the setting is
     * changed from the panel, long after the plugin booted, and wiring the
     * button only once meant turning it on did nothing until a restart — with
     * no way to reach the setting again without the button that never appeared.
     */
    const syncComposer = (): void => {
      if (cfg.store.easyChange) {
        if (composer) return;
        composer = installComposerButton({
          getMode: mode,
          onSelect: selectMode,
        });
        return;
      }
      composer?.dispose();
      composer = undefined;
    };

    const reconcile = (): void => {
      syncComposer();
      startDriving();
    };

    // ── wiring ───────────────────────────────────────────────────────
    const applyNow = (): void => {
      hideIncoming();
      intercept();
      reconcile();
    };

    applyNow();

    if (!hidden || !intercepted) {
      // The store or the dispatcher may be resolved after start.
      const timer = window.setInterval(() => {
        hideIncoming();
        intercept();
        reconcile();
        if (hidden && intercepted) window.clearInterval(timer);
      }, 500);
      const giveUp = window.setTimeout(() => {
        window.clearInterval(timer);
        if (!hidden) ctx.log.warn("TypingStore not found");
        if (!intercepted) {
          ctx.log.warn(
            "FluxDispatcher not found — your typing status will still be sent",
          );
        }
      }, 20_000);

      ctx.disposable(() => {
        window.clearInterval(timer);
        window.clearTimeout(giveUp);
      });
    }

    const onVisibility = (): void => {
      if (mode() === "always") emitOnce();
    };
    document.addEventListener("visibilitychange", onVisibility);
    ctx.disposable(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );

    // A general reconcile tick, so a setting changed anywhere — the panel, the
    // console, or settings.json by hand — takes effect without a restart.
    const watch = (): void => {
      const wanted = cfg.store.easyChange;
      if (wanted !== (composer != null)) syncComposer();
      if (mode() !== "always") {
        if (driveTimer) stopDriving();
        return;
      }
      if (!driveTimer) startDriving();
      // A channel change would otherwise leave the old channel's indicator
      // stale until it expires, so the new one is lit straight away.
      if (selectedChannelId() !== lastChannel) emitOnce();
    };
    const watchTimer = window.setInterval(watch, 1_000);
    ctx.disposable(() => window.clearInterval(watchTimer));

    // Instant response for the panel, with the tick as the safety net.
    const onSettingsChanged = (): void => reconcile();
    window.addEventListener(hideTypingChangeEvent, onSettingsChanged);
    ctx.disposable(() =>
      window.removeEventListener(hideTypingChangeEvent, onSettingsChanged),
    );

    ctx.disposable(() => {
      stopDriving();
      composer?.dispose();
    });

    // Reported so the panel and console can show that it is working, rather
    // than the user having to judge it from the other side.
    ctx.disposable(() => {
      if (suppressed > 0) {
        ctx.log.info(`outgoing typing suppressed ${suppressed} times`);
      }
    });
  },
  stop() {
    typingStore()?.emitChange?.();
  },
});

export {
  ALWAYS_TYPING_INITIAL_MS,
  ALWAYS_TYPING_INTERVAL_MS,
  OUTGOING_TYPING_ACTION,
  TYPING_MODES,
  effectiveMode,
  isOutgoingTypingAction,
  isTypingMode,
  shouldDriveTyping,
  shouldDropOutgoing,
  type TypingMode,
} from "./hideTyping/mode";
