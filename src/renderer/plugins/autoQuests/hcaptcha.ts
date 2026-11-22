/**
 * Answer Discord's own hCaptcha challenges without a click.
 *
 * ## Why this exists separately from the claim watcher
 *
 * The watcher makes its own API calls and handles the captcha those calls draw.
 * This handles the *other* path: when Discord's own client decides a request
 * needs a captcha, it opens its own hCaptcha widget and waits for a human. From
 * the user's side that is the one thing left to click.
 *
 * The seam is `window.hcaptcha.execute(sitekey, params, callback)` — hCaptcha's
 * own invisible-execute API, which is what an in-app captcha flow calls to get
 * a token without rendering anything. When a solve succeeds, the callback is
 * answered from the solver and the real widget never opens.
 *
 * ## What it deliberately does not do
 *
 * It does not render, click, or fake the widget, and it does not touch
 * `hcaptcha.render` — a rendered widget owns a container and a `getResponse`
 * poll that we would have to impersonate, and a half-impersonated widget is
 * worse than none. When solving is not possible, **the original runs** and the
 * user gets the captcha they would have got anyway.
 *
 * Three conditions must all hold before a single credit is spent: the auto-claim
 * switch is on, a key is stored, and the challenge carries a sitekey.
 */
import type { PluginContext } from "../../api/plugin/types";

const POLL_MS = 2_000;

/** Discord's own origin, which is all a solve request may name. */
const PAGE_URL = "https://discord.com/";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Widget = {
  execute?: (sitekey: unknown, params: unknown, callback?: unknown) => void;
  [key: string]: unknown;
};

let activeContext: PluginContext | undefined;
let patched: Widget | undefined;
let originalExecute: Widget["execute"];
let timer: ReturnType<typeof setInterval> | undefined;

/** True once the widget has been patched, so the status line can say so. */
export function hcaptchaBridgePatched(): boolean {
  return patched !== undefined;
}

/**
 * The switch and the key, as the watcher reads them.
 *
 * Checked per challenge rather than once at install: the user can switch
 * auto-claiming off or clear the key at any moment, and a patch that had
 * already decided "yes" would keep spending money after they did.
 */
async function maySolve(ctx: PluginContext): Promise<boolean> {
  if (ctx.settings.get("autoClaim") !== true) return false;
  try {
    const status = await ctx.captcha.status();
    return status.configured === true && status.lockedDown !== true;
  } catch {
    return false;
  }
}

/**
 * Install the bridge on a widget, if it is one we have not seen.
 *
 * Idempotent: Discord can replace the global more than once, and re-patching a
 * patched function would solve the same challenge twice.
 */
export function checkHcaptchaWidget(ctx: PluginContext): boolean {
  const widget = (window as unknown as { hcaptcha?: Widget }).hcaptcha;
  if (!widget || typeof widget.execute !== "function") return false;
  if (widget === patched && originalExecute !== undefined) return true;

  patched = widget;
  originalExecute = widget.execute;
  const original = originalExecute;

  widget.execute = function patchedExecute(sitekey: unknown, params: unknown, callback?: unknown): void {
    void respond(ctx, sitekey, readRqdata(params), callback, () => {
      // Only reached when we do not answer: Discord's own captcha, unchanged.
      original.call(this, sitekey, params, callback);
    });
  };

  return true;
}

/** hCaptcha passes `{rqdata}` through for enterprise sitekeys. */
function readRqdata(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const value = (params as { rqdata?: unknown }).rqdata;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Answer the callback from the solver, or fall back to the real widget.
 *
 * `execute` is callback-shaped and its callback is optional, so both the
 * "answered" and the "not answered" paths have to be explicit.
 */
async function respond(
  ctx: PluginContext,
  sitekey: unknown,
  rqdata: string | undefined,
  callback: unknown,
  fallback: () => void,
): Promise<void> {
  if (typeof sitekey !== "string" || !UUID.test(sitekey)) {
    fallback();
    return;
  }
  if (!(await maySolve(ctx))) {
    fallback();
    return;
  }

  let result;
  try {
    result = await ctx.captcha.solve({
      sitekey,
      url: PAGE_URL,
      ...(rqdata === undefined ? {} : { rqdata }),
    });
  } catch {
    fallback();
    return;
  }

  if (!result.ok) {
    ctx.log.warn(`Could not solve the Discord CAPTCHA: ${result.code}`);
    fallback();
    return;
  }

  if (typeof callback === "function") {
    // The shape hcaptcha's execute callback expects.
    (callback as (value: { response: string; respKey: string | null }) => void)({
      response: result.token,
      respKey: result.respKey,
    });
    return;
  }
  // Nobody is listening, so a token would go nowhere: let Discord do its thing.
  fallback();
}

/** Start watching for hCaptcha's global. Safe to call more than once. */
export function startHcaptchaBridge(ctx: PluginContext): void {
  activeContext = ctx;
  if (timer === undefined) {
    // hcaptcha's script is loaded on demand, so at boot there is usually
    // nothing to patch yet. Two seconds is frequent enough to feel immediate
    // and rare enough to be invisible.
    timer = setInterval(() => {
      if (activeContext !== undefined) checkHcaptchaWidget(activeContext);
    }, POLL_MS);
  }
  checkHcaptchaWidget(ctx);
}

/** Undo the patch. Required: a left-behind patch keeps spending credits. */
export function stopHcaptchaBridge(): void {
  activeContext = undefined;
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  if (patched !== undefined && originalExecute !== undefined) {
    patched.execute = originalExecute;
  }
  patched = undefined;
  originalExecute = undefined;
}