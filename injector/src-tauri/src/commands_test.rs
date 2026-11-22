//! Integration tests for the Tauri command surface.
//!
//! These drive the **real** command bodies — the same functions the window
//! calls, reached through thin `*_for_tests` forwards that add no logic —
//! against a synthetic Discord install in a temporary directory. Nothing here
//! touches a real Discord, and nothing here is a reimplementation: if
//! `inject_into` is broken, these fail.
//!
//! What they cover that the `syncord-core` unit tests do not:
//!
//!   * the state the GUI actually shows, including the three distinguishable
//!     status states and the version read back from the install;
//!   * the sequence a user performs — Inject, then Uninject — end to end;
//!   * the refusals the UI has to render: no payload, no signing key, an
//!     out-of-range index, a tampered payload, an install that stopped being
//!     Discord.
//!
//! The webview itself is not covered here; `ui/` has its own DOM test and the
//! binary is launched for real by `scripts/tests/injector-cli.mjs`.

// The workspace denies `expect_used` and `unwrap_used`, because a panic part
// way through a write is how an installed Discord ends up half-modified. That
// reasoning is about production code: a test that panics has not touched
// anything, and stopping with a clear message beats a `Result` threaded through
// every fixture. The allow is scoped to this module so it cannot leak into the
// code that actually writes.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::{Path, PathBuf};

use syncord_core::discovery::{DiscoveryEnv, Platform};
use syncord_core::verify::{sha256_bytes, version_stamp_bytes, VERSION_FILE};

use crate::state::{AppState, InstallRow, Startup};

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// A unique temporary directory, removed on drop.
struct Temp(PathBuf);

impl Temp {
    fn new(tag: &str) -> Self {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "syncord-cmd-{tag}-{nanos}-{unique}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn join(&self, tail: &str) -> PathBuf {
        self.0.join(tail)
    }

    fn dir(&self, tail: &str) -> PathBuf {
        let path = self.join(tail);
        std::fs::create_dir_all(&path).expect("create dir");
        path
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A synthetic Discord: `<root>/Resources` containing `app.asar`.
fn fake_discord(root: &Path) -> PathBuf {
    let resources = root.join("Resources");
    std::fs::create_dir_all(&resources).expect("create resources");
    std::fs::write(resources.join("app.asar"), b"pretend this is Discord").expect("write asar");
    resources.canonicalize().expect("canonicalize")
}

// A throwaway Ed25519 key pair, duplicated from `syncord-core`'s test support
// because that module is `#[cfg(test)]` inside the library and the binary crate
// cannot reach it. It signs nothing outside this suite.
const TEST_PRIVATE: &str = "MC4CAQAwBQYDK2VwBCIEIFCmGafBqqcA1yt3dsFJc5yuhy0KUE9irGd/8wyQrT1x";
const TEST_PUBLIC: &str = "MCowBQYDK2VwAyEAlIcNZNNi+8A0KiBIM0AJPq6UCNVviv7XGFsQjEprMK4=";

#[test]
fn windows_frameless_chrome_removes_the_native_border_without_changing_capabilities() {
    let mut config: tauri::Config =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let security = serde_json::to_value(&config.app.security).unwrap();
    crate::configure_window_chrome(&mut config, true);
    let main = &config.app.windows[0];
    assert!(!main.shadow);
    assert!(!main.decorations);
    assert!(main.transparent);
    assert!(main.resizable);
    assert_eq!(
        serde_json::to_value(&config.app.security).unwrap(),
        security
    );
}

#[test]
fn chrome_correction_preserves_other_platforms_and_decorated_windows() {
    let original: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let mut config = original.clone();
    crate::configure_window_chrome(&mut config, false);
    assert_eq!(
        serde_json::to_value(&config).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    config.app.windows[0].decorations = true;
    crate::configure_window_chrome(&mut config, true);
    assert!(config.app.windows[0].shadow);
    config.app.windows[0].decorations = false;
    config.app.windows[0].label = "another-window".into();
    crate::configure_window_chrome(&mut config, true);
    assert!(config.app.windows[0].shadow);
}

fn test_verifier() -> syncord_core::verify::Verifier {
    syncord_core::verify::Verifier::from_base64_key(TEST_PUBLIC)
        .expect("the test public key must be a valid Ed25519 key")
}

fn signing_key() -> ed25519_dalek::SigningKey {
    use base64::Engine;
    let der = base64::engine::general_purpose::STANDARD
        .decode(TEST_PRIVATE)
        .expect("valid base64");
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&der[der.len() - 32..]);
    ed25519_dalek::SigningKey::from_bytes(&seed)
}

/// Write a payload directory the verifier will accept.
///
/// The canonical payload is built by hand in the same field order that
/// `verify.rs` and `src/main/security/integrity.ts` both use, because a
/// mismatch there is exactly the bug the parity test in `syncord-core` exists to
/// catch — this fixture must not paper over it.
fn signed_payload(dir: &Path, version: &str) {
    use base64::Engine;
    use ed25519_dalek::Signer;

    let bodies: Vec<(&str, String)> = vec![
        ("main.js", "// main\n".to_string()),
        ("preload.js", "// preload\n".to_string()),
        ("renderer.js", format!("// renderer {version}\n")),
    ];

    std::fs::create_dir_all(dir).expect("create payload dir");
    for (name, body) in &bodies {
        std::fs::write(dir.join(name), body).expect("write bundle");
    }

    let entries: Vec<String> = bodies
        .iter()
        .map(|(name, body)| {
            format!(
                "{{\"name\":\"{name}\",\"sha256\":\"{}\"}}",
                sha256_bytes(body.as_bytes())
            )
        })
        .collect();

    let canonical = format!(
        "{{\"version\":1,\"algorithm\":\"ed25519\",\"files\":[{}]}}",
        entries.join(",")
    );
    let signature = signing_key().sign(canonical.as_bytes()).to_bytes();
    let encoded = base64::engine::general_purpose::STANDARD.encode(signature);

    let manifest = format!(
        "{{\"version\":1,\"algorithm\":\"ed25519\",\"files\":[{}],\"signature\":\"{encoded}\"}}",
        entries.join(",")
    );
    std::fs::write(dir.join("integrity.manifest.json"), manifest).expect("write manifest");
    std::fs::write(dir.join(VERSION_FILE), version_stamp_bytes(version)).expect("write stamp");
}

fn archived_payload(dir: &Path, extra: Option<&str>) -> Vec<u8> {
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gzip);
    for name in syncord_core::archive::PAYLOAD_REQUIRED {
        tar.append_path_with_name(dir.join(name), name)
            .expect("archive payload");
    }
    if let Some(name) = extra {
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o600);
        header.set_cksum();
        tar.append_data(&mut header, name, &b"x"[..])
            .expect("extra entry");
    }
    tar.into_inner()
        .expect("finish tar")
        .finish()
        .expect("finish gzip")
}

#[test]
fn embedded_payload_verifies_without_a_neighbor_and_cleans_up_on_drop() {
    let temp = Temp::new("embedded");
    let dir = temp.dir("source");
    signed_payload(&dir, "1.4.0");
    let payload =
        crate::embedded_payload::prepare(&archived_payload(&dir, None), Some(&test_verifier()))
            .expect("verify embedded payload");
    let extracted = payload.0.clone();
    assert_ne!(extracted, dir);
    test_verifier()
        .verify_install(&extracted)
        .expect("verified files");
    let resources = fake_discord(temp.path());
    let env = pinned_env(temp.path(), &resources);
    let state = AppState::discover(&env, Some(extracted.clone()), Some(test_verifier()));
    let result = crate::state::inject_into_for_tests(&state, 0);
    assert!(result.ok, "{}", result.message);
    test_verifier()
        .verify_install(&resources.join("app"))
        .expect("installed embedded files");
    assert_eq!(
        syncord_core::inject::installed_version(&resources).as_deref(),
        Some("1.4.0")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&extracted).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    drop(state);
    drop(payload);
    assert!(!extracted.exists(), "temporary payload must be removed");
    assert!(dir.exists(), "source is never removed");
}

#[test]
fn embedded_payload_rejects_tampering_missing_keys_and_invalid_archives() {
    let temp = Temp::new("embedded-rejected");
    let dir = temp.dir("source");
    signed_payload(&dir, "1.4.0");
    let valid = archived_payload(&dir, None);
    assert!(crate::embedded_payload::prepare(&valid, None).is_err());
    assert!(crate::embedded_payload::prepare(b"not an archive", Some(&test_verifier())).is_err());
    assert!(crate::embedded_payload::prepare(
        &archived_payload(&dir, Some("postinstall.sh")),
        Some(&test_verifier())
    )
    .is_err());
    std::fs::write(dir.join("renderer.js"), b"tampered").unwrap();
    assert!(crate::embedded_payload::prepare(
        &archived_payload(&dir, None),
        Some(&test_verifier())
    )
    .is_err());
}

#[test]
fn embedded_payload_rejects_missing_or_invalid_version() {
    let temp = Temp::new("embedded-version");
    let dir = temp.dir("source");
    signed_payload(&dir, "1.4.0");
    std::fs::write(dir.join(VERSION_FILE), b"{}").unwrap();
    assert!(crate::embedded_payload::prepare(
        &archived_payload(&dir, None),
        Some(&test_verifier())
    )
    .is_err());
}

/// A state wired to a synthetic Discord, with or without a usable payload.
fn harness(with_payload: bool) -> (Temp, AppState, PathBuf) {
    let temp = Temp::new("state");
    let resources = fake_discord(temp.path());

    let payload_dir = temp.dir("payload");
    if with_payload {
        signed_payload(&payload_dir, "1.4.0");
    }

    let env = pinned_env(temp.path(), &resources);
    let state = AppState::discover(
        &env,
        with_payload.then_some(payload_dir),
        Some(test_verifier()),
    );
    (temp, state, resources)
}

fn pinned_env(home: &Path, resources: &Path) -> DiscoveryEnv {
    DiscoveryEnv {
        platform: Platform::MacOs,
        local_app_data: None,
        home: home.to_path_buf(),
        mac_parents: vec![],
        linux_prefixes: vec![],
        flatpak_parents: vec![],
        preferred: Some(resources.to_path_buf()),
    }
}

fn startup(state: &AppState) -> Startup {
    crate::state::startup_for_tests(state)
}

fn inject(state: &AppState, index: usize) -> crate::state::ActionResult {
    crate::state::inject_into_for_tests(state, index)
}

fn uninject(state: &AppState, index: usize) -> crate::state::ActionResult {
    crate::state::uninject_from_for_tests(state, index)
}

/// Read one row's state as a short string, so a badge assertion reads like the
/// thing it is asserting about.
fn row_state(row: &InstallRow) -> String {
    match (row.injected, row.verified) {
        (false, _) => "not-installed".to_string(),
        (true, true) => format!("installed-v{}", row.version.clone().unwrap_or_default()),
        (true, false) => "installed-unverified".to_string(),
    }
}

// ── Discovery and status ─────────────────────────────────────────────────────

#[test]
fn the_install_list_shows_one_row_for_a_synthetic_discord() {
    let (_temp, state, resources) = harness(true);
    let view = startup(&state);

    assert_eq!(view.installs.len(), 1, "one Discord means one row");
    let row = &view.installs[0];
    assert_eq!(row.branch, "custom", "a pinned path is reported as custom");
    assert_eq!(row.label, "Discord (pinned)");
    assert_eq!(row.path, resources.display().to_string());
    assert_eq!(row_state(row), "not-installed");
    assert!(row.version.is_none());
    assert!(row.fingerprint.is_none());
}

#[test]
fn a_payload_beside_the_executable_is_verified_at_startup() {
    let (_temp, state, _resources) = harness(true);
    let view = startup(&state);
    assert_eq!(view.payload_version.as_deref(), Some("1.4.0"));
    assert!(view.payload_unavailable.is_none());
    assert_eq!(view.injector_version, syncord_core::INJECTOR_VERSION);
}

#[test]
fn a_missing_payload_disables_installing_and_says_why() {
    // The state a release-less download is in. It must be visible *before* the
    // user presses anything, which is why it is part of `Startup` rather than an
    // error from the Inject command.
    let (_temp, state, _resources) = harness(false);
    let view = startup(&state);

    assert!(view.payload_version.is_none());
    let reason = view
        .payload_unavailable
        .expect("the reason must be present");
    assert!(
        reason.contains("release"),
        "the reason should say what to do: {reason}"
    );
    // The list is still shown — an unusable payload is not a reason to show an
    // empty window.
    assert_eq!(view.installs.len(), 1);
}

#[test]
fn a_build_with_no_signing_key_refuses_everything() {
    // The negative case worth asserting rather than assuming: a build whose
    // compiled key is a placeholder verifies nothing, so the payload does not
    // load and Inject cannot do anything.
    let temp = Temp::new("nokey");
    let resources = fake_discord(temp.path());
    let payload_dir = temp.dir("payload");
    signed_payload(&payload_dir, "1.4.0");

    let state = AppState::discover(
        &pinned_env(temp.path(), &resources),
        Some(payload_dir),
        None,
    );
    assert!(!crate::state::has_verifier(&state));

    let view = startup(&state);
    assert!(
        view.payload_version.is_none(),
        "no key means no payload is accepted"
    );

    let result = inject(&state, 0);
    assert!(!result.ok);
    assert!(
        result.message.contains("no release signing key"),
        "{}",
        result.message
    );
    assert!(!resources.join("app").exists(), "nothing may be written");
}

#[test]
fn an_empty_machine_is_an_empty_list_not_an_error() {
    let temp = Temp::new("empty");
    let env = DiscoveryEnv {
        platform: Platform::MacOs,
        local_app_data: None,
        home: temp.path().to_path_buf(),
        mac_parents: vec![temp.join("no-applications-here")],
        linux_prefixes: vec![],
        flatpak_parents: vec![],
        preferred: None,
    };
    let state = AppState::discover(&env, None, Some(test_verifier()));
    let view = startup(&state);
    assert!(view.installs.is_empty());
}

// ── The user sequence ────────────────────────────────────────────────────────

#[test]
fn inject_then_uninject_is_a_round_trip() {
    let (_temp, state, resources) = harness(true);

    // ── Inject ──────────────────────────────────────────────────────────────
    let result = inject(&state, 0);
    assert!(
        result.ok,
        "inject failed: {} {:?}",
        result.message, result.help
    );
    assert!(result.message.contains("installed"), "{}", result.message);
    assert!(result.help.is_none(), "a success carries no help text");

    let app = resources.join("app");
    for name in [
        "main.js",
        "preload.js",
        "renderer.js",
        "integrity.manifest.json",
        "package.json",
        VERSION_FILE,
    ] {
        assert!(app.join(name).is_file(), "{name} must be installed");
    }
    assert!(
        resources.join("_app.asar").is_file(),
        "Discord's asar must be renamed"
    );
    assert!(!resources.join("app.asar").exists());

    // The row now says "installed and verified", and names the version.
    let row = &startup(&state).installs[0];
    assert_eq!(row_state(row), "installed-v1.4.0");
    assert!(
        row.fingerprint.is_some(),
        "a fingerprint is shown so a change is visible"
    );

    // ── Uninject ────────────────────────────────────────────────────────────
    let result = uninject(&state, 0);
    assert!(result.ok, "uninject failed: {}", result.message);
    assert!(!app.exists(), "resources/app must be gone");
    assert!(
        resources.join("app.asar").is_file(),
        "Discord's asar must come back"
    );
    assert!(!resources.join("_app.asar").exists());
    assert_eq!(row_state(&startup(&state).installs[0]), "not-installed");
}

#[test]
fn injecting_twice_updates_rather_than_failing() {
    let (_temp, state, resources) = harness(true);

    let first = inject(&state, 0);
    assert!(first.ok, "{}", first.message);
    let result = inject(&state, 0);
    assert!(
        result.ok,
        "a second inject must succeed: {}",
        result.message
    );
    assert!(result.message.contains("updated"), "{}", result.message);

    // Discord's asar was renamed exactly once, and stayed renamed.
    assert!(resources.join("_app.asar").is_file());
    assert!(!resources.join("app.asar").exists());
    assert_eq!(row_state(&startup(&state).installs[0]), "installed-v1.4.0");
}

#[test]
fn uninject_never_overwrites_a_discord_that_reinstalled_itself() {
    let (_temp, state, resources) = harness(true);
    assert!(inject(&state, 0).ok);

    // Discord puts its own asar back while the backup is still there.
    std::fs::write(resources.join("app.asar"), b"discord reinstalled").expect("write asar");

    let result = uninject(&state, 0);
    assert!(result.ok, "{}", result.message);
    assert_eq!(
        std::fs::read(resources.join("app.asar")).expect("read"),
        b"discord reinstalled",
        "the present original must not be destroyed"
    );
    assert!(
        resources.join("_app.asar").is_file(),
        "the backup is left for the user"
    );
}

// ── Refusals the UI has to render ────────────────────────────────────────────

#[test]
fn an_index_outside_the_list_is_refused_not_acted_on() {
    let (_temp, state, _resources) = harness(true);
    for index in [1usize, 99, usize::MAX] {
        let result = inject(&state, index);
        assert!(!result.ok, "index {index} must be refused");
        assert!(
            result.message.contains("no longer in the list"),
            "{}",
            result.message
        );
    }
    let result = uninject(&state, 7);
    assert!(!result.ok);
    assert!(
        result.message.contains("no longer in the list"),
        "{}",
        result.message
    );
}

#[test]
fn injecting_without_a_payload_is_refused_with_a_reason() {
    let (_temp, state, _resources) = harness(false);
    let result = inject(&state, 0);
    assert!(!result.ok);
    assert!(
        result.message.contains("no verified payload"),
        "{}",
        result.message
    );
    assert!(
        result.help.is_none(),
        "a missing payload needs no extra guidance"
    );
}

#[test]
fn a_tampered_payload_never_loads_and_nothing_is_written() {
    let temp = Temp::new("tampered");
    let resources = fake_discord(temp.path());
    let payload_dir = temp.dir("payload");
    signed_payload(&payload_dir, "1.4.0");
    // One flipped byte in a bundle the manifest covers.
    std::fs::write(payload_dir.join("renderer.js"), b"// evil\n").expect("tamper");

    let state = AppState::discover(
        &pinned_env(temp.path(), &resources),
        Some(payload_dir),
        Some(test_verifier()),
    );
    assert!(
        startup(&state).payload_version.is_none(),
        "a tampered payload must not load"
    );

    let result = inject(&state, 0);
    assert!(!result.ok);
    assert!(!resources.join("app").exists(), "nothing may be written");
    assert!(
        resources.join("app.asar").is_file(),
        "Discord must be untouched"
    );
}

#[test]
fn a_discord_that_stopped_being_one_is_refused() {
    let (_temp, state, resources) = harness(true);
    // Discord uninstalled between the window opening and the click.
    std::fs::remove_file(resources.join("app.asar")).expect("remove asar");

    let result = inject(&state, 0);
    assert!(!result.ok, "{}", result.message);
    assert!(!resources.join("app").exists());
}

#[test]
fn every_row_carries_a_measured_write_access() {
    // The row is how the user learns the cause *before* pressing anything, so
    // the field has to be there and has to be measured rather than absent.
    let (_temp, state, _resources) = harness(true);
    let view = crate::state::startup_for_tests(&state);
    assert!(!view.installs.is_empty());

    for row in &view.installs {
        assert_eq!(
            row.access, "writable",
            "a fresh temporary install is writable, so this says the probe did not run"
        );
        assert!(
            row.access_hint.is_none(),
            "a writable row has nothing to say; every row reading a warning trains \
             the user to skip them"
        );
    }
}

#[test]
fn a_writable_install_offers_its_action() {
    let (_temp, state, _resources) = harness(true);
    let view = crate::state::startup_for_tests(&state);
    // The pre-flight must not have cost the button: this is the state in which
    // the whole feature is supposed to be invisible.
    assert!(view.payload_version.is_some());
    assert_eq!(view.installs[0].access, "writable");
}

#[test]
fn the_probe_leaves_the_install_exactly_as_it_found_it() {
    // The probe writes a file into the user's Discord to ask whether writing is
    // allowed. "Exactly as it found it" is the whole requirement: a helper that
    // litters the directory it is diagnosing would be worse than the error it
    // replaces.
    let (_temp, state, resources) = harness(true);

    let before = listing(&resources);
    crate::state::check_write_access_for_tests(&state);
    let after = listing(&resources);

    assert_eq!(before, after, "measuring write access changed the install");
    assert!(
        !resources.join(".syncord-write-probe").exists(),
        "the probe file survived"
    );
}

#[test]
fn a_missing_install_is_reported_as_missing_rather_than_unknown() {
    // Discovery found it; now it is gone. The user has to be told which of the
    // two happened, because the fix differs: re-scan versus investigate.
    let (_temp, state, resources) = harness(true);
    std::fs::remove_dir_all(&resources).expect("remove the install");

    let view = crate::state::check_write_access_for_tests(&state);
    assert_eq!(view.installs[0].access, "missing");
    assert!(
        view.installs[0].access_hint.is_some(),
        "a missing install still has something to tell the user"
    );
}

#[test]
fn opening_a_settings_pane_never_takes_a_url() {
    // The whole reason the shell plugin is not granted. The frontend's only
    // capability is to name a pane from a fixed set, so the worst a compromised
    // frontend can do is open a settings window the user then closes.
    let state = crate::state::SettingsPaneArg::Privacy;
    assert!(
        matches!(state, crate::state::SettingsPaneArg::Privacy),
        "the pane is an enum, so an arbitrary string cannot even be constructed"
    );

    // A URL is not a valid `SettingsPaneArg`, and deserialising one must fail
    // rather than fall through to something that opens it.
    let url = serde_json::from_str::<crate::state::SettingsPaneArg>(r#""https://example.com""#);
    assert!(
        url.is_err(),
        "a URL must not deserialise into a settings pane"
    );
    let shell = serde_json::from_str::<crate::state::SettingsPaneArg>(r#""shell""#);
    assert!(shell.is_err(), "only the known panes are accepted");
    let ok = serde_json::from_str::<crate::state::SettingsPaneArg>(r#""appManagement""#);
    assert!(
        ok.is_ok(),
        "the frontend's spelling has to be the accepted one"
    );
}

#[test]
fn a_pane_that_does_not_exist_here_fails_rather_than_pretending() {
    // Opening a settings screen is a macOS thing. On Windows the command must
    // say so rather than reporting success for a window that never appeared.
    let view = crate::state::open_settings_for_tests(crate::state::SettingsPaneArg::Privacy);
    if cfg!(target_os = "macos") {
        // A real open; the dialog may or may not have been shown, but the call
        // must not have reported a transport failure.
        let _ = view;
    } else {
        assert!(
            !view.ok,
            "a platform with no such pane must not claim success"
        );
    }
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("the install directory should be readable")
        .map(|entry| {
            entry
                .expect("a readable directory entry")
                .file_name()
                .display()
                .to_string()
        })
        .collect();
    names.sort();
    names
}

#[test]
fn gui_reports_and_repairs_verified_files_with_a_shadowed_loader() {
    let (_temp, state, resources) = harness(true);
    assert!(inject(&state, 0).ok);
    std::fs::write(resources.join("app.asar"), b"new Discord host").unwrap();
    let before = startup(&state);
    assert!(before.installs[0].injected);
    assert!(before.installs[0].verified);
    assert!(!before.installs[0].launch_ready);
    let result = inject(&state, 0);
    assert!(result.ok, "{}", result.message);
    assert!(startup(&state).installs[0].launch_ready);
    assert_eq!(
        std::fs::read(resources.join("_app.asar")).unwrap(),
        b"new Discord host"
    );
}

#[cfg(unix)]
#[test]
fn gui_refuses_to_modify_a_running_discord_install() {
    struct Running(std::process::Child);
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let (temp, state, resources) = harness(true);
    let executable = temp.join("Discord");
    std::fs::copy("/bin/sleep", &executable).expect("copy a harmless process fixture");
    #[cfg(target_os = "macos")]
    assert!(std::process::Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-"])
        .arg(&executable)
        .output()
        .expect("ad-hoc sign the relocated macOS fixture")
        .status
        .success());
    let process = Running(
        std::process::Command::new(&executable)
            .arg("30")
            .spawn()
            .expect("start the process fixture"),
    );
    #[cfg(target_os = "linux")]
    {
        let image = std::fs::read_link(format!("/proc/{}/exe", process.0.id()))
            .expect("read the fixture process image");
        if image.file_name().is_some_and(|name| name == "rosetta") {
            eprintln!(
                "SKIP live Linux process fixture: Docker Desktop exposes Rosetta as /proc/exe"
            );
            return;
        }
    }
    // Hold the child until both GUI actions have returned, even on macOS where
    // the Linux-specific image check is not compiled.
    let _process = process;
    let root = temp.path().canonicalize().unwrap();
    assert!(crate::running_for(&root).is_some());
    let result = inject(&state, 0);
    assert!(!result.ok);
    assert!(result.message.contains("still running"));
    assert!(!resources.join("app").exists());
    assert!(resources.join("app.asar").exists());
    let result = uninject(&state, 0);
    assert!(!result.ok);
    assert!(result.message.contains("still running"));
}

fn archive_payload(dir: &Path) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    for name in [
        "main.js",
        "preload.js",
        "renderer.js",
        "integrity.manifest.json",
        "syncord-version.json",
    ] {
        archive.append_path_with_name(dir.join(name), name).unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap()
}

#[test]
fn one_injector_applies_two_future_releases_instead_of_reinstalling_its_bundle() {
    let (temp, state, resources) = harness(true);
    assert!(crate::state::inject_into_for_tests(&state, 0).ok);
    assert_eq!(
        syncord_core::inject::installed_version(&resources).as_deref(),
        Some("1.4.0")
    );
    for version in ["1.5.0", "1.6.0"] {
        let payload = temp.dir(version);
        signed_payload(&payload, version);
        let bytes = archive_payload(&payload);
        let release = syncord_core::release::VerifiedRelease {
            version: version.into(),
            asset: syncord_core::release::Asset {
                platform: syncord_core::release::current_platform(),
                name: format!("syncord-{version}.tar.gz"),
                size: bytes.len() as u64,
                sha256: sha256_bytes(&bytes),
            },
        };
        let result =
            crate::state::install_release_for_tests(&state, 0, &release, &test_verifier(), || {
                let retained = crate::release_client::PreparedPayload::new()?;
                crate::release_client::prepare(&bytes, &release, &test_verifier(), &retained.0)?;
                Ok(retained)
            });
        assert!(result.ok, "{}", result.message);
        assert_eq!(
            syncord_core::inject::installed_version(&resources).as_deref(),
            Some(version)
        );
        test_verifier()
            .verify_install(&resources.join("app"))
            .unwrap();
    }
    // An explicit offline repair must not put the old bundled client back.
    assert!(!crate::state::inject_into_for_tests(&state, 0).ok);
    assert_eq!(
        syncord_core::inject::installed_version(&resources).as_deref(),
        Some("1.6.0")
    );
}

#[test]
fn a_remote_checksum_failure_leaves_the_installed_client_intact() {
    let (_temp, state, resources) = harness(true);
    assert!(crate::state::inject_into_for_tests(&state, 0).ok);
    let release = syncord_core::release::VerifiedRelease {
        version: "1.5.0".into(),
        asset: syncord_core::release::Asset {
            platform: syncord_core::release::current_platform(),
            name: "syncord-1.5.0.tar.gz".into(),
            size: 1,
            sha256: "a".repeat(64),
        },
    };
    let result =
        crate::state::install_release_for_tests(&state, 0, &release, &test_verifier(), || {
            let retained = crate::release_client::PreparedPayload::new()?;
            crate::release_client::prepare(b"x", &release, &test_verifier(), &retained.0)?;
            Ok(retained)
        });
    assert!(!result.ok);
    assert_eq!(
        syncord_core::inject::installed_version(&resources).as_deref(),
        Some("1.4.0")
    );
    test_verifier()
        .verify_install(&resources.join("app"))
        .unwrap();
}
