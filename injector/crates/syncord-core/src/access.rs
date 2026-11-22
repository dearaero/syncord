//! Why a write to a Discord install was refused, and what the user should do.
//!
//! ── Why this exists ──────────────────────────────────────────────────────────
//!
//! Injecting into `/Applications/Discord.app/Contents/Resources` fails on a
//! stock macOS machine for a reason that has nothing to do with file
//! permissions, and the guidance that used to be shown was wrong about it in
//! three separate ways. It said to run `sudo pnpm inject` (a command for the
//! Electron client, in a window that is not the Electron client, elevating a
//! process that elevation cannot help), and it pointed at Full Disk Access
//! (a different TCC service, which does not grant this).
//!
//! What actually happens is macOS **App Management**, introduced in macOS 13: a
//! process is not allowed to modify *another* application's bundle unless the
//! user has granted it. The refusal arrives as `EPERM`.
//!
//! ── Why the diagnosis is measured, not inferred ─────────────────────────────
//!
//! The obvious cheap test is `access(path, W_OK)`, and on this exact case it is
//! actively misleading. Measured on macOS 15, against an install the user owns
//! and whose directory mode is `drwxr-xr-x`:
//!
//! ```text
//! access(W_OK) on Resources  -> -1   (denied)
//! fs::write("…/probe")       -> ok
//! ```
//!
//! `access()` consults the real uid/gid and TCC's view of the caller; the write
//! path is what actually decides. Trusting `access()` would have produced a
//! confident wrong answer. So the only test here is a real one: create a file,
//! then remove it.
//!
//! That does mean touching the user's Discord bundle to ask a question about
//! it. It is the smallest possible touch — one empty file, created and deleted
//! immediately, named so a survivor is recognisable — and the alternative is
//! guessing. The probe name is `.syncord-write-probe`; [`inject`] treats any
//! `.syncord-*` leftover as garbage, so a probe that survives a kill is cleaned
//! up on the next run.
//!
//! ── What this module does not do ─────────────────────────────────────────────
//!
//! It does not fix anything. Granting a permission is the user's decision,
//! through System Settings, and nothing here can or should make it on their
//! behalf. What it does is stop telling them to do something that cannot work.

use std::fs;
use std::io;
use std::path::Path;

use crate::discovery::Platform;

/// The name of the file the probe creates.
///
/// Dot-prefixed so it sorts out of the way, and `syncord`-prefixed so that it is
/// unambiguously ours if a kill lands between create and remove.
const PROBE_NAME: &str = ".syncord-write-probe";

/// What a write to an install can be refused for.
///
/// The variants are *causes*, not symptoms, because the cause is what determines
/// what the user should do next. "Permission denied" alone cannot tell apart
/// "macOS will not let this app touch another app's bundle" from "the
/// directory is owned by root", and those two have nothing in common as fixes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteAccess {
    /// A write succeeded. Whatever went wrong, it was not write access.
    Writable,
    /// macOS refused with `EPERM`: this process may not modify another
    /// application's bundle. Fixed in System Settings, not at the terminal.
    AppManagement,
    /// The directory's own mode or ownership forbids writing. The installer was
    /// installed by someone else and is not ours to change.
    DirectoryPermissions,
    /// The volume is mounted read-only.
    ReadOnlyVolume,
    /// The install is not there any more.
    Missing,
    /// Refused, and not in a way this module can name.
    Unknown,
}

impl WriteAccess {
    /// The name sent to the frontend.
    ///
    /// A short identifier rather than prose, so the frontend can switch on it and
    /// the wording stays in one place.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Writable => "writable",
            Self::AppManagement => "appManagement",
            Self::DirectoryPermissions => "directoryPermissions",
            Self::ReadOnlyVolume => "readOnlyVolume",
            Self::Missing => "missing",
            Self::Unknown => "unknown",
        }
    }

    /// Whether the user has to change something before this can succeed.
    ///
    /// `Writable` and `Unknown` are not treated as blocked. An unrecognised
    /// refusal is a reason to *try*, not a reason to disable the button: the
    /// alternative is a window that refuses to do something it might well be
    /// able to do, with no explanation.
    #[must_use]
    pub fn is_blocked(self) -> bool {
        matches!(
            self,
            Self::AppManagement | Self::DirectoryPermissions | Self::ReadOnlyVolume | Self::Missing
        )
    }
}

/// Measure whether this process can write to an install's resources directory.
///
/// Creates [`PROBE_NAME`] and removes it. On a refusal the file was never
/// created, so there is nothing to clean up.
#[must_use]
pub fn probe(resources: &Path, platform: Platform) -> WriteAccess {
    if !resources.is_dir() {
        return WriteAccess::Missing;
    }

    let probe = resources.join(PROBE_NAME);
    match fs::File::create(&probe) {
        Ok(file) => {
            // Drop before removing: on Windows an open handle makes the removal
            // fail, and this runs on Windows too.
            drop(file);
            // A failure here is not a write-access problem, and the next probe
            // overwrites the same name, so it is not worth reporting.
            let _ = fs::remove_file(&probe);
            WriteAccess::Writable
        }
        Err(err) => classify(&err, platform),
    }
}

/// Map an `errno` onto a cause.
///
/// `pub(crate)` rather than private only so the errno table can be tested with
/// real `errno` values. Arranging a read-only directory does not produce
/// `EACCES` when the tests run as root, so a test that provoked the refusals for
/// real would silently assert the wrong thing on exactly the machines that run
/// in containers.
///
/// The `EPERM` case is the one worth reading closely. On macOS a write refused
/// with `EPERM` is, for a bundled application, the App Management protection.
/// It is not the *only* thing that can produce `EPERM` — an immutable flag on
/// the directory does too — so this names the overwhelmingly common cause
/// rather than claiming certainty, and the guidance it produces is a step the
/// user can take and verify rather than a diagnosis they must trust.
pub(crate) fn classify(err: &io::Error, platform: Platform) -> WriteAccess {
    match err.raw_os_error() {
        // EPERM. Distinguished from EACCES because the two have different fixes,
        // and on macOS only this one is the system policy rather than the mode
        // bits.
        Some(1) if platform == Platform::MacOs => WriteAccess::AppManagement,
        // EACCES: mode bits or ownership. Not a macOS system policy.
        Some(13) => WriteAccess::DirectoryPermissions,
        // EROFS
        Some(30) => WriteAccess::ReadOnlyVolume,
        // ENOENT
        Some(2) => WriteAccess::Missing,
        _ => WriteAccess::Unknown,
    }
}

/// A settings pane the window knows how to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsPane {
    /// The whole Privacy & Security section.
    Privacy,
    /// App Management, which is what gates modifying another app's bundle.
    AppManagement,
}

/// The deep link for a pane, or `None` where the platform has no such thing.
///
/// The anchor is a weak point: `Privacy_AppManagement` is the name widely
/// published, but it is **not present** on current macOS — `Privacy_AppBundles`
/// is, and the two are not interchangeable. So the anchor that exists on the
/// machine in front of the user is the one used here, and the guidance text
/// always carries the human path as well, so that a version where even that
/// anchor has moved still leaves the user able to get there by hand.
#[must_use]
pub fn pane_url(pane: SettingsPane, platform: Platform) -> Option<String> {
    if platform != Platform::MacOs {
        return None;
    }
    let anchor = match pane {
        SettingsPane::Privacy => "Privacy",
        SettingsPane::AppManagement => "Privacy_AppBundles",
    };
    Some(format!(
        "x-apple.systempreferences:com.apple.preference.security?{anchor}"
    ))
}

/// The pane that solves this refusal, if one does.
#[must_use]
pub fn pane_for(access: WriteAccess) -> Option<SettingsPane> {
    match access {
        WriteAccess::AppManagement => Some(SettingsPane::AppManagement),
        _ => None,
    }
}

/// What to tell the user, in terms of what they can actually do.
///
/// Deliberately does not contain a command to run. Elevating does not grant a
/// TCC permission — the permission is granted to a *bundle identity* through
/// System Settings, and `sudo` would change which process was asking rather
/// than what it is allowed to ask for. The previous text suggested otherwise and
/// sent users to run an unrelated command as root.
#[must_use]
pub fn remedy(access: WriteAccess, platform: Platform) -> String {
    match (access, platform) {
        (WriteAccess::AppManagement, _) => concat!(
            "macOS has not allowed this app to change the Discord application.\n\n",
            "Open System Settings, then Privacy & Security, then App Management, and ",
            "turn on \"Syncord Injector\". If it is not listed, press Inject once more ",
            "so macOS offers to add it.\n\n",
            "Full Disk Access is a different permission and does not cover this. ",
            "Running something as an administrator does not help either: the ",
            "permission belongs to this application, not to the account."
        )
        .to_string(),
        (WriteAccess::DirectoryPermissions, _) => concat!(
            "This Discord was installed by another account, so this one cannot ",
            "write to it.\n\n",
            "Install Discord again from this account, or change the owner of ",
            "/Applications/Discord.app. Either is a deliberate act; the Injector ",
            "will not do it for you."
        )
        .to_string(),
        (WriteAccess::ReadOnlyVolume, _) => {
            "The volume holding Discord is mounted read-only, so nothing can be \
             written to it."
                .to_string()
        }
        (WriteAccess::Missing, _) => {
            "This Discord is no longer at the path it was found at.".to_string()
        }
        (WriteAccess::Writable, _) => "This Discord can be written to.".to_string(),
        (WriteAccess::Unknown, platform) => {
            if platform == Platform::Windows {
                "The write was refused for a reason the Injector could not name. \
                 If Discord is outside your user folder, try again from an \
                 elevated terminal running the command line tool."
                    .to_string()
            } else {
                "The write was refused for a reason the Injector could not name.".to_string()
            }
        }
    }
}
