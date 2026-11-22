import { productHtml, messageHtml as i18nHtml, setLocalizedHtml, t as i18nText } from "../i18n";
/**
 * The Syncord Security prompt (Phase 4).
 *
 * Shown when a plugin asks for a host its author did not declare. The prompt is
 * the user-visible half of the permission model, and its shape is the security
 * decision:
 *
 *  - It names the plugin and the exact host. A generic "allow network access?"
 *     teaches users to click through.
 *  - It names the capability category in plain language, and it never offers
 *    `script` — remote code execution is not something this dialog can grant.
 *  - **Allow stays disabled until "I trust this domain" is explicitly checked.**
 *    Unchecked means session-only, so approving something once does not silently
 *    turn into a permanent grant.
 *  - It shows the methods being requested. A `POST` grant is a write grant and
 *    should look different from a `GET` grant.
 */
import { createLogger } from "../api/logger";
import { requestGrant } from "../api/security";
import type { SyncordPermissionCategory } from "../../shared/native";

const log = createLogger("security-prompt");

const ROOT_ID = "Syncord-permission-root";
const STYLE_ID = "Syncord-permission-css";

const CATEGORY_LABEL: Record<SyncordPermissionCategory, string> = {
  get "network-connect"(){return i18nText("ui.network_connection");},
  get image(){return i18nText("ui.image_loading");},
  get media(){return i18nText("ui.audio_video_loading");},
  get font(){return i18nText("ui.font_loading");},
  get style(){return i18nText("ui.stylesheet_loading");},
};

const CATEGORY_BODY: Record<SyncordPermissionCategory, string> = {
  get "network-connect"(){return i18nText("ui.this_plugin_can_send_and_receive_data_with_this_host_using_the_main_pr");},
  get image(){return i18nText("ui.this_plugin_can_display_images_from_this_host_the_browser_still_sends_");},
  get media(){return i18nText("ui.this_plugin_can_stream_audio_or_video_from_this_host");},
  get font(){return i18nText("ui.this_plugin_can_load_fonts_from_this_host");},
  get style(){return i18nText("ui.this_plugin_can_load_css_from_this_host_css_can_overlay_the_interface");},
};

export type PermissionPromptRequest = {
  pluginId: string;
  pluginName: string;
  category: SyncordPermissionCategory;
  host: string;
  methods?: string[];
};

let active: { resolve: (granted: boolean) => void } | undefined;

function esc(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Ask the user. Resolves `true` only if the permission was actually recorded.
 * Never throws and never resolves on a missing bridge — a prompt that silently
 * grants would defeat the entire default-deny posture.
 */
export function promptForPermission(request: PermissionPromptRequest): Promise<boolean> {
  const existing = document.getElementById(ROOT_ID);
  if (existing !== null) existing.remove();

  return new Promise<boolean>((resolve) => {
    active?.resolve(false);

    const root = document.createElement("div");
    root.id = ROOT_ID;
    ensureStyles();

    const methods = (request.methods ?? []).map((m) => m.toUpperCase());
    const methodText = methods.length > 0 ? methods.join(", ") : i18nText("ui.any_method");

    setLocalizedHtml(root, `
      <div class="dionp-backdrop"></div>
      <div class="dionp-panel" role="alertdialog" aria-modal="true" aria-labelledby="dionp-title">
        <div class="dionp-badge">${i18nHtml("ui.security")}</div>
        <h2 class="dionp-title" id="dionp-title">${i18nHtml("ui.permission_request")}</h2>
        <p class="dionp-body">
          ${i18nHtml("ui.plugin")} <strong>${esc(request.pluginName)}</strong>
          (<code>${esc(request.pluginId)}</code>${i18nHtml("ui.wants_to_connect_to")}
          <code class="dionp-host">${esc(request.host)}</code>
        </p>
        <div class="dionp-rows">
          <div class="dionp-row"><span>${i18nHtml("ui.access")}</span><b>${productHtml(CATEGORY_LABEL[request.category])}</b></div>
          <div class="dionp-row"><span>${i18nHtml("ui.methods")}</span><b>${esc(methodText)}</b></div>
        </div>
        <p class="dionp-detail">${productHtml(CATEGORY_BODY[request.category])}</p>
        <label class="dionp-trust">
          <input type="checkbox" data-dionp-trust />
          <span>${i18nHtml("ui.i_trust_this_domain_and_want_to_remember_this_permission")}</span>
        </label>
        <p class="dionp-warn">
          ${i18nHtml("ui.without_the_checkbox_above_this_permission_lasts_for_the_current_sessi")}
        </p>
        <div class="dionp-actions">
          <button type="button" class="dionp-btn" data-dionp-deny>${i18nHtml("ui.cancel")}</button>
          <button type="button" class="dionp-btn dionp-btn--primary" data-dionp-allow disabled>${i18nHtml("ui.allow")}</button>
        </div>
      </div>
    `);

    document.documentElement.appendChild(root);

    const trust = root.querySelector<HTMLInputElement>("[data-dionp-trust]");
    const allow = root.querySelector<HTMLButtonElement>("[data-dionp-allow]");

    const close = (granted: boolean): void => {
      root.remove();
      document.removeEventListener("keydown", onKey);
      active = undefined;
      resolve(granted);
    };
    active = { resolve: (granted) => close(granted) };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close(false);
    };
    document.addEventListener("keydown", onKey);

    // The "Allow stays disabled until trust is checked" rule, enforced here so
    // it cannot be bypassed by a synthetic click on a disabled button.
    trust?.addEventListener("change", () => {
      if (allow !== null) allow.disabled = trust.checked !== true;
    });

    root.querySelector("[data-dionp-deny]")?.addEventListener("click", () => close(false));
    allow?.addEventListener("click", () => {
      const trusted = trust?.checked === true;
      void requestGrant({
        pluginId: request.pluginId,
        category: request.category,
        host: request.host,
        methods,
        trusted,
      })
        .then((result) => {
          if (result.ok) {
            log.info(`granted ${request.category} for ${request.host} (${trusted ? "persistent" : "session"})`);
            close(true);
            return;
          }
          log.warn("grant refused:", result.reason);
          close(false);
        })
        .catch(() => close(false));
    });
  });
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed; inset: 0; z-index: 100010;
      display: grid; place-items: center; padding: 24px;
      font-family: "gg sans", "Noto Sans", "Helvetica Neue", Arial, sans-serif;
      color: var(--text-normal, #dbdee1);
    }
    #${ROOT_ID} .dionp-backdrop {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
    }
    #${ROOT_ID} .dionp-panel {
      position: relative; width: min(520px, 100%);
      border: 1px solid rgba(255,255,255,0.09); border-radius: 18px;
      background: var(--background-floating, #2b2d31);
      box-shadow: 0 24px 60px rgba(0,0,0,0.5);
      padding: 22px 24px 20px;
    }
    #${ROOT_ID} .dionp-badge {
      display: inline-block; margin-bottom: 10px; padding: 2px 8px;
      border: 1px solid rgba(88,101,242,0.3); border-radius: 999px;
      background: rgba(88,101,242,0.12); color: #a5abf7;
      font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
    }
    #${ROOT_ID} .dionp-title { margin: 0 0 10px; font-size: 19px; font-weight: 650; color: var(--header-primary, #f2f3f5); }
    #${ROOT_ID} .dionp-body { margin: 0 0 14px; font-size: 13.5px; line-height: 20px; }
    #${ROOT_ID} .dionp-host { color: #c9cdfb; word-break: break-all; }
    #${ROOT_ID} .dionp-rows { display: grid; gap: 6px; margin-bottom: 12px; }
    #${ROOT_ID} .dionp-row {
      display: flex; justify-content: space-between; gap: 12px;
      padding: 7px 10px; border-radius: 9px; background: rgba(255,255,255,0.035);
      font-size: 12.5px;
    }
    #${ROOT_ID} .dionp-row span { color: var(--text-muted, #949ba4); }
    #${ROOT_ID} .dionp-detail { margin: 0 0 14px; font-size: 12.5px; line-height: 18px; color: var(--text-muted, #b5bac1); }
    #${ROOT_ID} .dionp-trust { display: flex; gap: 9px; align-items: flex-start; font-size: 13px; cursor: pointer; }
    #${ROOT_ID} .dionp-warn { margin: 8px 0 16px 24px; font-size: 11.5px; line-height: 16px; color: var(--text-muted, #949ba4); }
    #${ROOT_ID} .dionp-actions { display: flex; justify-content: flex-end; gap: 9px; }
    #${ROOT_ID} .dionp-btn {
      min-width: 92px; height: 36px; padding: 0 15px; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.1); border-radius: 9px;
      background: rgba(255,255,255,0.03); color: #b5bac1; font: inherit; font-size: 13px; font-weight: 600;
    }
    #${ROOT_ID} .dionp-btn--primary {
      border-color: rgba(88,101,242,0.5); background: #5865f2; color: #fff;
    }
    #${ROOT_ID} .dionp-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  `;
  document.documentElement.appendChild(style);
}
