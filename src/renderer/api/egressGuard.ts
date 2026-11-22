/**
 * Renderer-side egress observer (Phase 5).
 *
 * ## This is not the enforcement boundary, and the code below is written to
 * ## match that sentence rather than to contradict it.
 *
 * Everything in here runs inside Discord's own page realm, next to Discord's
 * code and next to every plugin. Any of them can capture the unpatched
 * `window.fetch` before we install, or restore it afterwards, or use a
 * transport we did not wrap. So this file **cannot** deny anything, and an
 * earlier version of it tried to. It kept a host allowlist and blocked
 * everything outside it.
 *
 * That is what made the client boot to a black screen. Measured, from the boot
 * log of a real launch:
 *
 *     blocked websocket → gateway.discord.gg (host is not on the direct-egress allowlist)
 *     Uncaught Error: Blocked by Syncord Security
 *     blocked fetch    →  (malformed url)
 *     blocked worker   →  (malformed url)
 *
 * Discord's gateway is `wss://gateway.discord.gg`. Denying it means the client
 * never receives `READY`, never renders, and the window stays black — while
 * every part of our own boot chain reports success. See SECURITY_AUDIT.md §15.
 *
 * The Phase 5 write-up already said why an allowlist is the wrong instrument
 * here: "we do not own Discord and cannot enumerate it — link previews,
 * YouTube/Spotify embeds, OAuth popouts, voice handshakes, CDN redirects and
 * third-party widgets all leave the origin legitimately. A blanket allowlist
 * would break the client, and a broken client is not a security improvement."
 * The main-process layer was built to that rule. This one was not, and the
 * lesson is recorded rather than quietly patched.
 *
 * ## What this file does instead
 *
 * 1. **Records.** Every request to a host outside Discord's own set becomes a
 *    security event naming the transport and the host, so the Security Center
 *    shows real plugin activity instead of a clean log.
 * 2. **Never interferes.** Requests are passed through untouched. No throw, no
 *    fake response, no altered return value. A hook that can wedge Discord's
 *    render loop or abort its boot has no place in a non-boundary.
 * 3. **Knows what Discord is.** The host set below is used only to *suppress*
 *    reporting of Discord's own traffic — being incomplete costs a log line,
 *    never a broken feature, which is exactly the failure asymmetry we want.
 *
 * The real control is `src/main/security/session.ts`, in the session layer,
 * where a renderer-side monkeypatch cannot reach it and where the rule can be
 * narrow enough to be safe: a request carrying a **credential** to a host
 * Discord does not own is blocked there. That layer is the enforcement, and
 * this file must not pre-empt it.
 *
 * ## Known gap
 *
 * A plugin can still read Discord's data and POST it to a third party without
 * any credential attached. Neither layer stops that, because stopping it from
 * inside the page would mean an allowlist, and an allowlist breaks the client —
 * which is precisely what this incident demonstrated. The honest answer is to
 * stop sharing a realm with untrusted code, which is the out-of-process plugin
 * design in `THIRD_PARTY_PLUGIN_SECURITY.md`. Recorded in
 * `SECURITY_ARCHITECTURE.md` §14 rather than papered over.
 *
 * What is wrapped, and why each one is worth seeing:
 *   fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon  — bodies.
 *     `sendBeacon` in particular fires during `unload`, the classic last-chance
 *     exfiltration moment.
 *   `new Image().src` / `Worker` / `SharedWorker` / `navigator.serviceWorker`
 *     / form submission / `window.open` — these leak by GET, and fetch hooks do
 *     not see them at all.
 */
import { createLogger } from "../api/logger";
import { isAssetHost } from "../../security/origins";
import { parseUrl } from "../../security/url";
import { reportObservedEgress } from "./egressReporter";

const log = createLogger("egress");

/** Set from the boot sequence; disables observation entirely in Safe Mode. */
let active = true;

export function setEgressGuardActive(value: boolean): void {
  active = value;
}

/**
 * Hosts Discord itself is expected to contact.
 *
 * Used **only** to keep Discord's own traffic out of the security log, never to
 * decide whether a request may proceed. That distinction is the whole point of
 * the rewrite: an entry missing here costs one noisy log line, whereas an entry
 * missing from a *deny* list costs a black screen.
 *
 * Suffix matching (`x.discord.com`) rather than exact, so every regional and
 * product subdomain is covered by one entry.
 */
const DISCORD_OWN_HOSTS = [
  "discord.com",
  "discordapp.com",
  "discordapp.net",
  // The gateway and voice servers. `discord.gg` is not a typo — Discord's
  // real-time infrastructure lives on it, and omitting it is what broke the
  // client. See the header.
  "discord.gg",
  "discord.co",
  "discord.co.uk",
  "discordstatus.com",
  "discord.new",
  "dis.gd",
  "discord.me",
  "dsc.gg",
  "raider.gg",
] as const;

type Verdict = { known: true } | { known: false; host: string; reason: string };

/**
 * Classify a request. Never throws, never rejects.
 *
 * Accepts every shape a caller may reasonably pass: a string, a `URL`, a
 * `Request` (fetch is called with all three), or a `Blob`. The previous version
 * used a bare `typeof url === "string"` test, so `fetch(new URL(…))` and
 * `new Worker(new URL(…))` were classified "malformed url" and denied — a plain
 * correctness bug that denied Discord's own traffic for a reason that had
 * nothing to do with security.
 *
 * Anything unparseable is reported as unknown rather than treated as an error,
 * because "we could not read this" is not evidence of anything.
 */
export function judge(rawUrl: unknown): Verdict {
  let text: string;
  try {
    if (typeof rawUrl === "string") {
      text = rawUrl;
    } else if (rawUrl instanceof URL) {
      text = rawUrl.href;
    } else if (
      typeof rawUrl === "object" &&
      rawUrl !== null &&
      typeof (rawUrl as { url?: unknown }).url === "string"
    ) {
      // A `Request`.
      text = (rawUrl as { url: string }).url;
    } else {
      return { known: false, host: "", reason: "unrecognised url shape" };
    }
  } catch {
    return { known: false, host: "", reason: "url could not be read" };
  }

  if (text.length === 0) return { known: false, host: "", reason: "empty url" };

  // A relative URL is by definition the page's own origin. Discord requests its
  // bundles this way (`/assets/…`), and an earlier version reported every one of
  // them as "unparseable url" — which is both wrong (it is same-origin) and
  // noisy enough to hide a real signal.
  //
  // `//host/path` is protocol-relative: it inherits the scheme but **not** the
  // host, so it is emphatically not same-origin and must be judged on its host
  // like anything else. Hence the check is for a single leading slash, not for
  // "starts with a slash" — a detail the regression test pins, because getting
  // it backwards would mark every third-party host as safe.
  const isPathRelative = text.startsWith("/") && !text.startsWith("//");
  const isQueryOnly = text.startsWith("?");
  if (!isPathRelative && !isQueryOnly) {
    const parsed = parseUrl(text);
    if (parsed === null) return { known: false, host: "", reason: "unparseable url" };

    const host = parsed.hostname.toLowerCase();
    if (host.length === 0) {
      // data:, blob:, about:, devtools: — a local scheme has no host to judge.
      return { known: true };
    }
    if (isAssetHost(host)) return { known: true };

    for (const domain of DISCORD_OWN_HOSTS) {
      if (host === domain || host.endsWith(`.${domain}`)) return { known: true };
    }
    return { known: false, host, reason: "host is not Discord-owned" };
  }

  return { known: true };
}

/**
 * Record an outgoing request to a host Discord does not own, and pass it
 * through. It always returns `url` so a hook reads as a pass-through.
 */
function observe(url: unknown, transport: string, detail = ""): unknown {
  try {
    if (!active) return url;
    const verdict = judge(url);
    if (verdict.known) return url;
    reportObservedEgress({ url, transport, host: verdict.host, reason: verdict.reason, detail });
    // Also to the console: the IPC report is asynchronous and can fail
    // silently, and a refusal that leaves no trace anywhere is how a broken
    // rule hides itself. The main process mirrors console warnings into the
    // boot log. Host only — never the full URL, never a body.
    log.warn(`${transport} → ${verdict.host || "(no host)"} (${verdict.reason})`);
  } catch (err) {
    // An observer that can throw into the page is a liability, not a control.
    log.log("egress observer error:", err);
  }
  return url;
}

let installed = false;

/**
 * Install the observers. Idempotent.
 *
 * Every replacement is installed with `Object.defineProperty` so that code
 * reading `window.fetch` after us — including Discord's — gets the observed
 * version, and the originals are captured *before* being replaced, which is
 * what keeps the call-throughs from recursing.
 */
export function installEgressGuard(): () => void {
  if (installed || typeof window === "undefined") return () => {};
  installed = true;

  const restore: Array<() => void> = [];
  const patch = (target: object, key: string, value: unknown): void => {
    let original: unknown;
    try {
      original = (target as Record<string, unknown>)[key];
      Object.defineProperty(target, key, {
        configurable: true,
        writable: true,
        enumerable: true,
        value,
      });
    } catch (err) {
      log.warn(`could not observe ${key}:`, err);
      return;
    }
    restore.push(() => {
      try {
        Object.defineProperty(target, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value: original,
        });
      } catch {
        /* a non-configurable property stays observed; acceptable */
      }
    });
  };

  const guardEnabled = (): boolean => active;

  // ── fetch ────────────────────────────────────────────────────────────────
  const originalFetch = window.fetch.bind(window);
  patch(window, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (guardEnabled()) {
      const url = input instanceof Request ? input : input;
      observe(url, "fetch");
    }
    return originalFetch(input as RequestInfo, init);
  });

  // ── XMLHttpRequest ───────────────────────────────────────────────────────
  const XHR = window.XMLHttpRequest;
  if (XHR !== undefined) {
    const originalOpen = XHR.prototype.open;
    patch(XHR.prototype, "open", function observedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      if (guardEnabled()) observe(url, "xhr", String(method).slice(0, 8));
      return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
    });
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  const OriginalWS = window.WebSocket;
  if (OriginalWS !== undefined) {
    const ObservedWS = function SyncordWebSocket(url: string | URL, protocols?: string | string[]) {
      if (guardEnabled()) observe(url, "websocket");
      return protocols === undefined ? new OriginalWS(url) : new OriginalWS(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(ObservedWS, OriginalWS);
    ObservedWS.prototype = OriginalWS.prototype;
    patch(window, "WebSocket", ObservedWS);
  }

  // ── EventSource ──────────────────────────────────────────────────────────
  if (window.EventSource !== undefined) {
    const OriginalES = window.EventSource;
    const ObservedES = function SyncordEventSource(url: string | URL, init?: EventSourceInit) {
      if (guardEnabled()) observe(url, "eventsource");
      return init === undefined ? new OriginalES(url) : new OriginalES(url, init);
    } as unknown as typeof EventSource;
    Object.assign(ObservedES, OriginalES);
    ObservedES.prototype = OriginalES.prototype;
    patch(window, "EventSource", ObservedES);
  }

  // ── sendBeacon ───────────────────────────────────────────────────────────
  // The unload-time channel, which is why it gets its own observer rather than
  // riding on the fetch hook. Returns the real result either way.
  if (navigator.sendBeacon !== undefined) {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    patch(navigator, "sendBeacon", (url: string | URL, data?: BodyInit | null) => {
      if (guardEnabled()) {
        observe(url, "beacon", typeof data === "string" ? `${String(data.length)} bytes` : "binary body");
      }
      return originalBeacon(url, data);
    });
  }

  // ── Image ────────────────────────────────────────────────────────────────
  if (window.Image !== undefined) {
    const OriginalImage = window.Image;
    const ObservedImage = function SyncordImage(width?: number, height?: number) {
      const image = new OriginalImage(width, height);
      let current = "";
      const originalSet = Reflect.getOwnPropertyDescriptor(OriginalImage.prototype, "src");
      Reflect.defineProperty(image, "src", {
        configurable: true,
        get: () => current,
        // Swallow-and-pass: the image is still loaded. The earlier version threw
        // from this setter, and a throw inside third-party layout code can wedge
        // Discord's render loop outright.
        set: (value: string) => {
          if (guardEnabled()) observe(value, "image");
          current = value;
          originalSet?.set?.call(image, value);
        },
      });
      return image;
    } as unknown as typeof Image;
    Object.assign(ObservedImage, OriginalImage);
    ObservedImage.prototype = OriginalImage.prototype;
    patch(window, "Image", ObservedImage);
  }

  // ── workers ──────────────────────────────────────────────────────────────
  for (const ctorName of ["Worker", "SharedWorker"] as const) {
    const Original = (window as unknown as Record<string, unknown>)[ctorName] as
      | (new (url: string | URL, options?: WorkerOptions) => Worker)
      | undefined;
    if (Original === undefined) continue;
    const Observed = function (url: string | URL, options?: WorkerOptions) {
      if (guardEnabled()) observe(url, ctorName.toLowerCase());
      return options === undefined ? new Original(url) : new Original(url, options);
    } as unknown as typeof window.Worker;
    Object.assign(Observed, Original);
    Observed.prototype = Original.prototype;
    patch(window, ctorName, Observed);
  }

  // A service worker is remote code delivery when registered from untrusted
  // script, so it is worth seeing even though nothing is denied.
  if (navigator.serviceWorker !== undefined) {
    const originalRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    patch(navigator.serviceWorker, "register", (scriptURL: string | URL, options?: RegistrationOptions) => {
      if (guardEnabled()) observe(scriptURL, "service-worker");
      return options === undefined
        ? originalRegister(scriptURL)
        : originalRegister(scriptURL, options);
    });
  }

  // Form submissions leave the page entirely; a cross-origin POST form is a
  // reliable exfiltration channel that no other hook here would see.
  if (typeof HTMLFormElement !== "undefined") {
    const originalSubmit = HTMLFormElement.prototype.submit;
    patch(HTMLFormElement.prototype, "submit", function observedSubmit(this: HTMLFormElement) {
      if (guardEnabled()) {
        observe(this.getAttribute("action") ?? this.action, "form");
      }
      return (originalSubmit as () => void).call(this);
    });
  }

  log.info("renderer egress observer installed (records only — enforcement is in the session layer)");
  return () => {
    for (const undo of restore.reverse()) undo();
    installed = false;
  };
}

/**
 * Diagnostic used by the Security Center and the tamper watchdog (Phase 28):
 * are the observers still the ones we installed?
 */
export function egressGuardInstalled(): boolean {
  return installed && active;
}

/** Exported for tests and for the "what did we see" UI. */
export const _judgeDirectEgress = judge;
