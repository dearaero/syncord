//! Behaviour tests for [`crate::discovery`].
//!
//! The reference is `scripts/lib/discordInstalls.mjs`. The two implementations
//! must agree, because a divergence means the CLI (`pnpm inject`) and the GUI
//! (this crate) would target *different* Discord installations — the kind of bug
//! that only shows up on a machine that has both Stable and Canary installed, and
//! only when the user picks the wrong one.
//!
//! Every test here runs against a temporary tree, never against the real
//! `/Applications` or `%LOCALAPPDATA%`.

use std::cmp::Ordering;

use super::super::discovery::{
    compare_versions, find_installs, has_asar, install_candidates, permission_help, resources_in,
    validate_install, Branch, DiscoveryEnv, DiscoveryError, Install, Platform,
};
use crate::testsupport::{make_discord_install, TempDir};

// ── Version ordering ──────────────────────────────────────────────────────────

#[test]
fn app_folder_versions_sort_numerically_not_lexically() {
    // Windows keeps superseded `app-<version>` folders behind. A lexical sort
    // would pick `app-0.0.9` over `app-0.0.10` and inject into a stale build,
    // which fails in a way that looks like a Discord bug.
    assert_eq!(compare_versions("0.0.10", "0.0.9"), Ordering::Greater);
    assert_eq!(compare_versions("0.0.9", "0.0.10"), Ordering::Less);
    assert_eq!(compare_versions("1.2.3", "1.2.3"), Ordering::Equal);
    assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
    assert_eq!(compare_versions("0.0.413", "0.0.100"), Ordering::Greater);
}

#[test]
fn non_numeric_version_parts_become_zero_like_the_javascript() {
    // `parseInt(part, 10) || 0` in the JavaScript. Matching it exactly means a
    // folder named `app-beta` sorts as `0` rather than throwing or being
    // skipped.
    assert_eq!(compare_versions("beta", "0"), Ordering::Equal);
    assert_eq!(compare_versions("3-beta", "3"), Ordering::Equal);
    assert_eq!(compare_versions("", "0"), Ordering::Equal);
}

// ── resourcesIn ───────────────────────────────────────────────────────────────

#[test]
fn a_resources_folder_is_recognised_by_either_asar_name() {
    let temp = TempDir::new("asar");

    let original = temp.dir("original");
    std::fs::write(original.join("app.asar"), b"x").unwrap();
    assert!(has_asar(&original));
    assert_eq!(resources_in(&original), Some(original.clone()));

    // After an injection Discord's asar is `_app.asar`, and that must still
    // count — otherwise uninjecting would report "not an install".
    let injected = temp.dir("injected");
    std::fs::write(injected.join("_app.asar"), b"x").unwrap();
    assert!(has_asar(&injected));
    assert_eq!(resources_in(&injected), Some(injected.clone()));
}

#[test]
fn a_directory_without_an_asar_is_not_an_install() {
    let temp = TempDir::new("noasar");
    let empty = temp.dir("empty");
    assert!(!has_asar(&empty));
    assert_eq!(resources_in(&empty), None);
    assert_eq!(resources_in(&temp.join("does-not-exist")), None);
}

#[test]
fn a_macos_bundle_and_a_windows_folder_both_resolve() {
    let temp = TempDir::new("shapes");

    let mac = temp.dir("Discord.app");
    let mac_resources = mac.join("Contents").join("Resources");
    std::fs::create_dir_all(&mac_resources).unwrap();
    std::fs::write(mac_resources.join("app.asar"), b"x").unwrap();
    assert_eq!(resources_in(&mac), Some(mac_resources));

    let win = temp.dir("Discord");
    let win_resources = win.join("resources");
    std::fs::create_dir_all(&win_resources).unwrap();
    std::fs::write(win_resources.join("app.asar"), b"x").unwrap();
    assert_eq!(resources_in(&win), Some(win_resources));
}

#[test]
fn the_newest_app_folder_wins_on_windows() {
    let temp = TempDir::new("newest");
    let root = temp.dir("Discord");

    for version in ["0.0.9", "0.0.10", "0.0.11"] {
        let resources = root.join(format!("app-{version}")).join("resources");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(resources.join("app.asar"), version).unwrap();
    }

    let found = resources_in(&root).expect("an app-* folder must be found");
    // 0.0.11 is the newest; a lexical sort would have chosen 0.0.9.
    assert!(
        found.to_string_lossy().contains("app-0.0.11"),
        "expected the newest app folder, got {}",
        found.display()
    );
}

#[test]
fn an_app_folder_without_an_asar_is_skipped_in_favour_of_an_older_one() {
    // Discord occasionally leaves an `app-*` directory that is not a complete
    // build. Preferring the newest *complete* one is the behaviour the
    // JavaScript has, and the difference is a working install versus a crash.
    let temp = TempDir::new("partial");
    let root = temp.dir("Discord");

    let good = root.join("app-0.0.10").join("resources");
    std::fs::create_dir_all(&good).unwrap();
    std::fs::write(good.join("app.asar"), b"x").unwrap();

    // Newer, but empty.
    std::fs::create_dir_all(root.join("app-0.0.11").join("resources")).unwrap();

    let found = resources_in(&root).expect("the complete install must be found");
    assert!(found.to_string_lossy().contains("app-0.0.10"));
}

// ── Candidate enumeration ─────────────────────────────────────────────────────

#[test]
fn macos_candidates_cover_every_branch_under_both_parents() {
    let temp = TempDir::new("mac");
    let env = DiscoveryEnv {
        platform: Platform::MacOs,
        local_app_data: None,
        home: temp.path().to_path_buf(),
        mac_parents: vec![
            std::path::PathBuf::from("/Applications"),
            temp.join("Applications"),
        ],
        linux_prefixes: vec![],
        flatpak_parents: vec![],
        preferred: None,
    };

    let names: Vec<String> = install_candidates(&env)
        .iter()
        .map(|c| c.root.file_name().unwrap().to_string_lossy().into_owned())
        .collect();

    assert!(names.contains(&"Discord.app".to_string()));
    assert!(names.contains(&"Discord Canary.app".to_string()));
    assert!(names.contains(&"Discord PTB.app".to_string()));
    assert!(names.contains(&"Discord Development.app".to_string()));
    // Each name appears once per parent.
    assert_eq!(names.iter().filter(|n| *n == "Discord.app").count(), 2);
}

#[test]
fn windows_candidates_require_localappdata() {
    // Without it the JavaScript returns early with no candidates, and so do we.
    // Guessing a profile path instead would be inventing a filesystem location.
    let temp = TempDir::new("win-nolocal");
    let env = DiscoveryEnv {
        platform: Platform::Windows,
        local_app_data: None,
        home: temp.path().to_path_buf(),
        mac_parents: vec![],
        linux_prefixes: vec![],
        flatpak_parents: vec![],
        preferred: None,
    };
    assert!(install_candidates(&env).is_empty());

    let env = DiscoveryEnv {
        local_app_data: Some(temp.join("AppData/Local")),
        ..env
    };
    let names: Vec<String> = install_candidates(&env)
        .iter()
        .map(|c| c.root.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(names.contains(&"Discord".to_string()));
    assert!(names.contains(&"DiscordCanary".to_string()));
    assert!(names.contains(&"DiscordPTB".to_string()));
    assert!(names.contains(&"DiscordDevelopment".to_string()));
}

#[test]
fn linux_candidates_cover_prefixes_home_and_flatpak() {
    let temp = TempDir::new("linux");
    let env = DiscoveryEnv {
        platform: Platform::Linux,
        local_app_data: None,
        home: temp.path().to_path_buf(),
        mac_parents: vec![],
        linux_prefixes: vec![temp.join("usr/share"), temp.join("opt")],
        flatpak_parents: vec![temp.join(".local/share/flatpak/app")],
        preferred: None,
    };

    let roots: Vec<String> = install_candidates(&env)
        .iter()
        .map(|c| c.root.to_string_lossy().replace('\\', "/"))
        .collect();

    assert!(roots.iter().any(|r| r.contains("usr/share/discord")));
    assert!(roots.iter().any(|r| r.contains("opt/discord")));
    assert!(
        roots.iter().any(|r| r.contains("extra/discord")),
        "the Flatpak extra path must be searched"
    );
    assert!(roots
        .iter()
        .any(|r| r.contains("com.discordapp.Discord/current/active/files/discord")));
}

#[test]
fn every_candidate_comes_from_a_fixed_table() {
    // The full set of paths the Injector will ever write to is enumerable from
    // this function. No archive, descriptor or file content feeds into it, which
    // is the property that makes "no arbitrary filesystem targets" checkable.
    let temp = TempDir::new("purity");
    for platform in [Platform::MacOs, Platform::Windows, Platform::Linux] {
        let env = DiscoveryEnv::for_platform(platform, temp.path().to_path_buf());
        for candidate in install_candidates(&env) {
            assert!(candidate.root.has_root() || candidate.root.starts_with(temp.path()));
            // Every component is either a known prefix or a branch name.
            let rendered = candidate.root.to_string_lossy();
            assert!(
                !rendered.contains(".."),
                "no candidate may contain a traversal: {rendered}"
            );
        }
    }
}

// ── findInstalls ──────────────────────────────────────────────────────────────

fn mac_env(temp: &TempDir) -> DiscoveryEnv {
    DiscoveryEnv {
        platform: Platform::MacOs,
        local_app_data: None,
        home: temp.path().to_path_buf(),
        mac_parents: vec![temp.join("Applications")],
        linux_prefixes: vec![],
        flatpak_parents: vec![],
        preferred: None,
    }
}

#[test]
fn macos_launcher_layout_is_found_next_to_a_classic_canary() {
    // Discord Stable's macOS launcher (2026-11): /Applications/Discord.app is a
    // stub with launcher.conf and no asar; the real app is the newest
    // ~/Library/Application Support/discord/app-<version>/Discord.app.
    let temp = TempDir::new("mac-launcher");
    let apps = temp.dir("Applications");
    let stub = apps.join("Discord.app").join("Contents").join("Resources");
    std::fs::create_dir_all(&stub).unwrap();
    std::fs::write(stub.join("launcher.conf"), b"channel = \"stable\"").unwrap();
    make_discord_install(&apps, "Discord Canary.app", true);

    let data = temp.dir("Library/Application Support/discord");
    for version in ["0.0.9", "0.0.424"] {
        make_discord_install(&data.join(format!("app-{version}")), "Discord.app", false);
    }
    // A newer folder that is still downloading has no asar and must be skipped.
    std::fs::create_dir_all(data.join("app-0.0.425").join("Discord.app")).unwrap();

    let found = find_installs(&mac_env(&temp)).expect("both installs must be found");
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].branch, Branch::Stable);
    assert!(
        found[0].resources.ends_with("app-0.0.424/Discord.app/Contents/Resources"),
        "{}",
        found[0].resources.display()
    );
    assert_eq!(found[1].branch, Branch::Canary);
    assert!(found[1].injected);
}

#[cfg(unix)]
#[test]
fn macos_launcher_folder_that_cannot_be_listed_is_probed_by_name() {
    // macOS blocks listing Discord Stable's data folder but not reaching paths
    // inside it by name. A mode of 0o311 reproduces that for the current user.
    use std::os::unix::fs::PermissionsExt;
    let temp = TempDir::new("mac-launcher-unlistable");
    temp.dir("Applications");
    let data = temp.dir("Library/Application Support/discord");
    for version in ["0.0.9", "0.0.424"] {
        make_discord_install(&data.join(format!("app-{version}")), "Discord.app", false);
    }
    std::fs::create_dir_all(data.join("app-0.0.425").join("Discord.app")).unwrap();
    let locked = std::fs::Permissions::from_mode(0o311);
    std::fs::set_permissions(&data, locked).unwrap();
    let listable = std::fs::read_dir(&data).is_ok();

    let found = find_installs(&mac_env(&temp));
    std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
    if listable {
        return; // running as root: the lock cannot be reproduced
    }
    let found = found.expect("the unlistable install must still be found");
    assert_eq!(found[0].branch, Branch::Stable);
    assert!(
        found[0].resources.ends_with("app-0.0.424/Discord.app/Contents/Resources"),
        "{}",
        found[0].resources.display()
    );
}

#[test]
fn finds_each_install_and_reports_its_injected_state() {
    let temp = TempDir::new("find");
    let apps = temp.dir("Applications");

    make_discord_install(&apps, "Discord.app", false);
    make_discord_install(&apps, "Discord Canary.app", true);
    // PTB is not installed at all.
    std::fs::create_dir_all(apps.join("Discord PTB.app")).unwrap();

    let found = find_installs(&mac_env(&temp)).expect("two installs must be found");

    assert_eq!(
        found.len(),
        2,
        "the PTB directory with no asar must not count"
    );
    assert_eq!(found[0].branch, Branch::Stable);
    assert_eq!(found[1].branch, Branch::Canary);

    assert!(!found[0].injected, "Stable is not injected");
    assert!(found[1].injected, "Canary has a resources/app directory");
}

#[test]
fn stable_sorts_before_canary() {
    let temp = TempDir::new("rank");
    let apps = temp.dir("Applications");
    make_discord_install(&apps, "Discord Development.app", false);
    make_discord_install(&apps, "Discord PTB.app", false);
    make_discord_install(&apps, "Discord Canary.app", false);
    make_discord_install(&apps, "Discord.app", false);

    let found = find_installs(&mac_env(&temp)).expect("installs must be found");
    let branches: Vec<Branch> = found.iter().map(|i| i.branch).collect();
    assert_eq!(
        branches,
        vec![
            Branch::Stable,
            Branch::Canary,
            Branch::Ptb,
            Branch::Development
        ],
        "branches must sort by rank, not by search order"
    );
}

#[test]
fn a_pinned_path_short_circuits_discovery() {
    // `SYNCORD_DISCORD_PATH` exists so a user with a non-standard install can
    // say exactly which one is meant. Merging it with the auto-discovered list
    // would make it impossible to tell which install a later write was aimed at.
    let temp = TempDir::new("pin");
    let apps = temp.dir("Applications");
    make_discord_install(&apps, "Discord.app", false);
    make_discord_install(&apps, "Discord Canary.app", false);

    let pinned = apps.join("Discord Canary.app");
    let mut env = mac_env(&temp);
    env.preferred = Some(pinned.clone());

    let found = find_installs(&env).expect("the pinned install must resolve");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].branch, Branch::Custom);
    assert_eq!(found[0].root, pinned);
}

#[test]
fn a_pinned_path_that_is_not_an_install_is_an_error() {
    let temp = TempDir::new("badpin");
    let mut env = mac_env(&temp);
    env.preferred = Some(temp.join("Applications/Discord.app"));

    match find_installs(&env) {
        Err(DiscoveryError::PreferredPathInvalid(path)) => {
            assert!(path.to_string_lossy().contains("Discord.app"));
        }
        other => panic!("expected PreferredPathInvalid, got {other:?}"),
    }
}

#[test]
fn nothing_found_reports_platform_specific_guidance() {
    let temp = TempDir::new("none");

    let mac = DiscoveryEnv {
        platform: Platform::MacOs,
        local_app_data: None,
        home: temp.path().to_path_buf(),
        mac_parents: vec![temp.join("Applications")],
        linux_prefixes: vec![],
        flatpak_parents: vec![],
        preferred: None,
    };
    let Err(DiscoveryError::NotFound(Platform::MacOs)) = find_installs(&mac) else {
        panic!("expected NotFound for macOS");
    };

    let win = DiscoveryEnv {
        platform: Platform::Windows,
        local_app_data: Some(temp.join("AppData/Local")),
        home: temp.path().to_path_buf(),
        mac_parents: vec![],
        linux_prefixes: vec![],
        flatpak_parents: vec![],
        preferred: None,
    };
    let Err(DiscoveryError::NotFound(Platform::Windows)) = find_installs(&win) else {
        panic!("expected NotFound for Windows");
    };
}

#[test]
fn the_same_install_is_never_listed_twice() {
    // A symlinked /Applications can reach one real directory by two routes.
    // Injecting it twice because of that would be confusing rather than
    // harmful, but the list the user sees should still be one row.
    let temp = TempDir::new("dedup");
    let apps = temp.dir("Applications");
    make_discord_install(&apps, "Discord.app", false);

    #[cfg(unix)]
    {
        let real = apps.join("Discord.app").join("Contents").join("Resources");
        let link = apps.join("Discord Canary.app");
        let _ = std::fs::remove_dir_all(&link);
        #[cfg(unix)]
        std::os::unix::fs::symlink(apps.join("Discord.app"), &link).unwrap();

        let found = find_installs(&mac_env(&temp)).expect("the install must be found");
        assert_eq!(
            found.len(),
            1,
            "a symlinked duplicate must collapse to one install"
        );
        assert!(real.exists());
    }
}

#[test]
fn resources_are_canonicalized() {
    // The returned path is the write target, so it must be the real directory
    // rather than a path a symlink could redirect after discovery.
    let temp = TempDir::new("canon");
    let apps = temp.dir("Applications");
    let resources = make_discord_install(&apps, "Discord.app", false);

    let found = find_installs(&mac_env(&temp)).expect("the install must be found");
    assert_eq!(
        found[0].resources,
        resources.canonicalize().unwrap(),
        "resources must be canonicalized"
    );
}

// ── validate_install ──────────────────────────────────────────────────────────

#[test]
fn validate_install_rejects_a_directory_that_stopped_being_discord() {
    let temp = TempDir::new("validate");
    let apps = temp.dir("Applications");
    let resources = make_discord_install(&apps, "Discord.app", false);
    let found = find_installs(&mac_env(&temp)).expect("the install must be found");

    assert!(validate_install(&found[0]).is_ok());

    // Discord uninstalled between discovery and the click.
    std::fs::remove_file(resources.join("app.asar")).unwrap();
    assert!(validate_install(&found[0]).is_err());
}

#[test]
fn validate_install_rejects_a_hand_built_install_pointing_anywhere() {
    // `Install` is a plain struct, so a caller could construct one by hand. This
    // is what stops that from being a way to write to an arbitrary directory.
    let temp = TempDir::new("handmade");
    let innocent = temp.dir("innocent");
    std::fs::write(innocent.join("readme.txt"), b"not discord").unwrap();

    let forged = Install {
        branch: Branch::Custom,
        root: innocent.clone(),
        resources: innocent,
        injected: false,
    };
    assert!(
        validate_install(&forged).is_err(),
        "a directory with no asar must be refused"
    );
}

// ── Messages ──────────────────────────────────────────────────────────────────

#[test]
fn the_not_found_message_names_the_places_that_were_searched() {
    let mac = DiscoveryError::NotFound(Platform::MacOs).to_string();
    assert!(
        mac.contains("/Applications"),
        "macOS guidance must name the search locations"
    );
    assert!(mac.contains("SYNCORD_DISCORD_PATH"));

    let win = DiscoveryError::NotFound(Platform::Windows).to_string();
    assert!(win.contains("LOCALAPPDATA"));
    assert!(
        win.contains("Microsoft Store"),
        "the unsupported Store build must be named"
    );

    let linux = DiscoveryError::NotFound(Platform::Linux).to_string();
    assert!(linux.contains("/usr/share"));
    assert!(
        linux.contains("Snap"),
        "the unsupported Snap build must be named"
    );
}

#[test]
fn permission_help_differs_on_windows_only() {
    let win = permission_help(Platform::Windows);
    assert!(win.contains("Administrator"));
    assert!(!win.contains("Full Disk Access"));

    let mac = permission_help(Platform::MacOs);
    assert!(mac.contains("App Management"));
    assert!(!mac.contains("Administrator"));

    // Both must tell the user Discord has to be quit, since a running Discord
    // holds its own files open and the write will fail.
    assert!(win.contains("Quit Discord"));
    assert!(mac.contains("Quit Discord"));
}

#[test]
fn nothing_suggests_elevation() {
    // The plan requires that no path auto-elevates. The guidance a user is
    // shown must therefore describe what they can do, never a command that
    // grants the process administrator rights on its own.
    for platform in [Platform::MacOs, Platform::Windows, Platform::Linux] {
        let help = permission_help(platform);
        for forbidden in [
            "runas",
            "sudo -S",
            "elevate",
            "Start-Process -Verb RunAs",
            "osascript",
        ] {
            assert!(
                !help.to_lowercase().contains(&forbidden.to_lowercase()),
                "{platform} guidance must not contain {forbidden:?}"
            );
        }
    }
}

#[test]
fn the_guidance_names_the_permission_that_actually_applies() {
    // This text was wrong in a way no test caught, because the test asserted
    // only that "Full Disk Access" appeared somewhere — which it did, as the
    // wrong advice. It also told a macOS user to run `sudo pnpm inject`, a
    // command for a different program entirely.
    for platform in [Platform::MacOs, Platform::Windows, Platform::Linux] {
        let help = permission_help(platform);
        assert!(
            !help.contains("pnpm"),
            "{platform} guidance points at a command belonging to another program: {help}"
        );
    }

    let mac = permission_help(Platform::MacOs);
    assert!(
        mac.contains("App Management"),
        "the macOS guidance must name the setting that actually governs this: {mac}"
    );
    // Naming Full Disk Access as a *different* permission is useful; pointing at
    // it as the fix is not. The sentence has to read as a correction.
    assert!(
        mac.contains("does not cover this"),
        "the macOS guidance must not present Full Disk Access as the fix: {mac}"
    );
}

#[test]
fn branch_parsing_round_trips_and_rejects_typos() {
    for branch in [
        Branch::Custom,
        Branch::Stable,
        Branch::Canary,
        Branch::Ptb,
        Branch::Development,
    ] {
        assert_eq!(Branch::parse(&branch.to_string()), Some(branch));
    }
    assert_eq!(
        Branch::parse("Stable"),
        None,
        "ids are lower-case; a typo must not resolve"
    );
    assert_eq!(Branch::parse(""), None);
}

#[test]
fn platform_parsing_accepts_the_javascript_vocabulary() {
    assert_eq!(Platform::parse("darwin"), Platform::MacOs);
    assert_eq!(Platform::parse("win32"), Platform::Windows);
    assert_eq!(Platform::parse("linux"), Platform::Linux);
    assert_eq!(Platform::parse("freebsd"), Platform::Other);
}
