//! The Syncord Injector — entry point.
//!
//! Two ways in:
//!
//! * **No arguments** — the window opens and shows the install list.
//! * **`--apply-staged <path>`** — the mode the Electron client spawns. No
//!   window; it applies a staged, verified update and exits.
//!
//! ── The trust boundary ──────────────────────────────────────────────────────
//!
//! Tauri v2 gates every native capability behind the files in `capabilities/`.
//! `capabilities/default.json` grants core defaults and four main-window controls — window management
//! and the event system — and nothing else. There is no `fs` plugin, no `shell`
//! plugin and no `http` plugin, so the frontend cannot read a file, spawn a
//! process or open a socket even if it is fully compromised.
//!
//! On top of that, no `#[tauri::command]` in `state.rs` accepts a path: they
//! take an *index* into a list Rust discovered at startup. So the frontend has
//! no path to name, and the one path it can learn (`install.path`, for display)
//! is only ever an input to a lookup that was resolved before the window opened.
//!
//! The logic lives in `syncord-core`, which has no Tauri dependency and is
//! covered by `cargo test` without a webview.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod embedded_payload;
mod release_client;
mod state;
mod update_job;

#[cfg(test)]
mod commands_test;

use std::path::{Path, PathBuf};

use state::AppState;
use syncord_core::archive::{extract_payload, ExtractionLimits};
use syncord_core::discovery::{find_installs, DiscoveryEnv, DiscoveryError, Install, Platform};
use syncord_core::inject::{update, InjectOutcome};
use syncord_core::verify::Verifier;

/// Exit code for "the update could not be applied". Distinct from 1 (a crash) so
/// the Electron client, which spawned us, can tell the two apart.
const EXIT_UPDATE_FAILED: i32 = 2;
/// Exit code for "no Discord was named / found".
const EXIT_NO_TARGET: i32 = 3;

/// Write a line to stdout, tolerating a closed pipe.
///
/// `println!` panics when stdout is a pipe that has already been closed, so
/// `syncord-injector --list | head` died with a backtrace. Ignoring the error is
/// the whole fix: there is nothing useful to do about a reader that stopped
/// listening, and a backtrace is not it.
macro_rules! say {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), $($arg)*);
    }};
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    match args.first().map(String::as_str) {
        Some("--check-update") => {
            let result = Verifier::embedded()
                .map_err(|e| e.to_string())
                .and_then(|v| release_client::latest(&v));
            match result {
                Ok(release) => say!(
                    "Verified latest client: {} ({})",
                    release.version,
                    release.asset.platform
                ),
                Err(message) => {
                    eprintln!("[Syncord] {message}");
                    std::process::exit(EXIT_UPDATE_FAILED);
                }
            }
        }
        Some("--update") => {
            let env = DiscoveryEnv::from_system();
            let state = AppState::discover(&env, None, Verifier::embedded().ok());
            let rows = state::startup_inner(&state).installs;
            let requested = args.get(1).map(String::as_str);
            let selected: Vec<_> = rows
                .iter()
                .filter(|row| requested.map_or(true, |b| row.branch == b))
                .collect();
            if selected.len() != 1 {
                eprintln!("[Syncord] Choose exactly one Discord branch: stable, canary, ptb, development, custom.");
                std::process::exit(EXIT_NO_TARGET);
            }
            let result = state::inject_latest_into_inner(&state, selected[0].index);
            say!("{}", result.message);
            if !result.ok {
                std::process::exit(EXIT_UPDATE_FAILED);
            }
        }
        Some("--wait-and-apply-staged") => {
            let stage = args.get(1).cloned().unwrap_or_default();
            let branch = args
                .get(2)
                .filter(|v| !v.starts_with("--"))
                .map(String::as_str);
            let restart = !args.iter().any(|v| v == "--no-restart");
            std::process::exit(update_job::wait_and_apply(&stage, branch, restart));
        }
        Some("--apply-staged") => {
            let stage = args.get(1).cloned().unwrap_or_default();
            let branch = args.get(2).cloned();
            let code = apply_staged(&stage, branch.as_deref());
            std::process::exit(code);
        }
        Some("--list") => {
            let code = list_installs();
            std::process::exit(code);
        }
        Some("--help") | Some("-h") => {
            print_usage();
        }
        Some("--version") | Some("-V") => {
            say!("syncord-injector {}", syncord_core::INJECTOR_VERSION);
        }
        Some(other) => {
            eprintln!("[Syncord] unknown argument: {other}");
            print_usage();
            std::process::exit(EXIT_NO_TARGET);
        }
        None => run_gui(),
    }
}

fn print_usage() {
    say!(
        "Syncord Injector {}\n\n\
         Usage:\n  \
         syncord-injector                 open the window\n  \
         syncord-injector --list          print the Discord installs it can see\n  \
         syncord-injector --apply-staged <release.json> [branch]\n                                 \
         apply a staged update (used by the Syncord client)\n  \
         syncord-injector --check-update  verify the latest public release\n  \
         syncord-injector --update [branch] download and apply it to a closed Discord\n  \
         syncord-injector --wait-and-apply-staged <release.json> [branch] [--no-restart]\n                                 verify, wait for Discord exit, apply and restart\n  \
         syncord-injector --version\n  \
         syncord-injector --help",
        syncord_core::INJECTOR_VERSION
    );
}

/// Print the install list without opening a window and without writing anything.
///
/// Exists because "the Injector shows nothing" is otherwise undiagnosable: a
/// user can be looking at an empty window for three reasons — discovery found
/// nothing, the app directory is unreadable, or the UI is broken — and this
/// separates the first two from the third in one command.
///
/// Strictly read-only. It reports what it would show and stops.
fn list_installs() -> i32 {
    let env = DiscoveryEnv::from_system();
    let verifier = Verifier::embedded().ok();

    let installs = match find_installs(&env) {
        Ok(found) => found,
        Err(DiscoveryError::NotFound(platform)) => {
            say!("No Discord install was found on {platform}.");

            say!("Set SYNCORD_DISCORD_PATH to point at one directly.");
            return EXIT_NO_TARGET;
        }
        Err(err) => {
            eprintln!("[Syncord] {err}");
            return EXIT_NO_TARGET;
        }
    };

    say!("{} Discord install(s) found:\n", installs.len());
    for install in &installs {
        let app_dir = install.app_dir();
        let installed = app_dir.is_dir();
        let version = syncord_core::inject::installed_version(&install.resources);
        let fingerprint = syncord_core::inject::installed_fingerprint(&install.resources);
        let verified = verifier
            .as_ref()
            .is_some_and(|v| v.verify_install(&app_dir).is_ok());

        let state = if !installed {
            "not injected".to_string()
        } else if !verified {
            // "Unverified", not "modified": a failed check means we could not
            // confirm, which is not the same as an accusation.
            format!(
                "injected, UNVERIFIED ({}…)",
                fingerprint.unwrap_or_default()
            )
        } else if !syncord_core::inject::launch_ready(&install.resources) {
            "payload verified, startup needs repair — run Inject again".to_string()
        } else {
            format!(
                "injected, verified, v{}",
                version.unwrap_or_else(|| "?".into())
            )
        };

        say!("  {:<12} {state}", install.branch.to_string());
        say!("               {}", install.resources.display());
    }

    let embedded = match embedded_payload::load(verifier.as_ref()) {
        Ok(payload) => payload,
        Err(err) => {
            say!("\nBundled payload: REJECTED — {err}");
            return EXIT_UPDATE_FAILED;
        }
    };
    let payload_dir = embedded
        .as_ref()
        .map(|p| p.0.clone())
        .or_else(syncord_core::inject::bundled_payload_dir);
    if let Some(dir) = payload_dir {
        if dir.is_dir() {
            match verifier.as_ref().map(|v| v.verify_install(&dir)) {
                Some(Ok(_)) => say!(
                    "\nBundled payload: verified, v{}",
                    syncord_core::verify::read_version_stamp(&dir).unwrap_or_else(|| "?".into())
                ),
                Some(Err(err)) => say!("\nBundled payload: present but REJECTED — {err}"),
                None => say!("\nBundled payload: present but this build has no signing key"),
            }
        } else {
            say!("\nBundled payload: none beside the executable, so Inject is disabled.");
        }
    }

    0
}

fn run_gui() {
    let mut context = tauri::generate_context!();
    configure_window_chrome(context.config_mut(), cfg!(windows));
    // Tauri otherwise uses Cargo's kebab-case package name for the OS app name.
    context.package_info_mut().name = "Syncord Injector".into();
    tauri::Builder::default()
        .manage(std::sync::Arc::new(AppState::new()))
        .invoke_handler(tauri::generate_handler![
            state::startup,
            state::rescan,
            state::check_write_access,
            state::open_settings,
            state::inject_into,
            state::install_bundled,
            state::check_updates,
            state::uninject_from,
        ])
        .run(context)
        .unwrap_or_else(|err| {
            // A GUI binary launched from a terminal otherwise shows nothing.
            eprintln!("[Syncord] the Injector window could not be opened: {err}");
            std::process::exit(1);
        });
}

fn configure_window_chrome(config: &mut tauri::Config, windows: bool) {
    // Tao's undecorated-shadow path adds a native 1px border on Windows.
    // Its rectangular frame remains visible outside our transparent CSS corners.
    // Set this before Tauri constructs the window; retain other OS shadows.
    if windows {
        for window in &mut config.app.windows {
            if window.label == "main" && !window.decorations {
                window.shadow = false;
            }
        }
    }
}

/// Apply a staged update without opening a window.
///
/// This is the hand-off the Electron client performs: it downloaded the release,
/// verified its signature, checked the digest, wrote it to Syncord's own
/// user-data staging directory, and then spawned this binary with the path. We
/// re-check the digest and the signature, because "the other process said it was
/// fine" is not the same as "it is fine".
///
/// Discord must be closed. An update replaces three files under
/// `resources/app`, and a running client holds them open; on macOS that is a
/// failure, on Windows it can leave a half-written bundle. Refusing with a clear
/// message is the only safe response.
fn staged_target(branch: Option<&str>) -> Result<Install, String> {
    let installs = find_installs(&DiscoveryEnv::from_system()).map_err(|e| e.to_string())?;
    if let Some(name) = branch {
        let wanted = name.to_ascii_lowercase();
        if !["custom", "stable", "canary", "ptb", "development"].contains(&wanted.as_str()) {
            return Err(format!(
                "{name} is not a Discord branch this Injector knows."
            ));
        }
        installs
            .into_iter()
            .find(|i| i.branch.to_string() == wanted)
            .ok_or_else(|| format!("No Discord {wanted} install was found."))
    } else {
        match installs.as_slice() {
            [only] => Ok(only.clone()),
            _ => Err(format!(
                "{} Discord installs were found. Name a branch to choose the correct one.",
                installs.len()
            )),
        }
    }
}

fn apply_staged(stage: &str, branch: Option<&str>) -> i32 {
    if stage.is_empty() {
        eprintln!("[Syncord] --apply-staged needs the path to a release.json");
        return EXIT_NO_TARGET;
    }

    let target = match staged_target(branch) {
        Ok(target) => target,
        Err(message) => {
            eprintln!("[Syncord] {message}");
            return EXIT_NO_TARGET;
        }
    };

    if let Some(running) = running_for(&target.root) {
        eprintln!("[Syncord] This Discord is still running:");
        eprintln!("           {running}");
        eprintln!("           Quit it, then run this again.");
        return EXIT_UPDATE_FAILED;
    }

    if !target.app_dir().is_dir() {
        eprintln!(
            "[Syncord] Syncord is not installed in this Discord yet. \
             Open the Injector window to install it."
        );
        return EXIT_UPDATE_FAILED;
    }

    let verifier = match Verifier::embedded() {
        Ok(verifier) => verifier,
        Err(err) => {
            eprintln!("[Syncord] {err}");
            return EXIT_UPDATE_FAILED;
        }
    };

    let scratch = std::env::temp_dir().join(format!("syncord-apply-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    if let Err(err) = std::fs::create_dir_all(&scratch) {
        eprintln!("[Syncord] could not create a temporary directory: {err}");
        return EXIT_UPDATE_FAILED;
    }

    let extracted = match extract_staged(stage, &scratch, &verifier) {
        Ok(dir) => dir,
        Err(message) => {
            let _ = std::fs::remove_dir_all(&scratch);
            eprintln!("[Syncord] {message}");
            return EXIT_UPDATE_FAILED;
        }
    };

    let incoming = syncord_core::verify::read_version_stamp(&extracted).unwrap_or_default();
    if syncord_core::inject::installed_version(&target.resources).is_some_and(|current| {
        syncord_core::release::compare_versions(&incoming, &current) == std::cmp::Ordering::Less
    }) {
        let _ = std::fs::remove_dir_all(&scratch);
        eprintln!(
            "[Syncord] This update is older than the installed client. Downgrades are refused."
        );
        return EXIT_UPDATE_FAILED;
    }
    let _install_lock = match update_job::lock_install(&target.resources) {
        Ok(lock) => lock,
        Err(message) => {
            let _ = std::fs::remove_dir_all(&scratch);
            eprintln!("[Syncord] {message}");
            return EXIT_UPDATE_FAILED;
        }
    };
    if syncord_core::inject::installed_version(&target.resources).is_some_and(|current| {
        syncord_core::release::compare_versions(&incoming, &current) == std::cmp::Ordering::Less
    }) {
        let _ = std::fs::remove_dir_all(&scratch);
        eprintln!("[Syncord] A newer client was installed while preparing this update. Downgrades are refused.");
        return EXIT_UPDATE_FAILED;
    }
    let result = update(&target, &extracted, &verifier);
    let _ = std::fs::remove_dir_all(&scratch);

    match result {
        Ok(InjectOutcome::Updated) | Ok(InjectOutcome::Replaced) => {
            say!(
                "[Syncord] Syncord was updated in {}. Restart Discord to load it.",
                target.resources.display()
            );
            0
        }
        Ok(other) => {
            eprintln!("[Syncord] unexpected outcome: {other:?}");
            EXIT_UPDATE_FAILED
        }
        Err(err) => {
            eprintln!("[Syncord] the update could not be applied: {err}");
            if let syncord_core::inject::InjectError::PermissionDenied { ref help, .. } = err {
                eprintln!("[Syncord] {help}");
            }
            EXIT_UPDATE_FAILED
        }
    }
}

/// Extract and verify a staged bundle into `scratch`, returning the directory.
///
/// See `state::load_staged` for the same logic behind a command; this is the
/// CLI's copy because the CLI runs before any Tauri state exists. Both are
/// deliberately written against `syncord-core` primitives rather than sharing a
/// Tauri dependency.
fn extract_staged(stage: &str, scratch: &Path, verifier: &Verifier) -> Result<PathBuf, String> {
    let stage_path = std::path::Path::new(stage);
    let raw = std::fs::read(stage_path)
        .map_err(|err| format!("the staged update could not be read: {err}"))?;

    #[derive(serde::Deserialize)]
    struct StageDescriptor {
        version: String,
        asset: String,
        sha256: String,
    }

    let descriptor: StageDescriptor = serde_json::from_slice(&raw)
        .map_err(|_| "the staged update descriptor is not valid JSON.".to_string())?;

    if descriptor.sha256.len() != 64
        || !descriptor
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("the staged update descriptor has a malformed digest.".to_string());
    }
    if descriptor.asset.is_empty()
        || descriptor.asset.contains('/')
        || descriptor.asset.contains('\\')
        || descriptor.asset.contains("..")
    {
        return Err("the staged update asset name is not a plain filename.".to_string());
    }

    let asset_path = stage_path
        .parent()
        .ok_or_else(|| "the staged update has no parent directory.".to_string())?
        .join(&descriptor.asset);

    let bytes = std::fs::read(&asset_path)
        .map_err(|err| format!("the staged update bundle could not be read: {err}"))?;

    if syncord_core::verify::sha256_bytes(&bytes) != descriptor.sha256 {
        return Err("the staged update bundle does not match its recorded digest.".to_string());
    }

    extract_payload(&bytes, scratch, &ExtractionLimits::default())
        .map_err(|err| format!("the staged update could not be unpacked: {err}"))?;

    verifier
        .verify_install(scratch)
        .map_err(|err| format!("the staged update is not correctly signed: {err}"))?;

    // The descriptor's version and the payload's own stamp must agree. See the
    // same check in `state::load_staged` for why this is worth stating twice.
    let staged = syncord_core::verify::normalize_version(&descriptor.version)
        .ok_or_else(|| "the staged update descriptor has a malformed version.".to_string())?;
    let stamped = syncord_core::verify::read_version_stamp(scratch)
        .ok_or_else(|| "the staged update has no version stamp.".to_string())?;
    if staged != stamped {
        return Err(format!(
            "the staged update says version {staged} but contains {stamped}."
        ));
    }

    Ok(scratch.to_path_buf())
}

/// Is *this* Discord running?
///
/// ── Why not "is any Discord running" ────────────────────────────────────────
///
/// The first version did exactly that, and the live test caught it: a user with
/// Canary open could not update Stable, with no way to say "it is a different
/// install". Most people run more than one Discord branch, so this would have
/// blocked the update path for the majority of users while telling them to quit
/// something that was not the problem.
///
/// So the check is per-install: it looks for a running process whose executable
/// lives inside *this* install's root, and ignores every other Discord. A false
/// negative costs a retry after a hot-swap that would have failed anyway; a false
/// positive costs a user their update.
///
/// `root` is [`Install::root`] — the `.app` bundle or the Discord folder — not
/// `resources`, because that is the path the process command line actually
/// contains.
fn running_for(root: &std::path::Path) -> Option<String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    // A custom target may name resources itself, while the executable lives
    // beside that directory. Normal discovery passes the containing install.
    let root = if root
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("resources"))
    {
        root.parent().unwrap_or(&root)
    } else {
        &root
    };
    let root = root.to_string_lossy().into_owned();
    if root.is_empty() {
        return None;
    }

    // Prefix match on the install root, so `/usr/share/discord` matches
    // `/usr/share/discord/Discord` but not `/usr/share/discord-canary`.
    running_discord_executables()
        .into_iter()
        .find(|executable| {
            // Discovery canonicalizes roots; macOS ps can still return a /var
            // alias while the real root starts with /private/var.
            let canonical = Path::new(executable)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(executable));
            executable_in_install(&canonical.to_string_lossy(), &root, Platform::current())
        })
}

fn executable_in_install(executable: &str, root: &str, platform: Platform) -> bool {
    let normalize = |input: &str| {
        if platform != Platform::Windows {
            return input.trim_end_matches('/').to_string();
        }
        let path = input.replace('\\', "/");
        let path = if let Some(unc) = path.strip_prefix("//?/UNC/") {
            format!("//{unc}")
        } else {
            path.strip_prefix("//?/").unwrap_or(&path).to_string()
        };
        path.trim_end_matches('/').to_lowercase()
    };
    let root = normalize(root);
    let executable = normalize(executable);
    !root.is_empty() && (executable == root || executable.starts_with(&format!("{root}/")))
}

/// Executable paths of every running Discord process.
///
/// On macOS this reads `comm=`, which is the *executable path* and nothing
/// else. The first version used `command=`, the full argument vector, and
/// matched far too much: any process that merely mentioned the install path —
/// including the shell that launched the Injector — looked like a running
/// Discord, and the update was refused. `comm=` cannot have that problem.
///
/// Empty on any platform where it cannot be determined, which makes
/// [`running_for`] report "not running" — a permission problem, not a security
/// one, and failing open is the right direction here because the write itself is
/// still guarded by the signature check.
fn running_discord_executables() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        // /proc is authoritative and needs no subprocess.
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let exe = entry.path().join("exe");
            // `read_link` is the only way to read it; `metadata` follows the link
            // and reports the target, which is also usable.
            let Ok(path) = std::fs::read_link(&exe) else {
                continue;
            };
            let text = path.to_string_lossy().into_owned();
            if text.to_ascii_lowercase().contains("discord") {
                out.push(text);
            }
        }
        return out;
    }

    #[cfg(target_os = "macos")]
    {
        let Ok(output) = std::process::Command::new("/bin/ps")
            .arg("-Ao")
            .arg("comm=")
            .output()
        else {
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&output.stdout);
        return text
            .lines()
            .map(str::trim)
            .filter(|line| line.to_ascii_lowercase().contains("discord"))
            .map(str::to_string)
            .collect();
    }

    #[cfg(target_os = "windows")]
    {
        // PowerShell rather than `wmic`, which is deprecated and absent from
        // recent Windows builds.
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("powershell");
        // A GUI action must not flash a console while checking the tray process.
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let Ok(output) = command
            .args([
                "-NoProfile",
                "-Command",
                "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Process Discord,DiscordCanary,DiscordPTB,DiscordDevelopment -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }",
            ])
            .output()
        else {
            return Vec::new();
        };
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect();
    }

    #[allow(unreachable_code)]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_paths_use_platform_separators_and_directory_boundaries() {
        let root = r"\\?\C:\Users\Tester\AppData\Local\Discord";
        assert!(executable_in_install(
            r"c:\users\tester\appdata\local\discord\app-0.0.414\Discord.exe",
            root,
            Platform::Windows
        ));
        assert!(executable_in_install(
            r"\\server\share\Discord\Discord.exe",
            r"\\?\UNC\server\share\Discord",
            Platform::Windows
        ));
        assert!(!executable_in_install(
            r"C:\Users\Tester\AppData\Local\DiscordCanary\Discord.exe",
            root,
            Platform::Windows
        ));
        assert!(executable_in_install(
            "/usr/share/discord/Discord",
            "/usr/share/discord",
            Platform::Linux
        ));
        assert!(!executable_in_install(
            "/usr/share/discord-canary/Discord",
            "/usr/share/discord",
            Platform::Linux
        ));
    }

    #[test]
    fn an_empty_stage_path_is_refused_before_anything_else() {
        // A refusal that costs nothing: no discovery, no temporary directory, no
        // filesystem access at all.
        assert_eq!(apply_staged("", None), EXIT_NO_TARGET);
    }

    #[test]
    fn a_stage_path_that_does_not_exist_is_refused() {
        // Runs with a branch name that cannot match, so it fails at discovery or
        // at the read — never somewhere that writes.
        let code = apply_staged("/nonexistent/release.json", Some("no-such-branch"));
        assert!(
            code == EXIT_NO_TARGET || code == EXIT_UPDATE_FAILED,
            "a missing stage must be refused, got exit code {code}"
        );
    }

    #[test]
    fn exit_codes_are_distinct() {
        // The Electron client spawns us and reads the exit code, so these three
        // must never collide.
        assert_ne!(EXIT_UPDATE_FAILED, EXIT_NO_TARGET);
        assert_ne!(EXIT_UPDATE_FAILED, 1);
        assert_ne!(EXIT_NO_TARGET, 1);
    }
}
