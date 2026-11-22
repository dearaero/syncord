//! Tests for the write-access diagnosis.
//!
//! The interesting assertions here are about what the probe does to a
//! directory, not only about what it returns. A diagnosis that leaves a file
//! behind in someone's Discord bundle is worse than no diagnosis, and the test
//! for that is "the directory is exactly as it was", checked by listing it.

use std::fs;
use std::io;

use crate::access::{classify, pane_for, pane_url, probe, remedy, SettingsPane, WriteAccess};
use crate::discovery::Platform;
use crate::testsupport::TempDir;

/// A temporary directory standing in for a Discord `Resources` directory.
fn resources() -> TempDir {
    TempDir::new("access")
}

#[test]
fn a_writable_directory_probes_writable_and_leaves_nothing_behind() {
    let dir = resources();
    let before = listing(dir.path());

    assert_eq!(probe(dir.path(), Platform::Linux), WriteAccess::Writable);

    // The whole point: the probe must not be observable afterwards.
    assert_eq!(
        listing(dir.path()),
        before,
        "the probe left something behind"
    );
}

#[test]
fn a_directory_that_does_not_exist_is_missing_rather_than_unknown() {
    let dir = resources();
    let absent = dir.path().join("nope");
    assert_eq!(probe(&absent, Platform::Linux), WriteAccess::Missing);
}

/// The classification is pure, so it can be tested with real `errno` values
/// instead of a filesystem arranged to produce them. Arranging a read-only
/// directory as root — which is what these tests often run as — does not produce
/// `EACCES` at all, so a test that tried to provoke the refusal for real would
/// silently assert the wrong thing.
#[test]
fn errno_maps_onto_the_cause_that_has_a_different_fix() {
    let cases: &[(i32, Platform, WriteAccess)] = &[
        // EPERM on macOS is the system policy; the same errno elsewhere is not
        // given that name, because a Windows EPERM is something else entirely.
        (1, Platform::MacOs, WriteAccess::AppManagement),
        (1, Platform::Windows, WriteAccess::Unknown),
        (1, Platform::Linux, WriteAccess::Unknown),
        // EACCES is the mode bits, on every platform.
        (13, Platform::MacOs, WriteAccess::DirectoryPermissions),
        (13, Platform::Windows, WriteAccess::DirectoryPermissions),
        (30, Platform::MacOs, WriteAccess::ReadOnlyVolume),
        (2, Platform::MacOs, WriteAccess::Missing),
        (5, Platform::MacOs, WriteAccess::Unknown),
    ];

    for (errno, platform, expected) in cases {
        let err = io::Error::from_raw_os_error(*errno);
        assert_eq!(
            classify(&err, *platform),
            *expected,
            "errno {errno} on {platform:?}"
        );
    }
}

#[test]
fn only_causes_the_user_can_act_on_block_the_action() {
    assert!(WriteAccess::AppManagement.is_blocked());
    assert!(WriteAccess::DirectoryPermissions.is_blocked());
    assert!(WriteAccess::ReadOnlyVolume.is_blocked());
    assert!(WriteAccess::Missing.is_blocked());

    // Not blocked. An unrecognised refusal is a reason to try, not a reason to
    // disable the button — the alternative is a window that refuses to do
    // something it may be perfectly able to do, and says nothing about why.
    assert!(!WriteAccess::Writable.is_blocked());
    assert!(!WriteAccess::Unknown.is_blocked());
}

#[test]
fn every_variant_has_a_name_the_frontend_can_switch_on() {
    let all = [
        WriteAccess::Writable,
        WriteAccess::AppManagement,
        WriteAccess::DirectoryPermissions,
        WriteAccess::ReadOnlyVolume,
        WriteAccess::Missing,
        WriteAccess::Unknown,
    ];
    let mut names: Vec<&str> = all.iter().map(|v| v.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), all.len(), "two variants share a name");
    for variant in all {
        assert!(!variant.as_str().is_empty());
    }
}

#[test]
fn the_settings_link_is_macos_only_and_uses_an_anchor_that_exists() {
    assert!(
        pane_url(SettingsPane::Privacy, Platform::Windows).is_none(),
        "Windows has no such pane, and a URL that goes nowhere is worse than none"
    );
    assert!(pane_url(SettingsPane::AppManagement, Platform::Linux).is_none());

    let mac =
        pane_url(SettingsPane::AppManagement, Platform::MacOs).expect("macOS has privacy settings");
    assert!(mac.starts_with("x-apple.systempreferences:"));
    assert!(
        mac.ends_with("?Privacy_AppBundles"),
        "the anchor must be one that exists on the machine: {mac}"
    );

    // The widely published `Privacy_AppManagement` is not present on current
    // macOS. If it ever comes back this is the assertion to revisit, and the
    // comment is the record of why it was written.
    assert!(!mac.contains("Privacy_AppManagement"));
}

#[test]
fn the_deep_link_constant_matches_what_the_scheme_registration_supports() {
    // `x-apple.systempreferences` is registered by System Settings itself. If a
    // future macOS renames it, this is the string that has to change, and this
    // is the place that will say so.
    let url = pane_url(SettingsPane::Privacy, Platform::MacOs).expect("macOS has privacy settings");
    let scheme = url.split(':').next().expect("a url has a scheme");
    assert_eq!(scheme, "x-apple.systempreferences");
}

#[test]
fn only_app_management_has_a_pane_to_open() {
    assert_eq!(
        pane_for(WriteAccess::AppManagement),
        Some(SettingsPane::AppManagement)
    );
    // Nothing else has a settings pane behind it. Pointing a user at App
    // Management because their install is owned by root would send them to a
    // screen that cannot possibly help.
    for access in [
        WriteAccess::Writable,
        WriteAccess::DirectoryPermissions,
        WriteAccess::ReadOnlyVolume,
        WriteAccess::Missing,
        WriteAccess::Unknown,
    ] {
        assert_eq!(pane_for(access), None, "{access:?} has no pane");
    }
}

#[test]
fn the_remedy_for_app_management_is_the_setting_and_not_a_command() {
    let text = remedy(WriteAccess::AppManagement, Platform::MacOs);
    assert!(text.contains("App Management"), "{text}");
    assert!(
        text.contains("Syncord Injector"),
        "it must name the app to look for: {text}"
    );
    assert!(text.contains("Privacy & Security"), "{text}");

    // The specific falsehood this replaces: that Full Disk Access is the fix,
    // and that running something as an administrator grants it.
    assert!(!text.contains("sudo"), "{text}");
    assert!(!text.contains("pnpm"), "{text}");
}

#[test]
fn every_refusal_has_something_to_say() {
    for access in [
        WriteAccess::Writable,
        WriteAccess::AppManagement,
        WriteAccess::DirectoryPermissions,
        WriteAccess::ReadOnlyVolume,
        WriteAccess::Missing,
        WriteAccess::Unknown,
    ] {
        for platform in [
            Platform::MacOs,
            Platform::Windows,
            Platform::Linux,
            Platform::Other,
        ] {
            let text = remedy(access, platform);
            assert!(
                !text.trim().is_empty(),
                "{access:?} on {platform:?} says nothing"
            );
        }
    }
}

#[test]
fn no_remedy_suggests_running_something_as_administrator() {
    for access in [
        WriteAccess::Writable,
        WriteAccess::AppManagement,
        WriteAccess::DirectoryPermissions,
        WriteAccess::ReadOnlyVolume,
        WriteAccess::Missing,
        WriteAccess::Unknown,
    ] {
        let text = remedy(access, Platform::MacOs).to_lowercase();
        for forbidden in ["sudo", "pnpm", "chown", "osascript"] {
            assert!(
                !text.contains(forbidden),
                "{access:?} remedy suggests {forbidden:?}: {text}"
            );
        }
    }
}

fn listing(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("the fixture directory should be readable")
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
