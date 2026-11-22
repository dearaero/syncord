import { localizeError, localizeMessage, onLocaleChange, productHtml, getLocale, messageHtml as i18nHtml, setLocalizedHtml, setLocalizedText, t as i18nText } from "../i18n";
import { rendererPrivacyStatus } from "../core/privacy";
/**
 * Security Center (Phase 11).
 *
 * A read-mostly view of what the security subsystem is actually doing, plus the
 * two actions a user may need under pressure: leave Safe Mode and engage
 * Emergency Lockdown.
 *
 * Design rules this view follows, each of which is a security property rather
 * than a style choice:
 *
 *  - **It shows the real allowlists, not the word "ON".** "Trusted Origins: ON"
 *    tells a user nothing they can act on. Listing the hosts and the external
 *    protocols tells them exactly what is and is not trusted.
 *  - **It never renders a secret.** No request body, no `Authorization` header,
 *    no URL path with a query string. Events arrive pre-redacted from the main
 *    process, and this view does no re-imaging of them.
 *  - **Lockdown is two-step and irreversible for the session.** A confirmation
 *    dialog, then a clear statement of what will and will not happen — including
 *    that Discord's account token is not touched and no logout is forced.
 *    A panic button that logs you out is both a data-loss event and a phishing
 *    target.
 */
import { createLogger } from "../api/logger";
import {
  armLockdown,
  listPermissions,
  revokeGrant,
  securityEvents,
  securityPolicy,
  securityStatus,
} from "../api/security";
import { exitSafeMode } from "../api/modes";
import { runWatchdog } from "../api/watchdog";
import { plugins } from "../api/plugin";
import { refreshStatus, updateState } from "../api/updater";
import type {
  SyncordPermissionGrant,
  SyncordSecurityEvent,
  SyncordSecurityStatus,
  SyncordUpdateStatus,
} from "../../shared/native";

const log = createLogger("security-center");

const CONTAINER_ATTR = "data-dion-security";
let container: HTMLElement | undefined;

function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusPill(on: boolean, whenOff = i18nText("ui.off"), whenOn = "ui.on"): string {
  return on
    ? `<span class="dionsec-pill is-on">${i18nHtml(whenOn)}</span>`
    : `<span class="dionsec-pill is-off">${productHtml(whenOff)}</span>`;
}

function integrityLabel(state: string): { text: string; ok: boolean } {
  switch (state) {
    case "ok":
      return { text: i18nText("ui.verified"), ok: true };
    case "development":
      return { text: i18nText("ui.development_build"), ok: true };
    case "modified":
      return { text: i18nText("ui.modified"), ok: false };
    case "unreadable":
      return { text: i18nText("ui.unverified"), ok: false };
    default:
      return { text: i18nText("ui.unverified"), ok: false };
  }
}

function row(label: string, value: string): string {
  return `<div class="dionsec-row"><span>${productHtml(label)}</span><b>${value}</b></div>`;
}

/**
 * The update row's pill.
 *
 * Its own function because the states are not a boolean and the existing
 * `statusPill(on, whenOff)` shape cannot express them honestly. The important
 * distinction is between "we checked and there is nothing new" (`up-to-date`,
 * neutral) and "we could not complete the check" (`error`, warning). Collapsing
 * both into a pill that is either ON or OFF is how a failed check ends up
 * looking like a healthy one.
 */
function updateLabel(state: SyncordUpdateStatus): { text: string; tone: string } {
  switch (state.phase) {
    case "idle":
      // Either never run, or reset because the user turned checking off. Main
      // does not distinguish, and claiming it would be a guess.
      return { text: i18nText("ui.not_checked"), tone: "is-off" };
    case "checking":
      return { text: "CHECKING", tone: "is-off" };
    case "up-to-date":
      return { text: i18nText("ui.up_to_date"), tone: "is-on" };
    case "available":
      return { text: i18nText("ui.available_value", {v0: state.latest ?? "?"}), tone: "is-on" };
    case "downloading":
      return { text: i18nText("ui.downloading_value_a967dc5", {v0: Math.round((state.progress ?? 0) * 100)}), tone: "is-off" };
    case "ready":
      return { text: i18nText("ui.verified_value", {v0: state.stagedVersion ?? "?"}), tone: "is-on" };
    case "handing-off":
      return { text: "INSTALLING", tone: "is-off" };
    case "handed-off":
      return { text: "INSTALLED", tone: "is-on" };
    case "error":
      return { text: i18nText("ui.last_check_failed"), tone: "is-bad" };
    default:
      return { text: "UNKNOWN", tone: "is-bad" };
  }
}

/**
 * The update card: current phase, channel, and the last failure.
 *
 * Its own card rather than two more rows in "Protection status", because the
 * question it answers is different. Every row above answers "is a guard
 * running?"; this one answers "what did the updater last do, and did it work?".
 * The last error is shown verbatim-ish because a silent failed update is
 * indistinguishable from no update existing.
 */
function updateCard(): string {
  const state = updateState();
  const label = updateLabel(state);
  const channel = state.channel === "beta" ? "BETA" : "STABLE";
  const build = state.build;
  const seen = state.latest ?? "—";

  return `
    <section class="dionsec-card">
      <div class="dionsec-card-head">
        <h3>${i18nHtml("ui.updates")}</h3>
        <span class="dionsec-badge">${channel}</span>
      </div>
      ${row(i18nText("ui.status"), `<span class="dionsec-pill ${label.tone}">${esc(label.text)}</span>`)}
      ${row(i18nText("ui.installed"), `<span class="dionsec-pill is-off">v${esc(build)}</span>`)}
      ${row(i18nText("ui.latest_release"), `<span class="dionsec-pill is-off">${esc(seen)}</span>`)}
      ${state.lastError
          ? row(
              i18nText("ui.last_error"),
              `<span class="dionsec-pill is-bad">${esc(localizeError(state.lastError))}</span>`,
            )
          : ""}
      <p class="dionsec-note">
        ${i18nHtml("ui.releases_are_fetched_from_a_fixed_github_host_and_accepted_only_when_t")}
      </p>
    </section>`;
}

function eventRow(event: SyncordSecurityEvent): string {
  const when = new Date(event.timestamp).toLocaleTimeString(getLocale());
  const bits = [event.host, event.method, event.pluginId, event.channel, event.origin].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return `
    <li class="dionsec-event is-${esc(event.severity)}">
      <span class="dionsec-event-time">${esc(when)}</span>
      <span class="dionsec-event-type">${esc(event.type)}</span>
      <span class="dionsec-event-reason">${esc(localizeMessage(event.reason ?? ""))}</span>
      <span class="dionsec-event-meta">${esc(bits.join(" · "))}</span>
    </li>
  `;
}

function grantRow(grant: SyncordPermissionGrant): string {
  return `
    <li class="dionsec-grant">
      <span class="dionsec-grant-host">${esc(grant.host)}</span>
      <span class="dionsec-grant-cat">${esc(grant.category)}</span>
      <span class="dionsec-grant-plugin">${esc(grant.pluginId)}</span>
      <span class="dionsec-grant-scope">${grant.trusted ? i18nHtml("ui.remembered") : i18nHtml("ui.this_session")}</span>
      <button type="button" class="dionsec-revoke" data-dion-revoke="${esc(grant.key)}">${i18nHtml("ui.revoke")}</button>
    </li>
  `;
}

function permissionTable(): string {
  const rows = plugins
    .list()
    .map(
      (plugin) => `
        <li class="dionsec-plugin">
          <span class="dionsec-plugin-name">${esc(plugin.name)}</span>
          <code class="dionsec-plugin-id">${esc(plugin.id)}</code>
          <span class="dionsec-plugin-perms">${esc(plugin.permissionSummary)}</span>
        </li>
      `,
    )
    .join("");
  return rows.length > 0 ? rows : `<li class="dionsec-plugin">${i18nHtml("ui.no_plugins_registered")}</li>`;
}

let disposeLocale: (()=>void)|undefined;

/** Mount the view into the settings panel's content area. */
export function mountSecurityCenter(host: HTMLElement): void {
  disposeLocale?.();
  container = host;
  disposeLocale=onLocaleChange(()=>{void refresh();});
  void refresh();
}

export function unmountSecurityCenter(): void {
  disposeLocale?.();disposeLocale=undefined;
  container = undefined;
}

async function refresh(): Promise<void> {
  if (container === undefined || !container.isConnected) return;

  const target=container;
  const [status, events, grants, policy] = await Promise.all([
    securityStatus(),
    securityEvents(60),
    listPermissions(),
    securityPolicy(),
    // The update card reads the renderer's local cache, which only advances when
    // something asks for it. Without this the card shows whatever the last
    // automatic check left behind — "NOT CHECKED" on a client that checked an
    // hour ago — which is the opposite of what a status row is for.
    refreshStatus(),
  ]);
  if (container !== target || !container?.isConnected) return;
  if (status === undefined) {
    setLocalizedHtml(container, `
      <section class="dionsec-card">
        <h3>${i18nHtml("ui.security_center_unavailable")}</h3>
        <p>${i18nHtml("ui.the_privileged_bridge_is_not_present_which_means_this_page_is_not_a_tr")}</p>
      </section>
    `);
    return;
  }

  const privacy = status.privacy;
  const localPrivacy = rendererPrivacyStatus();
  const integrity = integrityLabel(status.integrity);
  const lockedPlugins = policy?.plugins.filter((entry) => entry.blocked) ?? [];

  setLocalizedHtml(container, `
    <section class="dionsec-card">
      <div class="dionsec-card-head">
        <h3>${i18nHtml("ui.protection_status")}</h3>
        <span class="dionsec-badge">Syncord ${esc(status.version)}</span>
      </div>

      ${row(
        i18nText("ui.network_broker"),
        // The only layer that refuses plugin traffic. Labelled ENFORCING because
        // it is: an unpermitted request is denied before the socket opens.
        status.brokerEnforcing
          ? `<span class="dionsec-pill is-on">${i18nHtml("ui.enforcing")}</span>`
          : statusPill(false, i18nText("ui.not_installed")),
      )}
      ${row(
        i18nText("ui.credential_monitor"),
        // Deliberately OBSERVE-ONLY, and the pill says so.
        //
        // It sits in the session layer and sees every request carrying a
        // credential to a non-Discord host — but it does **not** cancel. Turning
        // that on breaks Discord's own Spotify integration, which sends the
        // user's Spotify OAuth token to api.spotify.com by design. Calling this
        // "Network Guard / ON" implied a block that does not happen.
        status.egressMonitor
          ? statusPill(false, i18nText("ui.observe_only"))
          : statusPill(false, i18nText("ui.not_installed")),
      )}
      ${row(i18nText("ui.ipc_guard"), status.senderValidation ? statusPill(true) : statusPill(false, i18nText("ui.not_installed")))}
      ${row(i18nText("ui.trusted_origins"), status.trustedOrigins ? statusPill(true) : statusPill(false, i18nText("ui.not_trusted")))}
      ${row(i18nText("ui.plugin_permissions"), statusPill(true))}
      ${row(i18nText("ui.remote_scripts"), statusPill(false, i18nText("ui.blocked")))}
      ${row(i18nText("ui.electron_permissions"), status.permissionHandlers ? statusPill(true) : statusPill(false, i18nText("ui.not_installed")))}
      ${row(
        i18nText("ui.integrity"),
        `<span class="dionsec-pill ${integrity.ok ? "is-on" : "is-bad"}">${esc(integrity.text)}</span>`,
      )}
      ${row("DevTools", status.devTools ? statusPill(true) : statusPill(false, i18nText("ui.off")))}
      ${row(i18nText("ui.secret_storage"), status.encryptionAvailable ? statusPill(true) : statusPill(false, i18nText("ui.no_keychain")))}
      ${row(i18nText("ui.safe_mode"), status.safeMode ? statusPill(true) : statusPill(false, i18nText("ui.off")))}
      ${row(i18nText("ui.emergency_lockdown"), status.lockdown ? statusPill(true) : statusPill(false, i18nText("ui.off")))}
    </section>

    <section class="dionsec-card">
      <div class="dionsec-card-head"><h3>${i18nHtml("ui.core_privacy")}</h3><span class="dionsec-badge">${i18nHtml("ui.built_in")}</span></div>
      ${row(i18nText("ui.telemetry_request_filter"), privacy?.requestFilterInstalled ? statusPill(true) : statusPill(false, i18nText("ui.unavailable")))}
      ${row(i18nText("ui.native_crash_reporter_startup"), privacy?.nativeCrashGuard ? statusPill(true,undefined,"ui.blocked") : statusPill(false, i18nText("ui.unavailable")))}
      ${row(i18nText("ui.discord_crash_reporter_opt_out"), privacy?.discordCrashStartupDisabled ? statusPill(true) : statusPill(false, i18nText("ui.unavailable")))}
      ${row(i18nText("ui.analytics_queue_suppression"), localPrivacy.analytics ? statusPill(true) : statusPill(false, i18nText("ui.not_detected")))}
      ${row(i18nText("ui.metrics_timer_suppression"), localPrivacy.metrics ? statusPill(true) : statusPill(false, i18nText("ui.not_detected")))}
      <p class="dionsec-note">Known Discord analytics, metrics and Sentry requests are blocked locally.
        ${privacy ? i18nHtml("ui.blocked_this_session_value_analytics_value_metrics_value_crash_reports", {v0: privacy.blocked.analytics, v1: privacy.blocked.metrics, v2: privacy.blocked.crashReports, v3: privacy.blocked.sentryScript}) : i18nHtml("ui.restart_discord_with_the_latest_syncord_build_to_enable_core_privacy")}
        No request contents are stored. This runs independently of plugins.</p>
      <p class="dionsec-note">${i18nHtml("ui.this_does_not_prevent_discord_from_processing_messages_voice_or_accoun")}</p>
    </section>

    ${updateCard()}

    <section class="dionsec-card">
      <div class="dionsec-card-head"><h3>${i18nHtml("ui.effective_policy")}</h3></div>
      <p class="dionsec-note">
        ${i18nHtml("ui.brokered_plugin_requests_can_only_reach_a_host_listed_for_them_anythin")}
      </p>
      ${policy && policy.plugins.length > 0
          ? `<ul class="dionsec-list">${policy.plugins
              .map(
                (entry) => `
                  <li class="dionsec-plugin">
                    <code class="dionsec-plugin-id">${esc(entry.id)}</code>
                    <span class="dionsec-plugin-perms">${
                      entry.hosts.length > 0 ? esc(entry.hosts.join(", ")) : "no network access"
                    }</span>
                    ${entry.webhookSend ? `<span class="dionsec-pill is-bad">webhook</span>` : ""}
                    ${entry.blocked ? `<span class="dionsec-pill is-bad">${i18nHtml("ui.blocked")}</span>` : ""}
                  </li>
                `,
              )
              .join("")}</ul>`
          : `<p class="dionsec-note">${i18nHtml("ui.no_plugin_holds_network_access")}</p>`}
      ${lockedPlugins.length > 0
          ? `<p class="dionsec-note">${lockedPlugins.length} plugin(s) currently blocked.</p>`
          : ""}
    </section>

    <section class="dionsec-card">
      <div class="dionsec-card-head"><h3>${i18nHtml("ui.plugin_permissions_45b8612")}</h3></div>
      <ul class="dionsec-list">${permissionTable()}</ul>
    </section>

    <section class="dionsec-card">
      <div class="dionsec-card-head">
        <h3>${i18nHtml("ui.network_permissions")}</h3>
        <span class="dionsec-badge">${esc(grants.length)}</span>
      </div>
      <p class="dionsec-note">
        ${i18nHtml("ui.hosts_you_approved_this_session_permissions_disappear_when_discord_res")}
      </p>
      ${grants.length > 0
          ? `<ul class="dionsec-list">${grants.map(grantRow).join("")}</ul>`
          : `<p class="dionsec-note">${i18nHtml("ui.nothing_approved_yet")}</p>`}
    </section>

    <section class="dionsec-card">
      <div class="dionsec-card-head"><h3>${i18nHtml("ui.security_events")}</h3></div>
      <p class="dionsec-note">
        ${i18nHtml("ui.recent_activity_values_headers_and_request_bodies_are_never_recorded_o")}
      </p>
      ${events.length > 0
          ? `<ul class="dionsec-events">${events.map(eventRow).join("")}</ul>`
          : `<p class="dionsec-note">${i18nHtml("ui.no_security_events_recorded_this_session")}</p>`}
    </section>

    <section class="dionsec-card">
      <div class="dionsec-card-head"><h3>${i18nHtml("ui.developer_security")}</h3></div>
      <p class="dionsec-note">
        ${i18nHtml("ui.runs_the_tamper_watchdog_once_and_reports_what_it_finds_this_check_rep")}
      </p>
      <button type="button" class="dionsec-btn" data-dion-watchdog>${i18nHtml("ui.run_tamper_check")}</button>
      <pre class="dionsec-pre" data-dion-watchdog-out hidden></pre>
    </section>

    <section class="dionsec-card is-danger">
      <div class="dionsec-card-head"><h3>${i18nHtml("ui.emergency_lockdown")}</h3></div>
      <p class="dionsec-note">
        ${i18nHtml("ui.immediately_blocks_every_plugin_network_request_for_the_rest_of_the_se")}
      </p>
      <p class="dionsec-note">
        ${i18nHtml("security.lockdown_account")}
      </p>
      <button type="button" class="dionsec-btn is-danger" data-dion-lockdown>
        ${i18nHtml("ui.engage_emergency_lockdown")}
      </button>
      ${status.safeMode
          ? `<button type="button" class="dionsec-btn" data-dion-exit-safe>${i18nHtml("ui.leave_safe_mode")}</button>`
          : ""}
    </section>
  `);

  bind();
  void status;
}

function bind(): void {
  if (container === undefined) return;

  container.querySelector("[data-dion-watchdog]")?.addEventListener("click", () => {
    const report = runWatchdog();
    const out = container?.querySelector<HTMLPreElement>("[data-dion-watchdog-out]");
    if (out !== null && out !== undefined) {
      out.hidden = false;
      // Only check names and states are printed. A watchdog that echoed the
      // values it inspected would be a new leak surface.
      out.textContent = report.results
        .map((result) => `${result.name}: ${result.state}`)
        .join("\n");
    }
  });

  container.querySelector("[data-dion-lockdown]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    // Two-step. A single click on a button labelled "Emergency" is exactly the
    // interaction a panic-inducing page would try to induce.
    if (button.dataset.dionArmed !== "1") {
      button.dataset.dionArmed = "1";
      setLocalizedText(button, "ui.click_again_to_confirm");
      setTimeout(() => {
        if (button.dataset.dionArmed === "1") {
          delete button.dataset.dionArmed;
          setLocalizedText(button, "ui.engage_emergency_lockdown");
        }
      }, 5000);
      return;
    }
    void armLockdown().then((ok) => {
      if (!ok) {
        log.error("lockdown request refused");
        setLocalizedText(button, "ui.lockdown_could_not_be_armed");
        return;
      }
      setLocalizedText(button, "ui.lockdown_engaged");
      button.disabled = true;
      log.warn("Emergency Lockdown engaged by the user");
      setTimeout(() => location.reload(), 1200);
    });
  });

  container.querySelector("[data-dion-exit-safe]")?.addEventListener("click", () => {
    void exitSafeMode().then(() => location.reload());
  });

  for (const button of container.querySelectorAll<HTMLButtonElement>("[data-dion-revoke]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.dionRevoke;
      if (key === undefined) return;
      void revokeGrant(key).then(() => refresh());
    });
  }
}

export const _internal = { esc, statusPill };
