//! Injection: writing a verified payload into a Discord install, atomically.
//!
//! This is the only module in the crate that mutates anything on a user's
//! machine, so it is written around one rule: **a partially written Discord
//! install must not be observable.** Discord will not boot from a half-written
//! `resources/app`, and a user who cannot start Discord cannot run the Injector
//! to fix it either.
//!
//! ── How atomicity is achieved ───────────────────────────────────────────────
//!
//! `rename` is only atomic when the target does not exist, so an atomic
//! directory swap is a *sequence* of atomic renames with a small window
//! between them. The window is made survivable rather than eliminated:
//!
//! ```text
//!   resources/app.syncord-staging   ← verified payload written here
//!   resources/app.syncord-rollback  ← the previous install, moved aside
//!   resources/app                   ← the live install
//!
//!   inject:   app -> rollback        (rename)
//!             staging -> app         (rename)     ← the swap
//!             rollback removed        (only after the swap succeeded)
//!
//!   update:   per file: write <name>.syncord-tmp then rename over <name>
//!             (atomic per file; no window where the directory is missing)
//! ```
//!
//! Every rename is undone in reverse if a later step fails, so a failure leaves
//! the machine in the state it started in. A crash — not an error return — is
//! the only way to leave a rollback directory behind, and the next run cleans it
//! up before doing anything else.
//!
//! `inject` and `update` are separate because they have different failure
//! shapes. A fresh install has nothing to preserve, so it can swap the whole
//! directory. An in-place update of a running install should not make
//! `resources/app` briefly disappear, so it replaces files individually.
//!
//! ── Privilege ───────────────────────────────────────────────────────────────
//!
//! Nothing here elevates. A write that fails for lack of permission returns
//! [`InjectError::PermissionDenied`] carrying the same guidance the JavaScript
//! tool gives; the user decides whether to grant it. There is no manifest
//! requesting elevation, no `runas`, and no re-exec: an installer that can
//! silently obtain administrator rights is an installer that can silently
//! obtain them on behalf of anything that manages to run it.

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::archive::bundle_names;
use crate::discovery::{self, Install};
use crate::verify::{self, Verifier, VerifyError};

/// Temporary suffix for an in-place file replacement.
const TMP_SUFFIX: &str = ".syncord-tmp";

/// Whether Electron's default startup search will reach the installed loader.
///
/// This checks the entry point on disk, not whether Discord is running or its
/// renderer loaded. app.asar takes precedence over app; a restored app.asar
/// must therefore be repaired even if all Syncord bundles still verify.
#[must_use]
pub fn launch_ready(resources: &Path) -> bool {
    if resources.join("app.asar").exists() || !resources.join("_app.asar").is_file() {
        return false;
    }
    let app = resources.join("app");
    if !["main.js", "preload.js", "renderer.js"]
        .iter()
        .all(|name| app.join(name).is_file())
    {
        return false;
    }
    let Ok(raw) = fs::read(app.join(verify::PACKAGE_JSON_NAME)) else {
        return false;
    };
    let Ok(package) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return false;
    };
    package.get("main").and_then(serde_json::Value::as_str) == Some("main.js")
}

/// Old Discord asar retained until the replacement injection commits.
const ASAR_ROLLBACK: &str = ".syncord-asar-rollback";

/// What an injection did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectOutcome {
    /// Nothing existed; the payload was installed and Discord's asar renamed.
    FreshInstall,
    /// Syncord was already present; the bundles were replaced.
    Replaced,
    /// The bundles were refreshed in place in an existing install.
    Updated,
    /// Syncord was removed and Discord's asar restored.
    Uninstalled,
}

/// Why an injection failed.
#[derive(Debug)]
pub enum InjectError {
    /// The install no longer looks like a Discord install.
    NotAnInstall(String),
    /// A write was refused by the operating system. Carries the platform
    /// guidance rather than suggesting a command the user did not ask for.
    PermissionDenied {
        /// The path that could not be written.
        path: PathBuf,
        /// What the user can do about it.
        help: String,
    },
    /// The staging directory is not a verified payload.
    NotVerified(VerifyError),
    /// A rename, create or delete failed.
    Io {
        /// The path that could not be written.
        path: PathBuf,
        /// The underlying error, for display.
        message: String,
    },
    /// A rollback could not restore the previous state. This is the one error
    /// that means the machine may be left in a bad state, and its message says
    /// so explicitly rather than reading as a transient failure.
    RollbackFailed {
        /// The install directory that could not be restored.
        path: PathBuf,
        /// What went wrong during the restore.
        message: String,
    },
}

impl fmt::Display for InjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAnInstall(why) => {
                write!(f, "{why}")
            }
            Self::PermissionDenied { path, help } => {
                write!(f, "cannot write to {}.\n{help}", path.display())
            }
            Self::NotVerified(err) => write!(f, "the payload was not verified: {err}"),
            Self::Io { path, message } => {
                write!(f, "could not write {}: {message}", path.display())
            }
            Self::RollbackFailed { path, message } => write!(
                f,
                "the update failed and the previous version could not be restored \
                 ({}: {message}).\nSyncord has been left in a partial state. \
                 Close Discord and run the Injector again, or reinstall Discord.",
                path.display()
            ),
        }
    }
}

impl std::error::Error for InjectError {}

impl From<VerifyError> for InjectError {
    fn from(err: VerifyError) -> Self {
        Self::NotVerified(err)
    }
}

/// Translate an I/O error into the most specific variant available.
///
/// The distinction that matters to a user is "you need permission" versus
/// "something else went wrong", because the first has a known fix and the
/// second does not.
fn io_error(path: &Path, err: &std::io::Error) -> InjectError {
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => InjectError::PermissionDenied {
            path: path.to_path_buf(),
            help: discovery::permission_help(discovery::Platform::current()),
        },
        _ => InjectError::Io {
            path: path.to_path_buf(),
            message: err.to_string(),
        },
    }
}

fn remove_dir_all(path: &Path) -> Result<(), InjectError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        // Already gone is the state we wanted.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(io_error(path, &err)),
    }
}

fn rename(from: &Path, to: &Path) -> Result<(), InjectError> {
    if let Err(err) = fs::rename(from, to) {
        return Err(io_error(from, &err));
    }
    Ok(())
}

/// Write a file atomically: a sibling temporary, then a rename over the target.
///
/// The temporary name is derived from the target, so it is always on the same
/// filesystem and the rename is genuinely atomic. A crash leaves at most one
/// `*.syncord-tmp` file, which the next run removes.
fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), InjectError> {
    let mut name = target
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(TMP_SUFFIX);
    let tmp = target.with_file_name(name);

    {
        let mut file = fs::File::create(&tmp).map_err(|err| io_error(&tmp, &err))?;
        file.write_all(bytes).map_err(|err| io_error(&tmp, &err))?;
        file.sync_all().map_err(|err| io_error(&tmp, &err))?;
    }

    if let Err(err) = fs::rename(&tmp, target) {
        // The rename is the atomic step; if it fails the temporary is
        // meaningless, so it is removed rather than left for the next run.
        let _ = fs::remove_file(&tmp);
        return Err(io_error(target, &err));
    }
    Ok(())
}

/// Confirm the install still looks valid, and return its canonical resources
/// directory.
///
/// This is the gate every entry point passes through first. `Install` is a
/// plain struct, so a caller could construct one by hand pointing anywhere;
/// re-deriving the real path from the filesystem means the value that is about
/// to be written to is one this crate just confirmed contains a Discord asar.
fn confirm(install: &Install) -> Result<PathBuf, InjectError> {
    let resources = discovery::validate_install(install).map_err(|err| match err {
        discovery::DiscoveryError::Io { path, message } => {
            InjectError::NotAnInstall(format!("{}: {message}", path.display()))
        }
        discovery::DiscoveryError::PreferredPathInvalid(path) => {
            InjectError::NotAnInstall(format!("{} is not a Discord install", path.display()))
        }
        other => InjectError::NotAnInstall(other.to_string()),
    })?;
    Ok(resources)
}

/// Recover from an interrupted previous run.
///
/// Called before every operation. Two leftovers can survive a crash:
///
/// * **`.syncord-staging`** — a partially copied payload. Always garbage: the
///   payload is re-staged from the verified source on every run.
/// * **`.syncord-rollback`** — the previous install, moved aside between the two
///   renames of a swap. This one needs care, because its meaning depends on
///   whether the swap finished:
///
///   * `app` **present** → the swap completed and the rollback copy is stale.
///     Safe to discard.
///   * `app` **absent** → the crash happened *between* the renames, so the
///     rollback directory is the only copy of a working Syncord install.
///     Deleting it would leave the user with a Discord that cannot boot, so it
///     is restored instead.
///
/// Getting this wrong in the other direction is just as bad: leaving a stale
/// rollback in place makes every subsequent `rename` fail with `ENOTEMPTY`, so
/// the Injector would be permanently unable to install anything on that machine.
fn clean_leftovers(resources: &Path) -> Result<(), InjectError> {
    remove_dir_all(&discovery::staging_dir(resources))?;

    let app_dir = resources.join("app");
    let rollback = discovery::rollback_dir(resources);
    if rollback.is_dir() {
        if app_dir.is_dir() {
            remove_dir_all(&rollback)?;
        } else {
            rename(&rollback, &app_dir)?;
        }
    }

    // A Discord update can restore app.asar while the old _app.asar remains.
    // Recover an interrupted backup rotation without deleting the only original.
    let asar_rollback = resources.join(ASAR_ROLLBACK);
    if asar_rollback.exists() {
        let backup = resources.join("_app.asar");
        if !backup.exists() {
            rename(&asar_rollback, &backup)?;
        } else {
            fs::remove_file(&asar_rollback).map_err(|err| io_error(&asar_rollback, &err))?;
        }
    }

    // A temporary file is a partial, uninterleavable write. Whatever survived is
    // worthless on its own.
    for name in bundle_names() {
        let mut tmp_name = name.to_string();
        tmp_name.push_str(TMP_SUFFIX);
        let _ = fs::remove_file(app_dir.join(tmp_name));
    }
    Ok(())
}

/// Install a verified payload directory into a Discord install.
///
/// `payload_dir` is re-verified here rather than trusted, because the gap
/// between "verified" and "written" is exactly where a bug would become a
/// compromised client. Verification and mutation are separate steps, so a
/// failure can never leave a half-installed client.
///
/// `verifier` is passed in rather than constructed so the trust boundary is
/// visible at the call site. It cannot be forged: [`Verifier`] has no public
/// constructor other than [`Verifier::embedded`], so the only value a caller can
/// obtain is one bound to the key this binary was built with.
pub fn inject(
    install: &Install,
    payload_dir: &Path,
    verifier: &Verifier,
) -> Result<InjectOutcome, InjectError> {
    let resources = confirm(install)?;

    // Verify the source before touching the install at all.
    verifier.verify_install(payload_dir)?;

    // The version stamp is read from the payload and carried to the end, where
    // it is written. Reading it from the payload rather than taking it as an
    // argument means the number in the install is necessarily the one that
    // describes the bundles beside it — passing it in would let a caller stamp
    // 1.4.0 onto a 1.2.0 payload, and since the stamp is display-only nothing
    // downstream would catch it.
    //
    // It is read *here*, before any write, so a payload with no stamp is
    // refused while refusing is still free. Discovering it after the swap would
    // mean an install that exists but cannot describe itself.
    let version = verify::read_version_stamp(payload_dir)
        .ok_or(InjectError::NotVerified(VerifyError::VersionStampMissing))?;

    let app_dir = resources.join("app");
    let staging = discovery::staging_dir(&resources);
    let rollback = discovery::rollback_dir(&resources);

    // Windows may replace a file with a directory during rename. Refuse a
    // conflicting destination before rotating either Discord original.
    if app_dir.exists() && !app_dir.is_dir() {
        return Err(InjectError::NotAnInstall(format!(
            "{} exists but is not an app directory",
            app_dir.display()
        )));
    }
    clean_leftovers(&resources)?;

    // Stage: a copy, so a failure part way through leaves the source intact
    // and the install untouched. The destination root is created explicitly —
    // a payload has no subdirectories, so `copy_dir` would otherwise never
    // create it and the first file copy would fail.
    remove_dir_all(&staging)?;
    fs::create_dir_all(&staging).map_err(|err| io_error(&staging, &err))?;
    copy_dir(payload_dir, &staging)?;

    // Verify the *copy*, not the source. This is what will actually be
    // installed, and it is the last point at which a refusal is free.
    if let Err(err) = verifier.verify_install(&staging) {
        let _ = remove_dir_all(&staging);
        return Err(InjectError::NotVerified(err));
    }

    // Write the entry point and version before the swap, while failure still
    // leaves the live install untouched.
    write_atomic(
        &staging.join(verify::PACKAGE_JSON_NAME),
        &verify::package_json_bytes(),
    )?;
    write_atomic(
        &staging.join(verify::VERSION_FILE),
        &verify::version_stamp_bytes(&version),
    )?;

    // If Discord restored app.asar, Electron would ignore resources/app.
    // Rotate the old backup first and preserve the current Discord original;
    // both renames can be undone if installing the staged payload fails.
    let original = resources.join("app.asar");
    let backup = resources.join("_app.asar");
    let asar_rollback = resources.join(ASAR_ROLLBACK);
    let asar_renamed = original.exists();
    let had_backup = backup.exists();

    if asar_renamed {
        if had_backup {
            if let Err(err) = rename(&backup, &asar_rollback) {
                let _ = remove_dir_all(&staging);
                return Err(err);
            }
        }
        if let Err(err) = rename(&original, &backup) {
            if had_backup {
                rename(&asar_rollback, &backup).map_err(|restore| InjectError::RollbackFailed {
                    path: resources.clone(),
                    message: restore.to_string(),
                })?;
            }
            let _ = remove_dir_all(&staging);
            return Err(err);
        }
    } else if !had_backup {
        let _ = remove_dir_all(&staging);
        return Err(InjectError::NotAnInstall(
            resources.to_string_lossy().into_owned(),
        ));
    }

    // ── The swap ─────────────────────────────────────────────────────────────
    let had_app = app_dir.is_dir();
    if had_app {
        if let Err(err) = rename(&app_dir, &rollback) {
            // Undo the asar rename; nothing else has happened yet.
            if asar_renamed {
                restore_asar(&resources, had_backup)?;
            }
            let _ = remove_dir_all(&staging);
            return Err(err);
        }
    }

    if let Err(err) = rename(&staging, &app_dir) {
        // Put the previous install back. If this fails the user has a broken
        // client and must be told so plainly.
        let restored = if had_app {
            rename(&rollback, &app_dir).is_ok()
        } else {
            true
        };
        if !restored {
            return Err(InjectError::RollbackFailed {
                path: app_dir,
                message: "the previous Syncord directory could not be restored".to_string(),
            });
        }
        if asar_renamed {
            restore_asar(&resources, had_backup)?;
        }
        let _ = remove_dir_all(&staging);
        return Err(err);
    }

    // Committed. Only now is it safe to discard the old copy.
    if had_app {
        let _ = remove_dir_all(&rollback);
    }

    if had_backup && asar_renamed {
        let _ = fs::remove_file(&asar_rollback);
    }

    Ok(if had_app {
        InjectOutcome::Replaced
    } else {
        InjectOutcome::FreshInstall
    })
}

fn restore_asar(resources: &Path, had_backup: bool) -> Result<(), InjectError> {
    let restore = || -> Result<(), InjectError> {
        rename(&resources.join("_app.asar"), &resources.join("app.asar"))?;
        if had_backup {
            rename(&resources.join(ASAR_ROLLBACK), &resources.join("_app.asar"))?;
        }
        Ok(())
    };
    restore().map_err(|err| InjectError::RollbackFailed {
        path: resources.to_path_buf(),
        message: err.to_string(),
    })
}

/// Refresh the bundles of an install that is already injected.
///
/// For a reachable loader this never moves `resources/app` aside. Each file
/// is replaced atomically, and matching files are left alone. If Discord has
/// restored its original startup file, this delegates to [`inject`] to repair
/// the loader before updating any bundles.
pub fn update(
    install: &Install,
    payload_dir: &Path,
    verifier: &Verifier,
) -> Result<InjectOutcome, InjectError> {
    let resources = confirm(install)?;

    verifier.verify_install(payload_dir)?;

    // The version stamp is read from the payload and carried to the end, where
    // it is written. Reading it from the payload rather than taking it as an
    // argument means the number in the install is necessarily the one that
    // describes the bundles beside it — passing it in would let a caller stamp
    // 1.4.0 onto a 1.2.0 payload, and since the stamp is display-only nothing
    // downstream would catch it.
    //
    // It is read *here*, before any write, so a payload with no stamp is
    // refused while refusing is still free. Discovering it after the swap would
    // mean an install that exists but cannot describe itself.
    let version = verify::read_version_stamp(payload_dir)
        .ok_or(InjectError::NotVerified(VerifyError::VersionStampMissing))?;

    // Recover from an interrupted previous run *before* deciding whether
    // Syncord is installed. A crash mid-swap leaves the working install in the
    // rollback directory with no `resources/app`, so checking first would report
    // "not installed" and tell the user to use Inject for a client that is
    // actually fine.
    clean_leftovers(&resources)?;

    let app_dir = resources.join("app");
    if !app_dir.is_dir() {
        return Err(InjectError::NotAnInstall(
            "Syncord is not installed here; use Inject instead".to_string(),
        ));
    }

    if !launch_ready(&resources) {
        // Updating bundles alone cannot repair Electron's startup path.
        return inject(install, payload_dir, verifier);
    }

    // Verify what is currently installed. Refusing to overwrite an install
    // whose own manifest does not verify would be a downgrade: whatever is
    // there now was signed, and the new one is signed too, so there is no
    // reason to prefer one silently.
    verifier.verify_install(&app_dir)?;

    for name in bundle_names() {
        let from = payload_dir.join(name);
        let to = app_dir.join(name);
        let new_bytes = fs::read(&from).map_err(|err| io_error(&from, &err))?;
        let same = fs::read(&to).map(|old| old == new_bytes).unwrap_or(false);
        if same {
            continue;
        }
        write_atomic(&to, &new_bytes)?;
    }

    // The manifest goes **last**, and it is not optional.
    //
    // It was, once, and the live end-to-end test caught it: the three bundles
    // were replaced while the *old* manifest stayed behind, so the install was
    // left permanently unverifiable — new bytes, old digests — and the user
    // would have been told "could not be verified" with no way to fix it short
    // of reinstalling by hand.
    //
    // Writing it last is what makes that safe: a crash between the bundles and
    // the manifest leaves a mismatch, which reads as "unverified" and prompts
    // another update. The reverse order would leave a manifest promising
    // digests the files no longer have, which is the same failure reached by a
    // different route.
    write_atomic(
        &app_dir.join(verify::MANIFEST_NAME),
        &fs::read(payload_dir.join(verify::MANIFEST_NAME))
            .map_err(|err| io_error(&payload_dir.join(verify::MANIFEST_NAME), &err))?,
    )?;

    write_atomic(
        &app_dir.join(verify::PACKAGE_JSON_NAME),
        &verify::package_json_bytes(),
    )?;

    write_atomic(
        &app_dir.join(verify::VERSION_FILE),
        &verify::version_stamp_bytes(&version),
    )?;

    Ok(InjectOutcome::Updated)
}

/// Remove Syncord and restore Discord's own asar.
///
/// Mirrors `uninject` in `scripts/inject.mjs`: the directory goes, and
/// `_app.asar` becomes `app.asar` again — but only when `app.asar` is not
/// already there. Restoring over a present original would destroy Discord's
/// own file, so the backup is left in place instead.
pub fn uninject(install: &Install) -> Result<InjectOutcome, InjectError> {
    let resources = confirm(install)?;

    clean_leftovers(&resources)?;

    let app_dir = resources.join("app");
    let original = resources.join("app.asar");
    let backup = resources.join("_app.asar");

    remove_dir_all(&app_dir)?;

    if backup.exists() && !original.exists() {
        rename(&backup, &original)?;
    }

    Ok(InjectOutcome::Uninstalled)
}

/// The Syncord version installed in an install, if it can be determined.
///
/// Read from the version stamp the Injector wrote, validated by
/// [`verify::read_version_stamp`]. `None` means "cannot tell" — either there is
/// no Syncord here, or the install predates the stamp, or the stamp is
/// malformed. All three are reported the same way, and the GUI shows "unknown"
/// rather than guessing.
///
/// A second call exists for a stronger answer: [`verify_install`] over
/// `resources/app` proves the bundles match a signed manifest. The GUI does that
/// once at startup and can therefore say both *which* version and *whether this
/// install is intact*, which is the pair a user actually needs.
#[must_use]
pub fn installed_version(resources: &Path) -> Option<String> {
    verify::read_version_stamp(&resources.join("app"))
}

/// A short, stable fingerprint of what is installed, for the GUI.
///
/// The first 12 hex characters of the signed `renderer.js` digest. It answers
/// "is this the same build that was here a minute ago?" without pretending to
/// be a version, which the stamp is for.
#[must_use]
pub fn installed_fingerprint(resources: &Path) -> Option<String> {
    let raw = fs::read(resources.join("app").join(verify::MANIFEST_NAME)).ok()?;
    let manifest: verify::Manifest = serde_json::from_slice(&raw).ok()?;
    let digest = manifest
        .files
        .iter()
        .find(|entry| entry.name == "renderer.js")
        .map(|entry| entry.sha256.as_str())?;
    Some(digest[..12.min(digest.len())].to_string())
}

/// The payload that ships beside the Injector executable.
///
/// A release archive contains both the Injector and the `dist/` bundles, so a
/// user who downloaded the Injector already has everything needed to install —
/// which is what makes "one click" true rather than aspirational.
///
/// Returned **unverified**. The caller must pass it through
/// [`Verifier::verify_install`] before anything is written; the Injector does
/// that, and so must any other caller, because a path returned by this function
/// has only been *found*, not trusted.
///
/// The name is a fixed constant and the parent is the executable's own
/// directory, so nothing here is influenced by the archive's contents.
///
/// Three layouts are tried, in order, because "beside the executable" is
/// ambiguous once the executable is inside a bundle:
///
///   1. `<exe dir>/payload` — a bare binary next to its payload. Windows and
///      Linux release artifacts, and `cargo run`.
///   2. `<exe dir>/../Resources/payload` — inside a macOS `.app`, where the
///      executable is at `Contents/MacOS/` and bundled resources live at
///      `Contents/Resources/`. This is the one inside the code-signed part of
///      the bundle.
///   3. `<exe dir>/../../../payload` — beside the `.app` in an extracted
///      release archive (`Contents/MacOS/../../../` is the archive root).
///
/// Every candidate is a fixed relative hop from `current_exe()`. Nothing here
/// is influenced by the archive's contents, by an environment variable, or by
/// anything a caller supplies, so this remains a *lookup* rather than a path
/// input — and the payload is signature-checked before use regardless of which
/// one matched.
#[must_use]
pub fn bundled_payload_dir() -> Option<std::path::PathBuf> {
    payload_dir_for_exe(&std::env::current_exe().ok()?)
}

/// The candidate layouts, for a given executable path.
///
/// Split out from [`bundled_payload_dir`] so the *ordering* can be tested. The
/// order is the security-relevant part: a `payload/` next to the executable wins
/// over one inside the bundle, and a caller that drops a directory beside a
/// running binary gets it used — which is a deliberate property, not an
/// oversight, because that layout is the portable release artifact. What the
/// candidate *cannot* do is skip verification.
///
/// `pub(crate)` rather than private so `tests::inject` can exercise the
/// ordering against real directories. It is not part of the public surface, and
/// the public entry point is still `bundled_payload_dir`.
pub(crate) fn payload_dir_for_exe(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;

    let candidates = [
        dir.join("payload"),
        dir.join("../Resources/payload"),
        dir.join("../../../payload"),
    ];

    candidates.into_iter().find(|candidate| candidate.is_dir())
}

/// Recursively copy a directory tree, refusing anything that is not a file or a
/// directory.
///
/// A symlink encountered during the copy is an error rather than a copy: the
/// source has already been verified as exactly five regular files, so a link
/// here means something is wrong that should stop the operation.
fn copy_dir(from: &Path, to: &Path) -> Result<(), InjectError> {
    let entries = fs::read_dir(from).map_err(|err| io_error(from, &err))?;

    for entry in entries {
        let entry = entry.map_err(|err| io_error(from, &err))?;
        let file_type = entry
            .file_type()
            .map_err(|err| io_error(&entry.path(), &err))?;

        let target = to.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(InjectError::Io {
                path: entry.path(),
                message: "the verified payload contains a symbolic link".to_string(),
            });
        }
        if file_type.is_dir() {
            fs::create_dir_all(&target).map_err(|err| io_error(&target, &err))?;
            copy_dir(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|err| io_error(&target, &err))?;
        } else {
            return Err(InjectError::Io {
                path: entry.path(),
                message: "the verified payload contains a non-regular file".to_string(),
            });
        }
    }
    Ok(())
}
