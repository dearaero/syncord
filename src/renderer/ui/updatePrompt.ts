import { h, localizeMessage, messageHtml as i18nHtml, setLocalizedHtml, setLocalizedText, t as i18nText } from "../i18n";
/**
 * Auto-update UI (Phase 20).
 *
 * Three pieces, all mounted inside the settings panel and all removed with it:
 *
 *   1. the **Download Update** button beside the "Syncord" wordmark;
 *   2. the **Automatic updates** switch, which is on by default;
 *   3. the **restart pop-up** shown once an install has been handed off.
 *
 * The button appears only when main has already said a newer *signed* release
 * exists. It is not a comparison the renderer performs: `phase === "available"`
 * is the answer to a question main asked with a key the renderer cannot read.
 * That is the difference between an update button and a remote-code-execution
 * button, and it is why this file contains no version comparison of its own.
 */
import { createLogger } from "../api/logger";
import { settings } from "../api/settings";
import {
  AUTO_UPDATE_KEY,
  INJECTOR_PATH_KEY,
  UPDATE_CHANNEL_KEY,
  checkNow,
  handOffNow,
  restartNow,
  injectorLocation,
  onUpdate,
  resetUpdate,
  startAutoUpdate,
  pauseAutoUpdate,
  stageNow,
  updateState,
} from "../api/updater";
import { showToast, ToastType } from "./toast";

const log = createLogger("update-ui");

const MODAL_ROOT_ID = "Syncord-update-root";
const MODAL_STYLE_ID = "Syncord-update-css";

/** `true` unless the user has explicitly turned it off. */
export function autoUpdateEnabled(): boolean {
  // The fallback is the point: a fresh install, a wiped settings file and a
  // pre-feature build all land on `true`, so "default olarak da açık" is the
  // behaviour and not just the initial value of a checkbox.
  return settings.get<boolean>(AUTO_UPDATE_KEY, true) !== false;
}

export function updateChannel(): string {
  const stored = settings.get<string>(UPDATE_CHANNEL_KEY, "stable");
  return stored === "beta" ? "beta" : "stable";
}

function esc(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Markup for the wordmark button. Hidden by default; `paint` reveals it. */
export function updateButtonHtml(): string {
  return `
    <button
      type="button"
      class="dion-update-btn"
      data-dion-update
      hidden
      aria-live="polite"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 4a1 1 0 0 1 1 1v8.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4l3.3 3.3V5a1 1 0 0 1 1-1Zm-7 12a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z"/>
      </svg>
      <span data-dion-update-label>${i18nHtml("ui.download_update")}</span>
    </button>`;
}

/** The "Automatic updates" switch, shown above the plugin list. */
export function updateSettingsRowHtml(): string {
  const channel = updateChannel();
  return `
    <div class="dion-update-card">
      <label class="dion-setting-row">
        <span class="dion-setting-copy">
          <span class="dion-setting-title">${i18nHtml("ui.automatic_updates")}</span>
          <span class="dion-setting-desc">
            ${i18nHtml("ui.check_github_for_a_newer_signed_syncord_release_on_by_default_nothing_")}
          </span>
        </span>
        <span class="dion-switch">
          <input
            type="checkbox"
            role="switch"
            data-dion-update-auto
            aria-label="${h("ui.automatic_updates")}"
            ${autoUpdateEnabled() ? "checked" : ""} data-si18n-aria-label="ui.automatic_updates"
          />
          <span class="dion-track" aria-hidden="true"></span>
        </span>
      </label>

      <label class="dion-setting-row dion-update-channel">
        <span class="dion-setting-copy">
          <span class="dion-setting-title">${i18nHtml("ui.update_channel")}</span>
          <span class="dion-setting-desc">
            ${i18nHtml("ui.beta_releases_are_published_as_pre_releases_they_are_signed_exactly_li")}
          </span>
        </span>
        <!--
          The wrapper is not decoration. The select's stylesheet rule is
          "width: 100%" so that it fills the box, and as a *direct* flex child of
          the row that 100% becomes its flex basis: the copy beside it has a zero
          basis, so the description was starved down to a few pixels and wrapped
          one word per line while the select took the whole row. Same shape as the
          typing-mode select elsewhere in the panel, which is why this one was
          missed -- that one has always had the wrapper.
        -->
        <span class="dion-select-wrap">
          <select
            class="dion-select"
            data-dion-update-channel
            aria-label="${h("ui.update_channel")}" data-si18n-aria-label="ui.update_channel"
          >
            <option value="stable"${channel === "stable" ? " selected" : ""}>${i18nHtml("ui.stable")}</option>
            <option value="beta"${channel === "beta" ? " selected" : ""}>${i18nHtml("ui.beta")}</option>
          </select>
          <svg class="dion-select-chevron" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/>
          </svg>
        </span>
      </label>

      <button type="button" class="dion-primary-btn" data-dion-update-check>${i18nHtml("ui.check_for_updates")}</button>
      <p class="dion-update-status" data-dion-update-status aria-live="polite"></p>
      <p class="dion-update-injector" data-dion-update-injector></p>
    </div>`;
}

let unsubscribe: (() => void) | undefined;
let clickBound = false;

/**
 * Wire the panel's update controls and subscribe to status changes.
 *
 * Idempotent: `mount()` re-renders the panel on every open, and re-subscribing
 * on each open would leave one listener per open behind, each painting a
 * detached node.
 */
export function bindUpdateUi(scope: HTMLElement): void {
  const auto = scope.querySelector<HTMLInputElement>("[data-dion-update-auto]");
  if (auto) {
    auto.addEventListener("change", () => {
      settings.set(AUTO_UPDATE_KEY, auto.checked);
      if (auto.checked) {
        startAutoUpdate();
        void checkNow(updateChannel());
      } else {
        pauseAutoUpdate();
        // Turning it off has to clear what a previous check accepted. Without
        // this, main keeps the accepted descriptor and the Download button goes
        // on offering a release the user has just switched off checking for —
        // the switch would stop the schedule and nothing else, which is not
        // what "off" means to someone looking at it.
        void resetUpdate().then(() => paintUpdateUi(scope));
      }
      showToast(
        auto.checked ? i18nText("ui.automatic_updates_are_on") : i18nText("ui.automatic_updates_are_off"),
        { type: ToastType.MESSAGE, duration: 2200 },
      );
    });
  }

  const channelSelect = scope.querySelector<HTMLSelectElement>("[data-dion-update-channel]");
  if (channelSelect) {
    channelSelect.addEventListener("change", () => {
      const next = channelSelect.value === "beta" ? "beta" : "stable";
      settings.set(UPDATE_CHANNEL_KEY, next);
      // Re-check on the new channel straight away. Waiting up to six hours for a
      // channel change to be noticed is technically correct and practically
      // indistinguishable from broken.
      void checkNow(next).then(() => paintUpdateUi(scope));
    });
    // The channel is meaningless while the switch is off, and a control that
    // looks live but does nothing is worse than one that is visibly inactive.
    channelSelect.disabled = !autoUpdateEnabled();
  }

  scope.querySelector<HTMLButtonElement>("[data-dion-update-check]")?.addEventListener("click", () => {
    void checkNow(updateChannel());
  });

  const button = scope.querySelector<HTMLButtonElement>("[data-dion-update]");
  if (button && !clickBound) {
    clickBound = true;
    button.addEventListener("click", () => {
      void runUpdate();
    });
  }

  unsubscribe?.();
  unsubscribe = onUpdate(() => {
    paintUpdateUi(scope);
  });

  paintUpdateUi(scope);
  void paintInjectorStatus(scope);
}

/**
 * Say where the installer is, before the user discovers it by pressing a button.
 *
 * A user with no Syncord Installer and an available update would otherwise get
 * "The Syncord Installer was not found" only after downloading a bundle, which
 * reads as a failure at the worst possible moment.
 */
async function paintInjectorStatus(scope: HTMLElement): Promise<void> {
  const node = scope.querySelector<HTMLElement>("[data-dion-update-injector]");
  if (node === null) return;

  const { found } = await injectorLocation();
  // `textContent`, never `innerHTML`: this is a filesystem path.
  node.textContent =
    found === null
      ? i18nText("ui.one_click_install_needs_the_syncord_installer_download_it_from_the_syn")
      : i18nText("ui.installer_found_at_value", {v0: found});
}

/** Repaint the button and the status line from the current state. */
export function paintUpdateUi(scope: HTMLElement): void {
  const state = updateState();
  const check = scope.querySelector<HTMLButtonElement>("[data-dion-update-check]");
  if (check) check.disabled = ["checking", "downloading", "ready", "handing-off", "handed-off", "awaiting-restart"].includes(state.phase);

  const button = scope.querySelector<HTMLButtonElement>("[data-dion-update]");
  if (button) {
    const label = button.querySelector<HTMLElement>("[data-dion-update-label]");
    // Only `available` and `ready` are actionable. `handing-off` is shown but
    // disabled: main is running the installer and will not start a second one,
    // so a button that looks pressable there would either do nothing or queue.
    const actionable = state.phase === "available" || state.phase === "ready" || state.phase === "awaiting-restart";
    const working =
      state.phase === "downloading" || state.phase === "checking" || state.phase === "handing-off";
    button.hidden = !actionable && !working;
    button.disabled = !actionable;

    if (label) {
      if (state.phase === "awaiting-restart") {
        setLocalizedText(label, "ui.restart_and_install");
      } else if (state.phase === "downloading") {
        const percent = Math.round((state.progress ?? 0) * 100);
        setLocalizedText(label, "ui.downloading_value", {v0: percent});
      } else if (state.phase === "ready") {
        setLocalizedText(label, "ui.install_update");
      } else if (state.phase === "handing-off") {
        setLocalizedText(label, "ui.installing");
      } else if (state.phase === "checking") {
        setLocalizedText(label, "ui.checking");
      } else {
        setLocalizedText(label, "ui.download_update");
      }
    }
    button.setAttribute(
      "aria-label",
      state.phase === "awaiting-restart" ? i18nText("ui.restart_discord_and_install_update") : state.latest ? i18nText("ui.download_syncord_value", {v0: state.latest}) : i18nText("ui.download_update_4f494b2"),
    );
  }

  const status = scope.querySelector<HTMLElement>("[data-dion-update-status]");
  if (status) {
    // `textContent`, never `innerHTML`. `detail` is main's own string, but
    // treating it as markup would make this a DOM-injection sink for a
    // regression anywhere upstream.
    status.textContent = localizeMessage(state.detail);
  }
}

/** Download, verify and prepare; installation occurs after an explicit restart. */
async function runUpdate(): Promise<void> {
  let state = updateState();
  if (state.phase === "awaiting-restart") {
    showRestartPrompt(state.stagedVersion ?? state.latest ?? i18nText("ui.the_new_version"), true);
    return;
  }

  if (state.phase === "available") {
    state = await stageNow();
  }

  if (state.phase !== "ready") {
    if (state.phase === "error") {
      showToast(localizeMessage(state.detail), { type: ToastType.FAILURE, duration: 5000 });
    }
    return;
  }

  // `settings.get` returns `T | undefined` even with a fallback, because a
  // stored value of the wrong type is possible. An empty value is the common
  // case now that main discovers the installer itself, and main turns "nothing
  // found" into a specific, actionable message.
  const injector = settings.get<string>(INJECTOR_PATH_KEY, "") ?? "";
  state = await handOffNow(injector);

  if (state.phase === "awaiting-restart") {
    showRestartPrompt(state.stagedVersion ?? state.latest ?? i18nText("ui.the_new_version"), true);
    return;
  }
  if (state.phase === "handed-off") {
    // Only reached when the installer exited 0. Every field can be null in
    // principle; the phase is only reached with a staged version, so the
    // fallback is a belt-and-braces default that never renders as "null".
    showRestartPrompt(state.stagedVersion ?? state.latest ?? i18nText("ui.the_new_version"));
    return;
  }

  // The install did not happen. `detail` carries main's own reason — including
  // what the installer printed — so this is specific rather than "something went
  // wrong". Nothing claims an update was installed, and the staged bundle is
  // left on disk so a retry does not re-download it.
  showToast(localizeMessage(state.detail), { type: ToastType.FAILURE, duration: 7000 });
}

// ── Restart pop-up ───────────────────────────────────────────────────────────

/**
 * Ask the user to restart Discord.
 *
 * ── What the copy is allowed to claim ─────────────────────────────────────────
 *
 * This pop-up is only ever shown after `handOffNow` resolved in the
 * `handed-off` phase, which means the installer process exited `0` — so "the
 * installer applied it" is a thing that happened, not a prediction. The first
 * version of this flow spawned the installer detached with its output discarded
 * and showed this same pop-up immediately, which meant it cheerfully told users
 * the update was installed when the installer had refused it, or never started.
 * The claim is only as good as the wait behind it.
 *
 * ── Why it does not restart anything ─────────────────────────────────────────
 *
 * Restarting the client from inside the client is `app.quit()` on a process
 * that has just replaced its own files, and the honest, recoverable action is
 * the one the user already knows: quit Discord and open it again.
 *
 * The primary button therefore **reloads the window**, not the app. That is
 * materially different from what is needed and pretending otherwise would be the
 * same class of lie: on Windows and Linux, Electron's single-process model means
 * the main process *is* the Discord process, so `location.reload()` re-runs the
 * preload and re-verifies integrity — and then loads the new bundles from a
 * main process that is still running the old one. The result is a client whose
 * preload and main disagree, and an integrity check that may report `MODIFIED`
 * for a build that is actually correct.
 *
 * So the copy names the action that is actually needed, and the button offers
 * the one that is actually safe, with the difference stated rather than implied.
 */
export function showRestartPrompt(version: string, pending = false): void {
  document.getElementById(MODAL_ROOT_ID)?.remove();

  const root = document.createElement("div");
  root.id = MODAL_ROOT_ID;
  root.className = "Syncord-update-root";

  const title = pending ? i18nText("ui.syncord_value_is_ready_to_install", {v0: esc(version)}) : i18nText("ui.syncord_value_is_installed", {v0: esc(version)});

  setLocalizedHtml(root, `
    <div class="Syncord-update-backdrop" data-dion-update-close></div>
    <div class="Syncord-update-dialog" role="dialog" aria-modal="true" aria-labelledby="Syncord-update-title">
      <h2 id="Syncord-update-title">${title}</h2>
      <p>
        ${pending ? i18nHtml("ui.the_update_was_downloaded_and_verified_the_injector_will_install_it_af") : i18nHtml("ui.the_update_was_downloaded_its_signature_and_checksum_were_verified_and")}
      </p>
      <p class="Syncord-update-emphasis">
        ${pending ? i18nHtml("ui.press_restart_and_install_to_finish_the_update") : i18nHtml("ui.quit_discord_completely_and_open_it_again_to_load_the_new_version")}
      </p>
      <p class="Syncord-update-note">
        ${i18nHtml("ui.reloading_the_window_will_not_do_it_the_main_process_is_still_running_")}
      </p>
      <div class="Syncord-update-actions">
        <button type="button" class="is-primary" data-dion-update-restart>
          ${pending ? i18nHtml("ui.restart_and_install") : "I&#39;ll quit and reopen Discord"}
        </button>
        <button type="button" data-dion-update-close>${i18nHtml("ui.later")}</button>
      </div>
    </div>`);

  installModalStyles();
  document.body.appendChild(root);

  const close = (): void => {
    root.remove();
    document.removeEventListener("keydown", onKey);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  for (const element of root.querySelectorAll("[data-dion-update-close]")) {
    element.addEventListener("click", close);
  }
  root.querySelector("[data-dion-update-restart]")?.addEventListener("click", async () => {
    if (pending) {
      const button = root.querySelector<HTMLButtonElement>("[data-dion-update-restart]");
      if (button) button.disabled = true;
      try {
        if (await restartNow()) { close(); return; }
        showToast(i18nText("ui.the_update_worker_is_no_longer_ready_try_installing_the_update_again"), { type: ToastType.FAILURE });
      } catch { showToast(i18nText("ui.discord_could_not_be_closed_for_this_update_try_again"), { type: ToastType.FAILURE }); }
      if (button) button.disabled = false;
      return;
    }
    close();
    // The button is an acknowledgement, not an action. It used to call
    // `location.reload()`, which is exactly the thing the copy above now warns
    // against: a reload re-runs the preload against the new bundles while the
    // main process is still the old one, which can leave the two disagreeing and
    // the integrity check reporting a build that is in fact correct as
    // MODIFIED. A dialog that names the right action and then performs the
    // wrong one is worse than a dialog with no button.
    //
    // So it closes, and the user does the thing the dialog told them to do.
    log.info(`update ${version} installed; user acknowledged the restart step`);
  });

  document.addEventListener("keydown", onKey);
  log.info(`update ${version} handed off; restart prompt shown`);
}

function installModalStyles(): void {
  if (document.getElementById(MODAL_STYLE_ID) !== null) return;

  const style = document.createElement("style");
  style.id = MODAL_STYLE_ID;
  style.textContent = `
    .Syncord-update-root {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      z-index: 10002;
    }

    .Syncord-update-backdrop {
      position: absolute;
      inset: 0;
      background: var(--modal-backdrop, rgba(0, 0, 0, 0.72));
      backdrop-filter: blur(2px);
    }

    .Syncord-update-dialog {
      position: relative;
      width: min(420px, calc(100vw - 48px));
      padding: 24px;

      border: 1px solid var(--modal-border, var(--background-modals-inverted, transparent));
      border-radius: 12px;

      background: var(--background-modals, var(--background-primary, #313338));
      color: var(--text-normal, #dbdee1);
      box-shadow: var(--elevation-stroke, 0 8px 24px rgba(0, 0, 0, 0.4));
    }

    .Syncord-update-dialog h2 {
      margin: 0 0 12px;
      font-size: 20px;
      font-weight: 650;
      color: var(--header-primary, #f2f3f5);
    }

    .Syncord-update-dialog p {
      margin: 0 0 10px;
      font-size: 14px;
      line-height: 1.45;
    }

    .Syncord-update-emphasis {
      font-weight: 600;
      color: var(--text-normal, #dbdee1);
    }

    .Syncord-update-note {
      font-size: 13px;
      color: var(--text-muted, #949ba4);
    }

    .Syncord-update-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 18px;
    }

    .Syncord-update-actions button {
      padding: 10px 16px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      color: var(--text-normal, #dbdee1);
      background: var(--background-secondary, #2b2d31);
    }

    .Syncord-update-actions button.is-primary {
      color: #fff;
      background: var(--brand-experiment, #5865f2);
    }

    .Syncord-update-actions button:hover {
      filter: brightness(1.08);
    }
  `;
  document.head.appendChild(style);
}

/** Remove every node and listener this module installed. */
export function disposeUpdateUi(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  clickBound = false;
  document.getElementById(MODAL_ROOT_ID)?.remove();
  document.getElementById(MODAL_STYLE_ID)?.remove();
}
