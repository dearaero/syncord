//! The Injector's application state, and the Tauri commands over it.
//!
//! ── The one rule that shapes this file ──────────────────────────────────────
//!
//! **The frontend never supplies a path.**
//!
//! A `#[tauri::command]` here takes an `index` into a list that Rust discovered
//! at startup, never a filesystem path. That is what keeps
//! `src-tauri/capabilities/default.json` limited to core events and titlebar controls: with
//! no `fs` or `shell` plugin the frontend has no way to reach a path even if it
//! is fully compromised, and with the index indirection it has no path to name
//! in the first place.
//!
//! Every filesystem call still goes through `syncord-core`, which re-derives the
//! path from the filesystem and re-validates it. So there are three independent
//! things between a compromised frontend and a write: no plugin, no path
//! argument, and a core that re-checks what it was given.

use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use syncord_core::release::{compare_versions, VerifiedRelease};

use syncord_core::access::{pane_for, pane_url, probe, remedy, SettingsPane, WriteAccess};
use syncord_core::discovery::{find_installs, DiscoveryEnv, DiscoveryError, Install, Platform};
use syncord_core::inject::{inject, uninject, update, InjectOutcome};
use syncord_core::verify::{Verifier, VerifyError};

/// Everything the GUI needs to draw one row of the install list.
///
/// A plain serialisable struct rather than `Install` itself: `Install` carries
/// absolute paths, and the frontend does not need one and must not be handed
/// one. What it needs is the branch, a path it can *display*, and the state.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRow {
    /// Index into the state, and the only thing the frontend sends back.
    pub index: usize,
    /// `"stable"`, `"canary"`, `"ptb"`, `"development"` or `"custom"`.
    pub branch: String,
    /// A human label, e.g. `Discord Canary`.
    pub label: String,
    /// Shown in the UI. The real path is `resources`, which is what an error
    /// message from `inject` will also refer to.
    pub path: String,
    /// Whether Syncord is present in this install.
    pub injected: bool,
    /// Whether Electron will reach the installed loader when this install starts.
    /// This is an on-disk check, not proof of a running Syncord renderer.
    pub launch_ready: bool,
    /// The installed version, when the install can state one.
    pub version: Option<String>,
    /// Short digest of the signed manifest, so a re-scan shows whether anything
    /// changed underneath.
    pub fingerprint: Option<String>,
    /// Whether the installed bundles still match their signed manifest.
    ///
    /// This is the difference between "Syncord is installed" and "Syncord is
    /// installed and intact". A user whose install was modified outside Syncord
    /// needs to know, because the only fix is to re-install.
    pub verified: bool,
    /// Whether this process can write to this install, measured.
    ///
    /// Carried on every row rather than only on a failure because the point is
    /// to tell the user *before* they press the button. On macOS the usual cause
    /// of a refused write is App Management, which is a setting the user has to
    /// find and change; finding out by way of an error dialog after a failed
    /// inject is the version of this that wastes their time.
    ///
    /// A name, not an enum, because it crosses into JavaScript: see
    /// [`WriteAccess::as_str`].
    pub access: String,
    /// What to do about it, when there is something to do. `None` when the
    /// directory is writable and there is nothing to say.
    pub access_hint: Option<String>,
}

/// The result of an action, as the frontend receives it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    /// Safe to render. Never contains a stack trace.
    pub message: String,
    /// Extra guidance for a refusal, e.g. the permission help.
    pub help: Option<String>,
    /// A settings screen that would resolve this, when one does.
    ///
    /// The *name* of a screen, never a URL. The frontend cannot ask to open an
    /// arbitrary address, so a compromised frontend cannot turn this window into
    /// a link opener — which is the entire reason the shell plugin is not
    /// granted.
    pub pane: Option<String>,
}

/// Process-wide state.
///
/// Tauri manages an Arc so blocking network and installation work can run off
/// the UI thread. The operation guard prevents competing writes in this process.
pub struct AppState {
    /// Discovered at startup. The frontend only ever indexes into this.
    installs: Mutex<Vec<Install>>,
    /// Measured write access, one per entry in `installs`.
    ///
    /// Probing means creating and deleting a file in the install's directory, so
    /// it is done once per install rather than on every render. The cache is
    /// refreshed by `check_write_access`, which is what the "check again"
    /// button calls after the user has changed a setting — without which the
    /// window would keep reporting a stale refusal long after it was fixed, and
    /// the user would conclude the setting did not work.
    access: Mutex<Vec<WriteAccess>>,
    /// The payload that ships beside the executable, once verified.
    payload: Mutex<Option<VerifiedPayload>>,
    /// The one verifier this process will ever use.
    ///
    /// Held here rather than re-derived per command so that "which key does
    /// this process trust" is a single value set once at startup. A command
    /// cannot accidentally consult a different one, and a build with no usable
    /// key fails in one place with one message instead of per action.
    verifier: Option<Verifier>,
    operation: Mutex<()>,
    release: Mutex<Option<VerifiedRelease>>,
    release_error: Mutex<Option<String>>,
    // Keep the verified temporary files alive for every command and remove on exit.
    _embedded_payload: Option<crate::release_client::PreparedPayload>,
}

/// A payload directory that has passed signature and digest verification.
///
/// Held as a struct with a private field so it cannot be constructed outside
/// this file — which means the only way to get one is
/// [`AppState::load_payload`], i.e. the only way is through verification.
pub struct VerifiedPayload {
    dir: PathBuf,
    version: String,
}

impl std::fmt::Debug for VerifiedPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately does not print the path: a log line that ends up in a
        // crash report should not carry a user's home directory.
        f.debug_struct("VerifiedPayload")
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

impl AppState {
    /// Discover the installs and load the bundled payload from the real machine.
    pub fn new() -> Self {
        let verifier = Verifier::embedded().ok();
        let embedded = crate::embedded_payload::load(verifier.as_ref());
        let (embedded, error) = match embedded {
            Ok(payload) => (payload, None),
            Err(err) => (None, Some(err)),
        };
        // An invalid embedded archive must not fall back to a neighboring file.
        let dir = if error.is_some() {
            None
        } else {
            embedded
                .as_ref()
                .map(|p| p.0.clone())
                .or_else(syncord_core::inject::bundled_payload_dir)
        };
        let mut state = Self::discover(&DiscoveryEnv::from_system(), dir, verifier);
        state._embedded_payload = embedded;
        if let Some(err) = error {
            eprintln!("[Syncord] {err}");
            if let Ok(mut slot) = state.release_error.lock() {
                *slot = Some(err);
            }
        }
        state
    }

    /// The same thing, with the environment and payload location supplied.
    ///
    /// A parameter rather than read from the process, so the tests can drive the
    /// *real* commands against a *synthetic* Discord install. That is the point:
    /// the code under test is the code that ships, not a copy of it with the
    /// filesystem swapped out.
    pub fn discover(
        env: &DiscoveryEnv,
        payload_dir: Option<PathBuf>,
        verifier: Option<Verifier>,
    ) -> Self {
        let installs = match find_installs(env) {
            Ok(found) => found,
            Err(DiscoveryError::NotFound(_)) => Vec::new(),
            // A discovery error is not fatal: the GUI can still show the user
            // why the list is empty, which is more useful than refusing to open.
            Err(err) => {
                eprintln!("[Syncord] discovery failed: {err}");
                Vec::new()
            }
        };

        let state = Self {
            access: Mutex::new(Vec::new()),
            installs: Mutex::new(installs),
            payload: Mutex::new(None),
            verifier,
            operation: Mutex::new(()),
            release: Mutex::new(None),
            release_error: Mutex::new(None),
            _embedded_payload: None,
        };
        state.measure_access();
        state.load_payload(payload_dir);
        state
    }

    /// Measure write access for every discovered install.
    ///
    /// The platform comes from the running process rather than from the
    /// discovery environment, because it is this process's own rights that are
    /// in question. A test that pointed discovery at a synthetic install is
    /// still being told what a real run would see.
    fn measure_access(&self) {
        let platform = Platform::current();
        let measured: Vec<WriteAccess> = self
            .installs
            .lock()
            .map(|installs| {
                installs
                    .iter()
                    .map(|install| probe(&install.resources, platform))
                    .collect()
            })
            .unwrap_or_default();
        if let Ok(mut slot) = self.access.lock() {
            *slot = measured;
        }
    }

    /// The measured access for an install, re-probing only if the cache is
    /// short.
    ///
    /// A short cache means the install list changed without a re-measure, which
    /// is the one case where a stale answer would be wrong rather than merely
    /// old — so it re-probes instead of guessing.
    fn access_at(&self, index: usize) -> WriteAccess {
        if let Ok(slot) = self.access.lock() {
            if let Some(found) = slot.get(index) {
                return *found;
            }
        }
        self.measure_access();
        self.access
            .lock()
            .ok()
            .and_then(|slot| slot.get(index).copied())
            .unwrap_or(WriteAccess::Unknown)
    }

    /// Locate and verify the payload that ships beside the executable.
    ///
    /// Called once at startup so a user pressing Inject does not wait on a
    /// signature check, and — more importantly — so the "no payload available"
    /// state is visible in the UI before they press anything.
    fn load_payload(&self, dir: Option<PathBuf>) {
        let Some(dir) = dir else {
            return;
        };
        if !dir.is_dir() {
            return;
        }

        let Some(verifier) = self.verifier.as_ref() else {
            // A build with no release key verifies nothing. Not an error worth
            // logging loudly at startup — it is the expected state of a local
            // `cargo build` — but it does mean the Inject button stays disabled.
            return;
        };
        if let Err(err) = verifier.verify_install(&dir) {
            eprintln!("[Syncord] bundled payload rejected: {err}");
            return;
        }
        let Some(version) = syncord_core::verify::read_version_stamp(&dir) else {
            return;
        };
        if let Ok(mut slot) = self.payload.lock() {
            *slot = Some(VerifiedPayload { dir, version });
        }
    }

    /// The verified payload, if one is available.
    fn payload(&self) -> Option<VerifiedPayload> {
        self.payload
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(VerifiedPayload::dup))
    }

    fn rows(&self) -> Vec<InstallRow> {
        let Ok(installs) = self.installs.lock() else {
            return Vec::new();
        };
        let verifier = self.verifier.as_ref();
        let platform = Platform::current();

        installs
            .iter()
            .enumerate()
            .map(|(index, install)| {
                let app_dir = install.app_dir();
                // "Verified" means the bundles on disk match a signed manifest,
                // which is a stronger claim than "the directory exists".
                let verified = verifier.is_some_and(|v| v.verify_install(&app_dir).is_ok());
                let access = self.access_at(index);

                InstallRow {
                    index,
                    branch: install.branch.to_string(),
                    label: label_for(install),
                    path: install.resources.display().to_string(),
                    injected: app_dir.is_dir(),
                    launch_ready: syncord_core::inject::launch_ready(&install.resources),
                    version: syncord_core::inject::installed_version(&install.resources),
                    fingerprint: syncord_core::inject::installed_fingerprint(&install.resources),
                    verified,
                    access: access.as_str().to_string(),
                    // Nothing to say when the write works. Saying "you can write
                    // to this" on every row would be noise the user has to read
                    // past to find the one row that is actually blocked.
                    access_hint: if access.is_blocked() {
                        Some(remedy(access, platform))
                    } else {
                        None
                    },
                }
            })
            .collect()
    }

    fn install_at(&self, index: usize) -> Result<Install, ActionResult> {
        let installs = self
            .installs
            .lock()
            .map_err(|_| ActionResult::fail("The Injector is busy. Try again."))?;
        installs
            .get(index)
            .cloned()
            .ok_or_else(|| ActionResult::fail("That Discord is no longer in the list."))
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl VerifiedPayload {
    fn dup(&self) -> VerifiedPayload {
        VerifiedPayload {
            dir: self.dir.clone(),
            version: self.version.clone(),
        }
    }
}

impl ActionResult {
    fn fail(message: &str) -> Self {
        Self {
            ok: false,
            message: message.to_string(),
            help: None,
            pane: None,
        }
    }

    fn fail_with(message: String, help: String) -> Self {
        Self {
            ok: false,
            message,
            help: Some(help),
            pane: None,
        }
    }

    /// A refusal whose remedy is a settings screen.
    ///
    /// Carries all three: what happened, what to do, and where to do it. The
    /// third is what turns an error the user can only read into one they can act
    /// on, and it is the reason this type has a `pane` at all.
    fn fail_with_pane(message: String, help: String, access: WriteAccess) -> Self {
        Self {
            ok: false,
            message,
            help: Some(help),
            pane: pane_for(access).map(|pane| pane_name(pane).to_string()),
        }
    }

    fn done(message: &str) -> Self {
        Self {
            ok: true,
            message: message.to_string(),
            help: None,
            pane: None,
        }
    }
}

/// The frontend's name for a settings pane.
///
/// One place where a [`SettingsPane`] becomes a string, so the spellings on the
/// two sides of the IPC boundary cannot drift apart by accident.
fn pane_name(pane: SettingsPane) -> &'static str {
    match pane {
        SettingsPane::Privacy => "privacy",
        SettingsPane::AppManagement => "appManagement",
    }
}

fn label_for(install: &Install) -> String {
    match install.branch {
        syncord_core::discovery::Branch::Custom => "Discord (pinned)",
        syncord_core::discovery::Branch::Stable => "Discord",
        syncord_core::discovery::Branch::Canary => "Discord Canary",
        syncord_core::discovery::Branch::Ptb => "Discord PTB",
        syncord_core::discovery::Branch::Development => "Discord Development",
    }
    .to_string()
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// The install list, plus whether a payload is available to install from.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    pub installs: Vec<InstallRow>,
    /// The version of the payload that would be installed, if any.
    pub payload_version: Option<String>,
    /// Why there is no payload, when there is not one.
    pub payload_unavailable: Option<String>,
    pub injector_version: String,
    pub release_version: Option<String>,
    pub release_error: Option<String>,
}

/// Read the initial state. Called once when the window opens.
#[tauri::command]
pub fn startup(state: tauri::State<'_, Arc<AppState>>) -> Startup {
    startup_inner(&state)
}

/// The body of [`startup`], without the `tauri::State` wrapper.
///
/// The split exists so the integration tests can drive the *same* code the
/// window calls. A second copy of this logic for tests would be a second thing
/// to keep correct.
pub(crate) fn startup_inner(state: &AppState) -> Startup {
    let payload = state.payload();
    let (payload_version, payload_unavailable) = match &payload {
        Some(found) => (Some(found.version.clone()), None),
        None => (
            None,
            Some(
                "This build has no payload beside it, so it cannot install. \
                 Download a release archive, which contains both the Injector \
                 and the bundles."
                    .to_string(),
            ),
        ),
    };

    Startup {
        installs: state.rows(),
        payload_version,
        payload_unavailable,
        injector_version: syncord_core::INJECTOR_VERSION.to_string(),
        release_version: state
            .release
            .lock()
            .ok()
            .and_then(|v| v.as_ref().map(|r| r.version.clone())),
        release_error: state.release_error.lock().ok().and_then(|v| v.clone()),
    }
}

/// Re-run discovery, for a "rescan" button.
#[tauri::command]
pub fn rescan(state: tauri::State<'_, Arc<AppState>>) -> Startup {
    rescan_inner(&state, &DiscoveryEnv::from_system())
}

pub(crate) fn rescan_inner(state: &AppState, env: &DiscoveryEnv) -> Startup {
    if let Ok(found) = find_installs(env) {
        if let Ok(mut installs) = state.installs.lock() {
            *installs = found;
        }
        // The install list is new, so the measurements taken against the old one
        // describe directories that may not be in it any more.
        state.measure_access();
    }
    startup_inner(state)
}

/// Re-measure write access without re-running discovery.
///
/// The "check again" button. Separate from [`rescan`] because the two answer
/// different questions: a permission the user just granted changes nothing about
/// which installs exist, and re-running discovery to find that out would also
/// reset the list under them for no reason.
#[tauri::command]
pub fn check_write_access(state: tauri::State<'_, Arc<AppState>>) -> Startup {
    check_write_access_inner(&state)
}

pub(crate) fn check_write_access_inner(state: &AppState) -> Startup {
    state.measure_access();
    startup_inner(state)
}

/// A settings pane the window is allowed to ask for.
///
/// An enum, not a URL. The frontend can name a pane and nothing else, so it
/// cannot use this window to open an arbitrary address — which is what makes it
/// safe to spawn `open` here while `capabilities/default.json` stays at
/// `core:default` with no shell plugin.
///
/// The deserialiser only accepts the names below; anything else fails to
/// deserialise and the command never runs.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsPaneArg {
    Privacy,
    AppManagement,
}

impl From<SettingsPaneArg> for SettingsPane {
    fn from(arg: SettingsPaneArg) -> SettingsPane {
        match arg {
            SettingsPaneArg::Privacy => SettingsPane::Privacy,
            SettingsPaneArg::AppManagement => SettingsPane::AppManagement,
        }
    }
}

/// Open the system settings screen that would resolve a refusal.
///
/// The URL is built here from an enum, never received. That is the whole design:
/// the frontend's only capability is to ask for a named screen, so the worst a
/// compromised frontend can do is open a settings window the user then closes.
#[tauri::command]
pub fn open_settings(pane: SettingsPaneArg) -> ActionResult {
    let Some(url) = pane_url(pane.into(), Platform::current()) else {
        return ActionResult::fail(
            "This system has no settings screen for that. The steps are shown here instead.",
        );
    };
    match std::process::Command::new("open").arg(&url).status() {
        Ok(status) if status.success() => ActionResult::done("Opened System Settings."),
        Ok(status) => ActionResult::fail(&format!(
            "The system declined to open System Settings (status {status}). Open it by \
             hand: System Settings, then Privacy & Security."
        )),
        Err(err) => ActionResult::fail(&format!(
            "Could not open System Settings: {err}. Open it by hand: System Settings, \
             then Privacy & Security."
        )),
    }
}

/// Install Syncord into the install at `index`.
///
/// `index`, not a path. See the module header.
#[tauri::command]
pub async fn inject_into(
    state: tauri::State<'_, Arc<AppState>>,
    index: usize,
) -> Result<ActionResult, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || inject_latest_into_inner(&state, index))
        .await
        .map_err(|_| "The update worker stopped unexpectedly. Try again.".to_string())
}

/// Verify release metadata on a worker thread; the UI has no network capability.
#[tauri::command]
pub async fn check_updates(state: tauri::State<'_, Arc<AppState>>) -> Result<Startup, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(_guard) = state.operation.try_lock() else {
            return startup_inner(&state);
        };
        let _ = fetch_release(&state);
        startup_inner(&state)
    })
    .await
    .map_err(|_| "The update check stopped unexpectedly.".to_string())
}

fn fetch_release(state: &AppState) -> Result<VerifiedRelease, String> {
    let verifier = state
        .verifier
        .as_ref()
        .ok_or("This Injector has no release verification key.")?;
    let result = crate::release_client::latest(verifier);
    if let Ok(mut error) = state.release_error.lock() {
        *error = result.as_ref().err().cloned();
    }
    if let Ok(mut slot) = state.release.lock() {
        *slot = result.as_ref().ok().cloned();
    }
    result
}

pub(crate) fn inject_latest_into_inner(state: &AppState, index: usize) -> ActionResult {
    let Ok(_guard) = state.operation.try_lock() else {
        return ActionResult::fail("Another install is in progress. Wait for it to finish.");
    };
    let install = match state.install_at(index) {
        Ok(value) => value,
        Err(error) => return error,
    };
    if crate::running_for(&install.root).is_some() {
        return ActionResult::fail(
            "Quit this Discord completely, including its tray icon, then press Update again.",
        );
    }
    let Some(verifier) = state.verifier.as_ref() else {
        return ActionResult::fail("This Injector has no release verification key.");
    };
    let release = match fetch_release(state) {
        Ok(value) => value,
        Err(error) => return ActionResult::fail(&error),
    };
    install_release_inner(state, index, &release, verifier, || {
        crate::release_client::download(&release, verifier)
    })
}

pub(crate) fn install_release_inner(
    state: &AppState,
    index: usize,
    release: &VerifiedRelease,
    verifier: &Verifier,
    download: impl FnOnce() -> Result<crate::release_client::PreparedPayload, String>,
) -> ActionResult {
    let install = match state.install_at(index) {
        Ok(value) => value,
        Err(error) => return error,
    };
    let bundled = state.payload();
    let version = bundled
        .as_ref()
        .filter(|p| compare_versions(&p.version, &release.version) == Ordering::Greater)
        .map_or(release.version.as_str(), |p| p.version.as_str());
    if let Some(installed) = syncord_core::inject::installed_version(&install.resources) {
        match compare_versions(version, &installed) {
            Ordering::Less => return ActionResult::fail(
                "The available payload is older than the installed client. Downgrades are refused.",
            ),
            Ordering::Equal
                if syncord_core::inject::launch_ready(&install.resources)
                    && verifier.verify_install(&install.app_dir()).is_ok() =>
            {
                return ActionResult::done(&format!("Syncord {installed} is already up to date."))
            }
            _ => {}
        }
    }
    // A newer signed bundled payload is the one-time bootstrap for this Injector.
    // All later releases are fetched without rebuilding or replacing the binary.
    if let Some(payload) =
        bundled.filter(|p| compare_versions(&p.version, &release.version) == Ordering::Greater)
    {
        return apply_payload(state, index, &payload.dir, &payload.version, verifier);
    }
    let payload = match download() {
        Ok(value) => value,
        Err(error) => return ActionResult::fail(&error),
    };
    apply_payload(state, index, &payload.0, &release.version, verifier)
}

fn apply_payload(
    state: &AppState,
    index: usize,
    dir: &std::path::Path,
    version: &str,
    verifier: &Verifier,
) -> ActionResult {
    let install = match state.install_at(index) {
        Ok(value) => value,
        Err(error) => return error,
    };
    if crate::running_for(&install.root).is_some() {
        return ActionResult::fail(
            "Discord started while the update was downloading. Quit it and try again.",
        );
    }
    let _install_lock = match crate::update_job::lock_install(&install.resources) {
        Ok(lock) => lock,
        Err(message) => return ActionResult::fail(&message),
    };
    if syncord_core::inject::installed_version(&install.resources)
        .is_some_and(|current| compare_versions(version, &current) == Ordering::Less)
    {
        return ActionResult::fail(
            "A newer client was installed while this update was preparing. Downgrades are refused.",
        );
    }
    let outcome = if syncord_core::inject::launch_ready(&install.resources)
        && verifier.verify_install(&install.app_dir()).is_ok()
    {
        update(&install, dir, verifier)
    } else {
        inject(&install, dir, verifier)
    };
    let result = finish(
        outcome,
        &format!("Syncord {version}"),
        state.access_at(index),
    );
    if result.ok
        && (verifier.verify_install(&install.app_dir()).is_err()
            || syncord_core::inject::installed_version(&install.resources).as_deref()
                != Some(version))
    {
        return ActionResult::fail("The install did not verify as the requested version. Reopen the Injector to repair it.");
    }
    result
}

/// Explicit offline install/repair. It never silently downgrades a newer client.
#[tauri::command]
pub fn install_bundled(state: tauri::State<'_, Arc<AppState>>, index: usize) -> ActionResult {
    let Ok(_guard) = state.operation.try_lock() else {
        return ActionResult::fail("Another install is in progress.");
    };
    inject_into_inner(&state, index)
}

pub(crate) fn inject_into_inner(state: &AppState, index: usize) -> ActionResult {
    let install = match state.install_at(index) {
        Ok(install) => install,
        Err(result) => return result,
    };
    // The key is checked first, because it distinguishes two failures that
    // otherwise look identical. Without a key the payload is present but
    // unverifiable, and "no payload beside the Injector" would send a user with a
    // keyless local build looking in the wrong place entirely.
    let Some(verifier) = state.verifier.as_ref() else {
        return ActionResult::fail_with(
            "This build has no release signing key, so nothing can be verified.".to_string(),
            "Download a release build of the Injector. A locally built copy has no \
             key compiled in and deliberately refuses to install anything."
                .to_string(),
        );
    };
    let Some(payload) = state.payload() else {
        return ActionResult::fail(
            "There is no verified payload beside the Injector, so nothing can be installed.",
        );
    };

    if syncord_core::inject::installed_version(&install.resources)
        .is_some_and(|current| compare_versions(&payload.version, &current) == Ordering::Less)
    {
        return ActionResult::fail(
            "The bundled payload is older than the installed client. Downgrades are refused.",
        );
    }

    if crate::running_for(&install.root).is_some() {
        return ActionResult::fail(
            "This Discord is still running. Quit it completely, including its tray icon, then try again.",
        );
    }

    // Only a verified, reachable loader can use the in-place update path.
    // Restored Discord startup files or incomplete bundles need a full repair.
    let _install_lock = match crate::update_job::lock_install(&install.resources) {
        Ok(lock) => lock,
        Err(message) => return ActionResult::fail(&message),
    };
    if syncord_core::inject::installed_version(&install.resources)
        .is_some_and(|current| compare_versions(&payload.version, &current) == Ordering::Less)
    {
        return ActionResult::fail(
            "A newer client was installed while this update was preparing. Downgrades are refused.",
        );
    }
    let outcome = if syncord_core::inject::launch_ready(&install.resources)
        && verifier.verify_install(&install.app_dir()).is_ok()
    {
        update(&install, &payload.dir, verifier)
    } else {
        inject(&install, &payload.dir, verifier)
    };

    finish(outcome, "Syncord", state.access_at(index))
}

/// Remove Syncord from the install at `index` and restore Discord's own asar.
#[tauri::command]
pub fn uninject_from(state: tauri::State<'_, Arc<AppState>>, index: usize) -> ActionResult {
    let Ok(_guard) = state.operation.try_lock() else {
        return ActionResult::fail("Another install is in progress.");
    };
    uninject_from_inner(&state, index)
}

pub(crate) fn uninject_from_inner(state: &AppState, index: usize) -> ActionResult {
    let install = match state.install_at(index) {
        Ok(install) => install,
        Err(result) => return result,
    };
    if crate::running_for(&install.root).is_some() {
        return ActionResult::fail(
            "This Discord is still running. Quit it completely, including its tray icon, then try again.",
        );
    }
    let _install_lock = match crate::update_job::lock_install(&install.resources) {
        Ok(lock) => lock,
        Err(message) => return ActionResult::fail(&message),
    };
    finish(uninject(&install), "Syncord", state.access_at(index))
}

/// Turn an `InjectOutcome` into something the UI can show.
///
/// `access` is the measured write access, not the error's own guess. It is
/// passed in rather than read from `outcome` because a `PermissionDenied` from
/// the core carries a generic string that cannot know which of several very
/// different causes produced it, and the whole point of measuring is to stop
/// showing that string.
fn finish(
    outcome: Result<InjectOutcome, syncord_core::inject::InjectError>,
    what: &str,
    access: WriteAccess,
) -> ActionResult {
    match outcome {
        Ok(InjectOutcome::FreshInstall) => {
            ActionResult::done(&format!("{what} installed. Restart Discord to load it."))
        }
        Ok(InjectOutcome::Replaced) => {
            ActionResult::done(&format!("{what} updated. Restart Discord to load it."))
        }
        Ok(InjectOutcome::Updated) => {
            ActionResult::done(&format!("{what} updated. Restart Discord to load it."))
        }
        Ok(InjectOutcome::Uninstalled) => ActionResult::done(&format!(
            "{what} removed. Restart Discord to load it without it."
        )),
        Err(err) => match err {
            // The one error with a known fix, so it carries its own guidance —
            // and now the measured guidance, with a settings screen attached when
            // the fix is a setting.
            syncord_core::inject::InjectError::PermissionDenied { .. } => {
                ActionResult::fail_with_pane(
                    err.to_string(),
                    remedy(access, Platform::current()),
                    access,
                )
            }
            syncord_core::inject::InjectError::NotVerified(VerifyError::NoKeyCompiled)
            | syncord_core::inject::InjectError::NotVerified(VerifyError::KeyMalformed) => {
                ActionResult::fail_with(
                    err.to_string(),
                    "This build of the Injector has no release signing key, so it \
                     cannot install anything. Download a release build."
                        .to_string(),
                )
            }
            // Everything else: a refusal with a reason, and nothing that looks
            // like a suggestion to run something as an administrator.
            _ => ActionResult::fail(&err.to_string()),
        },
    }
}

// ── Test surface ──────────────────────────────────────────────────────────────
//
// Thin re-exports so `commands_test.rs` can drive the same functions the window
// calls, minus the `tauri::State<'_, _>` wrapper. There is no logic here: every
// one of these forwards to the function under test, so a test passing means the
// shipped code works, not that a parallel implementation of it does.
//
// `Verifier::from_base64_key` is the reason the tests can exist at all. The key
// compiled into a `cargo test` build is deliberately a placeholder that verifies
// nothing — the same state a developer's local build is in — so a test that
// needed a *working* verifier had no way to get one.

#[cfg(test)]
pub(crate) use {
    check_write_access_inner as check_write_access_for_tests,
    inject_into_inner as inject_into_for_tests, install_release_inner as install_release_for_tests,
    open_settings as open_settings_for_tests, startup_inner as startup_for_tests,
    uninject_from_inner as uninject_from_for_tests,
};

/// Whether this process has a verifier at all.
///
/// Used by the tests to assert the *negative* case: a build with no signing key
/// must refuse everything, and that is worth asserting rather than assuming.
#[cfg(test)]
pub(crate) fn has_verifier(state: &AppState) -> bool {
    state.verifier.is_some()
}
