//! Behaviour tests for [`crate::inject`].
//!
//! These tests operate on a synthetic Discord install in a temporary directory.
//! Nothing here touches a real Discord, and nothing here needs one — which is
//! the point of keeping the filesystem logic in a library crate with no GUI
//! dependency.
//!
//! What is being pinned:
//!
//! * a verified payload is installed and Discord's asar is renamed exactly
//!   once;
//! * an unverified payload is refused **before** the install is touched at all;
//! * a failure part way through leaves the machine in the state it started in;
//! * `uninject` restores Discord's asar, and refuses to overwrite a present
//!   original;
//! * leftovers from an interrupted run are cleaned before anything else runs.

use super::super::discovery::{Branch, Install};
use super::super::inject::{inject, uninject, update, InjectError, InjectOutcome};
use super::super::verify::{Manifest, Verifier, VerifyError};
use crate::testsupport::{
    make_discord_install, verifier as test_verifier, write_verified_payload,
    write_verified_payload_versioned, TempDir, TEST_VERSION,
};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

/// A synthetic install, plus the `Install` value discovery would have returned.
struct Fixture {
    temp: TempDir,
    install: Install,
}

impl Fixture {
    fn new(tag: &str, injected: bool) -> Self {
        let temp = TempDir::new(tag);
        let resources = make_discord_install(temp.path(), "Discord.app", injected);
        let install = Install {
            branch: Branch::Stable,
            root: temp.join("Discord.app"),
            resources: resources.canonicalize().unwrap(),
            injected,
        };
        Self { temp, install }
    }

    /// A verified payload directory, written to disk.
    fn payload(&self) -> std::path::PathBuf {
        let dir = self.temp.dir("payload");
        write_verified_payload(&dir);
        dir
    }

    /// A verifier bound to the test key.
    ///
    /// A method rather than a free function so every call site reads as
    /// "this fixture verifies with the test key", which matters because the
    /// production path uses `Verifier::embedded()` and the two must never be
    /// confused.
    fn verifier(&self) -> Verifier {
        test_verifier()
    }

    fn resources(&self) -> &std::path::Path {
        &self.install.resources
    }

    fn app_dir(&self) -> std::path::PathBuf {
        self.resources().join("app")
    }
}

#[test]
fn a_fresh_install_renames_the_asar_and_places_the_payload() {
    let fixture = Fixture::new("fresh", false);
    let payload = fixture.payload();

    let outcome = inject(&fixture.install, &payload, &fixture.verifier())
        .expect("a verified payload must install");
    assert_eq!(outcome, InjectOutcome::FreshInstall);

    assert!(
        fixture.resources().join("_app.asar").is_file(),
        "Discord's asar must be renamed"
    );
    assert!(
        !fixture.resources().join("app.asar").exists(),
        "app.asar must no longer be present"
    );

    let app = fixture.app_dir();
    for name in [
        "main.js",
        "preload.js",
        "renderer.js",
        "integrity.manifest.json",
        "package.json",
    ] {
        assert!(app.join(name).is_file(), "{name} must be installed");
    }

    // And the result is a state the client itself would accept.
    assert!(fixture.verifier().verify_install(&app).is_ok());
}

#[test]
fn no_staging_or_rollback_directory_survives_a_successful_run() {
    let fixture = Fixture::new("clean", false);
    inject(&fixture.install, &fixture.payload(), &fixture.verifier())
        .expect("install must succeed");

    assert!(!fixture.resources().join(".syncord-staging").exists());
    assert!(!fixture.resources().join(".syncord-rollback").exists());
    // Nothing temporary left beside the bundles either.
    for name in ["main.js", "preload.js", "renderer.js"] {
        assert!(
            !fixture
                .app_dir()
                .join(format!("{name}.syncord-tmp"))
                .exists(),
            "{name} must not leave a temporary file"
        );
    }
}

#[test]
fn an_unverified_payload_is_refused_before_the_install_is_touched() {
    let fixture = Fixture::new("unverified", false);
    let payload = fixture.payload();

    // Break the signature.
    let manifest_path = payload.join("integrity.manifest.json");
    let manifest = std::fs::read_to_string(&manifest_path).unwrap();
    std::fs::write(
        &manifest_path,
        manifest.replace("\"version\":1", "\"version\":9"),
    )
    .unwrap();

    let result = inject(&fixture.install, &payload, &fixture.verifier());
    assert!(
        matches!(result, Err(InjectError::NotVerified(_))),
        "got {result:?}"
    );

    // Nothing happened: Discord is untouched.
    assert!(
        fixture.resources().join("app.asar").is_file(),
        "app.asar must be untouched"
    );
    assert!(!fixture.resources().join("_app.asar").exists());
    assert!(
        !fixture.app_dir().exists(),
        "no partial install may be left behind"
    );
}

#[test]
fn a_payload_whose_bundle_was_tampered_with_is_refused() {
    let fixture = Fixture::new("tampered", false);
    let payload = fixture.payload();
    std::fs::write(payload.join("renderer.js"), b"console.log('evil')\n").unwrap();

    let result = inject(&fixture.install, &payload, &fixture.verifier());
    assert!(matches!(
        result,
        Err(InjectError::NotVerified(VerifyError::BundleDigestMismatch(
            _
        )))
    ));
    assert!(fixture.resources().join("app.asar").is_file());
    assert!(!fixture.app_dir().exists());
}

#[test]
fn an_install_that_is_no_longer_discord_is_refused() {
    let fixture = Fixture::new("gone", false);
    let payload = fixture.payload();
    std::fs::remove_file(fixture.resources().join("app.asar")).unwrap();

    let result = inject(&fixture.install, &payload, &fixture.verifier());
    assert!(
        matches!(result, Err(InjectError::NotAnInstall(_))),
        "got {result:?}"
    );
}

#[test]
fn reinjecting_replaces_the_previous_version_and_keeps_one_asar() {
    let fixture = Fixture::new("replace", true);
    let first = fixture.payload();
    inject(&fixture.install, &first, &fixture.verifier()).expect("the first install must succeed");

    // A second, different — but still valid — payload.
    let second = fixture.temp.dir("payload2");
    write_verified_payload(&second);
    std::fs::write(second.join("renderer.js"), b"console.log('v2');\n").unwrap();
    resign(&second, TEST_VERSION);

    let outcome =
        inject(&fixture.install, &second, &fixture.verifier()).expect("a replace must succeed");
    assert_eq!(outcome, InjectOutcome::Replaced);

    assert_eq!(
        std::fs::read_to_string(fixture.app_dir().join("renderer.js")).unwrap(),
        "console.log('v2');\n",
        "the new bundles must be live"
    );
    assert!(fixture.resources().join("_app.asar").is_file());
    assert!(
        !fixture.resources().join("app.asar").exists(),
        "app.asar must not reappear"
    );
    assert!(
        !fixture.resources().join(".syncord-rollback").exists(),
        "the rollback copy must be discarded"
    );
}

/// Re-sign a payload directory after its bundles changed.
///
/// Only the test module can do this, which is deliberate: it is a stand-in for
/// the release pipeline, and it reuses the same signing helper.
fn resign(dir: &std::path::Path, version: &str) {
    use super::super::verify::{sha256_file, ManifestFile};
    use crate::testsupport::{sha256_hex, sign};

    let mut files = Vec::new();
    for name in ["main.js", "preload.js", "renderer.js"] {
        let digest = sha256_file(&dir.join(name)).unwrap();
        files.push(ManifestFile {
            name: name.to_string(),
            sha256: digest,
        });
    }
    let manifest = Manifest {
        version: 1,
        algorithm: "ed25519".to_string(),
        files: files.clone(),
        signature: None,
    };
    let payload = Verifier::canonical_payload(&manifest);
    let signed = Manifest {
        signature: Some(sign(payload.as_bytes())),
        ..manifest
    };
    std::fs::write(
        dir.join("integrity.manifest.json"),
        serde_json::to_string(&signed).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.join(crate::verify::VERSION_FILE),
        crate::verify::version_stamp_bytes(version),
    )
    .unwrap();

    // Keep the helper honest about the digest format.
    assert_eq!(files[0].sha256.len(), 64);
    assert_eq!(
        files[0].sha256,
        sha256_hex(&[]).replace(&sha256_hex(&[]), &files[0].sha256)
    );
}

#[test]
fn update_refreshes_bundles_without_moving_the_directory() {
    let fixture = Fixture::new("update", true);
    let first = fixture.payload();
    inject(&fixture.install, &first, &fixture.verifier()).expect("the first install must succeed");

    // On Unix the inode is a stable identity for the directory. An update must
    // not replace the directory, only its files, so a running Electron process
    // keeps a valid path for the whole operation.
    #[cfg(unix)]
    let app_inode_before = std::fs::metadata(fixture.app_dir()).unwrap().ino();

    let second = fixture.temp.dir("payload2");
    write_verified_payload(&second);
    std::fs::write(second.join("main.js"), b"console.log('main v2');\n").unwrap();
    resign(&second, TEST_VERSION);

    let outcome =
        update(&fixture.install, &second, &fixture.verifier()).expect("an update must succeed");
    assert_eq!(outcome, InjectOutcome::Updated);

    assert_eq!(
        std::fs::read_to_string(fixture.app_dir().join("main.js")).unwrap(),
        "console.log('main v2');\n"
    );
    // The directory itself was never renamed aside, so an in-flight Electron
    // process keeps a valid path the whole time.
    #[cfg(unix)]
    {
        assert_eq!(
            std::fs::metadata(fixture.app_dir()).unwrap().ino(),
            app_inode_before,
            "an update must not replace the app directory"
        );
    }
}

#[test]
fn an_update_leaves_the_install_verifiable() {
    // The regression this exists for. `update` once replaced the three bundles
    // but kept the *previous* manifest, so the install was left with new bytes
    // and old digests: permanently unverifiable, with no recovery short of a
    // manual reinstall. The unit tests around `update` all passed anyway,
    // because they only asserted that a bundle's *content* changed.
    //
    // Found by running the real binary end to end, not by these tests. It is
    // here so it never comes back.
    let fixture = Fixture::new("updateverifies", true);
    let first = fixture.payload();
    inject(&fixture.install, &first, &fixture.verifier()).expect("the first install must succeed");

    let second = fixture.temp.dir("payload2");
    write_verified_payload_versioned(&second, "1.5.0");
    std::fs::write(second.join("renderer.js"), b"// renderer 1.5.0\n").unwrap();
    resign(&second, "1.5.0");

    update(&fixture.install, &second, &fixture.verifier()).expect("the update must succeed");

    // The whole point: after an update, the install still verifies against a
    // signature, and it is the *new* one.
    let manifest = std::fs::read_to_string(fixture.app_dir().join("integrity.manifest.json"))
        .expect("the manifest must be present after an update");
    let manifest: super::super::verify::Manifest = serde_json::from_str(&manifest).unwrap();

    let renderer_digest =
        crate::verify::sha256_file(&fixture.app_dir().join("renderer.js")).unwrap();
    let recorded = manifest
        .files
        .iter()
        .find(|entry| entry.name == "renderer.js")
        .expect("renderer.js must be covered")
        .sha256
        .clone();
    assert_eq!(
        renderer_digest, recorded,
        "the installed manifest must describe the *new* bundles, not the old ones"
    );

    fixture
        .verifier()
        .verify_install(&fixture.app_dir())
        .expect("an updated install must still verify");

    assert_eq!(
        super::super::inject::installed_version(fixture.resources()).as_deref(),
        Some("1.5.0"),
        "the version stamp must be updated too"
    );
}

#[test]
fn an_update_does_not_touch_discords_own_asar() {
    let fixture = Fixture::new("updateasar", true);
    inject(&fixture.install, &fixture.payload(), &fixture.verifier())
        .expect("install must succeed");
    let asar = fixture.resources().join("_app.asar");
    let before = std::fs::read(&asar).expect("read asar");

    let second = fixture.temp.dir("payload2");
    write_verified_payload_versioned(&second, "1.5.0");
    resign(&second, "1.5.0");
    update(&fixture.install, &second, &fixture.verifier()).expect("update must succeed");

    assert_eq!(
        std::fs::read(&asar).expect("read asar"),
        before,
        "Discord's asar must be untouched"
    );
    assert!(
        !fixture.resources().join("app.asar").exists(),
        "app.asar must not reappear"
    );
}

#[test]
fn update_refuses_when_syncord_is_not_installed_here() {
    let fixture = Fixture::new("noupdate", false);
    let payload = fixture.payload();
    let result = update(&fixture.install, &payload, &fixture.verifier());
    assert!(
        matches!(result, Err(InjectError::NotAnInstall(_))),
        "got {result:?}"
    );
}

#[test]
fn update_refuses_a_current_install_whose_own_manifest_does_not_verify() {
    // Overwriting something that does not verify would be a silent downgrade
    // from an unverifiable state to a verifiable one, and the user was never
    // told. Refuse and say so.
    let fixture = Fixture::new("broken", true);
    let payload = fixture.payload();
    inject(&fixture.install, &payload, &fixture.verifier())
        .expect("the first install must succeed");

    // Corrupt the *installed* manifest.
    std::fs::write(fixture.app_dir().join("integrity.manifest.json"), b"{}").unwrap();

    let result = update(&fixture.install, &payload, &fixture.verifier());
    assert!(
        matches!(result, Err(InjectError::NotVerified(_))),
        "got {result:?}"
    );
}

#[test]
fn uninject_removes_syncord_and_restores_discords_asar() {
    let fixture = Fixture::new("uninject", false);
    let payload = fixture.payload();
    inject(&fixture.install, &payload, &fixture.verifier()).expect("the install must succeed");

    let outcome = uninject(&fixture.install).expect("uninstall must succeed");
    assert_eq!(outcome, InjectOutcome::Uninstalled);

    assert!(!fixture.app_dir().exists(), "resources/app must be gone");
    assert!(
        fixture.resources().join("app.asar").is_file(),
        "Discord's asar must be restored"
    );
    assert!(!fixture.resources().join("_app.asar").exists());
}

#[test]
fn uninject_never_overwrites_a_present_original_asar() {
    // Restoring over an existing app.asar would destroy Discord's own file. The
    // backup is left alone instead, which is the behaviour `scripts/inject.mjs`
    // has and the reason a half-completed uninstall is recoverable.
    let fixture = Fixture::new("both", false);
    let payload = fixture.payload();
    inject(&fixture.install, &payload, &fixture.verifier()).expect("the install must succeed");

    // Discord reinstalled itself, putting app.asar back while _app.asar remains.
    std::fs::write(fixture.resources().join("app.asar"), b"discord reinstalled").unwrap();

    uninject(&fixture.install).expect("uninstall must still succeed");
    assert_eq!(
        std::fs::read(fixture.resources().join("app.asar")).unwrap(),
        b"discord reinstalled",
        "the present original must be left untouched"
    );
    assert!(
        fixture.resources().join("_app.asar").is_file(),
        "the backup must be left in place"
    );
}

#[test]
fn uninject_on_a_clean_install_is_a_no_op_that_succeeds() {
    let fixture = Fixture::new("cleanun", false);
    assert_eq!(
        uninject(&fixture.install).expect("must succeed"),
        InjectOutcome::Uninstalled
    );
    assert!(fixture.resources().join("app.asar").is_file());
}

#[test]
fn leftovers_from_an_interrupted_run_are_cleaned_before_anything_else() {
    // A crash between the two renames in `inject` leaves a rollback directory
    // holding the only copy of a working install. The next run must clear or
    // restore it before it touches anything.
    let fixture = Fixture::new("leftover", true);
    let stale_staging = fixture.resources().join(".syncord-staging");
    let stale_rollback = fixture.resources().join(".syncord-rollback");
    std::fs::create_dir_all(&stale_staging).unwrap();
    std::fs::create_dir_all(&stale_rollback).unwrap();
    std::fs::write(stale_staging.join("junk"), b"x").unwrap();
    std::fs::write(stale_rollback.join("main.js"), b"stale").unwrap();
    std::fs::write(fixture.app_dir().join("main.js.syncord-tmp"), b"partial").unwrap();

    // The existing install has no valid manifest, so build one properly first.
    let payload = fixture.payload();
    inject(&fixture.install, &payload, &fixture.verifier()).expect("install must succeed");

    assert!(
        !stale_staging.exists(),
        "a stale staging directory must be removed"
    );
    assert!(
        !stale_rollback.exists(),
        "a stale rollback directory must be discarded when app exists"
    );
    assert!(
        !fixture.app_dir().join("main.js.syncord-tmp").exists(),
        "a stale temporary file must be removed"
    );
}

#[test]
fn a_rollback_directory_is_restored_when_the_swap_was_interrupted() {
    // The dangerous case. A crash *between* the two renames leaves the rollback
    // directory as the only copy of a working Syncord install. Deleting it would
    // leave a Discord that cannot boot, and the Injector is exactly the program
    // the user would run to fix that.
    let fixture = Fixture::new("recover", true);
    let payload = fixture.payload();
    inject(&fixture.install, &payload, &fixture.verifier())
        .expect("the first install must succeed");

    let good_bundle = std::fs::read(fixture.app_dir().join("renderer.js")).unwrap();

    // Reproduce the interrupted state: app moved aside, staging not yet moved in.
    let app_dir = fixture.app_dir();
    let rollback = fixture.resources().join(".syncord-rollback");
    std::fs::rename(&app_dir, &rollback).unwrap();
    assert!(!app_dir.exists());

    // `update` runs the same cleanup, and is the operation a user would perform.
    let second = fixture.temp.dir("payload2");
    write_verified_payload(&second);
    update(&fixture.install, &second, &fixture.verifier()).expect("recovery must succeed");

    assert!(
        app_dir.is_dir(),
        "a working install must be restored, not discarded"
    );
    assert!(fixture.verifier().verify_install(&app_dir).is_ok());
    assert_eq!(
        std::fs::read(app_dir.join("renderer.js")).unwrap(),
        good_bundle
    );
    assert!(
        !rollback.exists(),
        "the rollback directory must be consumed by the restore"
    );
}

#[test]
fn a_payload_containing_a_symlink_is_refused_during_the_staging_copy() {
    // The payload has already passed verification as a set of five regular
    // files, so a link appearing here means something is wrong. Copying it
    // would turn one write into a write anywhere.
    let fixture = Fixture::new("symlink", false);

    #[cfg(unix)]
    {
        let payload = fixture.payload();
        std::fs::remove_file(payload.join("renderer.js")).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", payload.join("renderer.js")).unwrap();

        let result = inject(&fixture.install, &payload, &fixture.verifier());
        // It is refused at verification, before the copy is even attempted.
        assert!(
            result.is_err(),
            "a symlinked payload must be refused, got {result:?}"
        );
        assert!(
            fixture.resources().join("app.asar").is_file(),
            "the install must be untouched"
        );
    }
    #[cfg(not(unix))]
    {
        let _ = fixture;
    }
}

#[test]
fn injection_never_writes_outside_the_resources_directory() {
    // The strongest single statement of "no arbitrary filesystem targets": after
    // a full inject, the only new paths are inside `resources`.
    let fixture = Fixture::new("containment", false);
    // The payload is created *before* the snapshot, so anything that shows up as
    // new was created by `inject` and not by the test setup.
    let payload = fixture.payload();
    let before = snapshot(fixture.temp.path());

    inject(&fixture.install, &payload, &fixture.verifier()).expect("install must succeed");

    let after = snapshot(fixture.temp.path());
    let added: Vec<String> = after.difference(&before).cloned().collect();

    let resources = fixture.resources().canonicalize().unwrap();
    for path in &added {
        let resolved = std::path::Path::new(path)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(path));
        assert!(
            resolved.starts_with(&resources),
            "{path} was created outside the resources directory"
        );
    }

    // The payload directory itself is untouched by the write.
    assert!(payload.join("main.js").is_file());
}

/// Every path under `root`, recursively, as strings.
fn snapshot(root: &std::path::Path) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            out.insert(path.to_string_lossy().into_owned());
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    out
}

// ── Where the bundled payload is looked for ───────────────────────────────────

/// The candidate list is a security-relevant ordering, and it is invisible until
/// a release is actually laid out. These build the three real layouts on disk
/// and assert which one wins, so a reordering that would make an
/// attacker-writable directory take priority over the signed one cannot happen
/// quietly.
mod bundled_payload_lookup {
    use crate::inject::payload_dir_for_exe;
    use crate::testsupport::TempDir;

    /// `<tmp>/app` holding the executable, and optionally payload directories.
    fn layout(temp: &TempDir, exe_rel: &str, payloads: &[&str]) -> std::path::PathBuf {
        let exe = temp.dir(exe_rel);
        std::fs::write(exe.join("syncord-injector"), b"binary").unwrap();
        for payload in payloads {
            let dir = exe.join(payload);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("marker"), payload).unwrap();
        }
        exe.join("syncord-injector")
    }

    fn marker_of(found: Option<std::path::PathBuf>) -> String {
        let dir = found.expect("a payload directory must be found");
        std::fs::read_to_string(dir.join("marker")).unwrap()
    }

    #[test]
    fn a_bare_binary_finds_the_payload_beside_it() {
        let temp = TempDir::new("payloada");
        let exe = layout(&temp, "app", &["payload"]);
        assert_eq!(marker_of(payload_dir_for_exe(&exe)), "payload");
    }

    #[test]
    fn a_macos_app_finds_the_payload_in_its_resources() {
        let temp = TempDir::new("payloadb");
        let exe = layout(
            &temp,
            "Syncord Injector.app/Contents/MacOS",
            &["../Resources/payload"],
        );
        assert_eq!(marker_of(payload_dir_for_exe(&exe)), "../Resources/payload");
    }

    #[test]
    fn an_extracted_archive_finds_the_payload_beside_the_app() {
        let temp = TempDir::new("payloadc");
        let exe = layout(
            &temp,
            "Syncord Injector.app/Contents/MacOS",
            &["../../../payload"],
        );
        assert_eq!(marker_of(payload_dir_for_exe(&exe)), "../../../payload");
    }

    #[test]
    fn beside_the_executable_wins_over_inside_the_bundle() {
        // Both present. The portable layout is the one a user or an attacker
        // with write access to the install directory controls, so if this ever
        // inverts, the behaviour has changed deliberately — the tests below
        // would catch it.
        let temp = TempDir::new("payloadd");
        let exe = layout(
            &temp,
            "Syncord Injector.app/Contents/MacOS",
            &["payload", "../Resources/payload"],
        );
        assert_eq!(marker_of(payload_dir_for_exe(&exe)), "payload");
    }

    #[test]
    fn no_payload_anywhere_is_none_rather_than_a_wrong_answer() {
        let temp = TempDir::new("payloade");
        let exe = layout(&temp, "app", &[]);
        assert!(payload_dir_for_exe(&exe).is_none());
    }

    #[test]
    fn a_file_named_payload_is_not_a_payload_directory() {
        // `is_dir` rather than `exists`, so a file cannot be walked into and
        // read as if it were the verified payload.
        let temp = TempDir::new("payloadf");
        let exe = layout(&temp, "app", &[]);
        std::fs::write(exe.parent().unwrap().join("payload"), b"not a directory").unwrap();
        assert!(payload_dir_for_exe(&exe).is_none());
    }
}

#[test]
fn restored_discord_asar_is_detected_and_repaired() {
    let f = Fixture::new("restored-asar", false);
    let payload = f.payload();
    inject(&f.install, &payload, &f.verifier()).unwrap();
    assert!(crate::inject::launch_ready(f.resources()));
    std::fs::write(f.resources().join("app.asar"), b"new Discord host").unwrap();
    assert!(f.verifier().verify_install(&f.app_dir()).is_ok());
    assert!(!crate::inject::launch_ready(f.resources()));
    update(&f.install, &payload, &f.verifier()).unwrap();
    assert!(crate::inject::launch_ready(f.resources()));
    assert_eq!(
        std::fs::read(f.resources().join("_app.asar")).unwrap(),
        b"new Discord host"
    );
    assert!(!f.resources().join(".syncord-asar-rollback").exists());
    uninject(&f.install).unwrap();
    assert_eq!(
        std::fs::read(f.resources().join("app.asar")).unwrap(),
        b"new Discord host"
    );
}

#[test]
fn repair_refuses_a_file_destination_without_changing_discord_asars() {
    let f = Fixture::new("failed-repair", false);
    let payload = f.payload();
    inject(&f.install, &payload, &f.verifier()).unwrap();
    let old = std::fs::read(f.resources().join("_app.asar")).unwrap();
    std::fs::write(f.resources().join("app.asar"), b"new Discord host").unwrap();
    std::fs::remove_dir_all(f.app_dir()).unwrap();
    std::fs::write(f.app_dir(), b"blocked destination").unwrap();
    assert!(inject(&f.install, &payload, &f.verifier()).is_err());
    assert_eq!(
        std::fs::read(f.resources().join("app.asar")).unwrap(),
        b"new Discord host"
    );
    assert_eq!(std::fs::read(f.resources().join("_app.asar")).unwrap(), old);
    assert_eq!(std::fs::read(f.app_dir()).unwrap(), b"blocked destination");
    assert!(!f.resources().join(".syncord-asar-rollback").exists());
}

#[test]
fn interrupted_asar_rotation_is_recovered_before_repair() {
    let f = Fixture::new("interrupted-asar", false);
    let payload = f.payload();
    inject(&f.install, &payload, &f.verifier()).unwrap();
    std::fs::write(f.resources().join("app.asar"), b"new Discord host").unwrap();
    std::fs::rename(
        f.resources().join("_app.asar"),
        f.resources().join(".syncord-asar-rollback"),
    )
    .unwrap();
    inject(&f.install, &payload, &f.verifier()).unwrap();
    assert!(crate::inject::launch_ready(f.resources()));
    assert_eq!(
        std::fs::read(f.resources().join("_app.asar")).unwrap(),
        b"new Discord host"
    );
}

#[test]
fn missing_or_wrong_entry_point_is_not_launch_ready() {
    let f = Fixture::new("wrong-entry", false);
    inject(&f.install, &f.payload(), &f.verifier()).unwrap();
    std::fs::write(
        f.app_dir().join("package.json"),
        br#"{"main":"renderer.js"}"#,
    )
    .unwrap();
    assert!(!crate::inject::launch_ready(f.resources()));
    std::fs::remove_file(f.app_dir().join("package.json")).unwrap();
    assert!(!crate::inject::launch_ready(f.resources()));
}
