//! Discord install discovery.
//!
//! This module decides **where the Injector will write**. It is therefore one
//! of the most security-relevant pieces of the crate, and it is held to a
//! stricter standard than the equivalent discovery code elsewhere:
//!
//! * Candidate roots are generated from a fixed table plus a caller-supplied
//!   environment. Nothing in a candidate path comes from an archive, a release
//!   descriptor, or a file on disk.
//! * Every discovered install is **canonicalized** before it is returned, so
//!   the write target is the real directory rather than a path that a symlink
//!   could redirect later. See [`Install::resources`].
//! * A resource directory only counts if it actually contains an asar, so a
//!   same-named directory that is not a Discord install is never selected.
//!
//! It must stay behaviourally identical to `scripts/lib/discordInstalls.mjs`.
//! If the two disagree, the CLI and the GUI would target *different* Discord
//! installations, which is the failure mode this duplication is most likely to
//! produce. `discovery_parity` documents the mapping and `tests/parity.rs`
//! pins the shared behaviour.
//!
//! Only *discovery* is duplicated. The write half lives in [`crate::inject`]
//! and has no counterpart in the JavaScript code, which only ever ran from a
//! developer's terminal with a build tree next to it.

use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

/// A Discord release channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Branch {
    /// The install named by `SYNCORD_DISCORD_PATH`.
    Custom,
    /// The default release channel.
    Stable,
    /// Discord Canary.
    Canary,
    /// Discord PTB.
    Ptb,
    /// Discord Development.
    Development,
}

impl Branch {
    /// Parse a branch id. Returns `None` for an unknown id rather than
    /// defaulting, so a typo in configuration is visible.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "custom" => Some(Self::Custom),
            "stable" => Some(Self::Stable),
            "canary" => Some(Self::Canary),
            "ptb" => Some(Self::Ptb),
            "development" => Some(Self::Development),
            _ => None,
        }
    }

    /// Stable first, then canary, ptb, development; an explicit `custom` pin
    /// always wins. Mirrors `RANK` in the JavaScript.
    pub fn rank(self) -> i32 {
        match self {
            Self::Custom => -1,
            Self::Stable => 0,
            Self::Canary => 1,
            Self::Ptb => 2,
            Self::Development => 3,
        }
    }

    fn ids(self) -> &'static [(&'static str, &'static [&'static str])] {
        match self {
            Self::Custom => &[],
            Self::Stable => &[
                ("mac", &["Discord.app"]),
                ("macdata", &["discord"]),
                ("win", &["Discord"]),
                ("linux", &["discord", "Discord"]),
                ("flatpak", &["com.discordapp.Discord"]),
            ],
            Self::Canary => &[
                ("mac", &["Discord Canary.app"]),
                ("macdata", &["discordcanary"]),
                ("win", &["DiscordCanary"]),
                ("linux", &["discord-canary", "DiscordCanary"]),
                ("flatpak", &["com.discordapp.DiscordCanary"]),
            ],
            Self::Ptb => &[
                ("mac", &["Discord PTB.app"]),
                ("macdata", &["discordptb"]),
                ("win", &["DiscordPTB"]),
                ("linux", &["discord-ptb", "DiscordPTB"]),
                ("flatpak", &["com.discordapp.DiscordPTB"]),
            ],
            Self::Development => &[
                ("mac", &["Discord Development.app"]),
                ("macdata", &["discorddevelopment"]),
                ("win", &["DiscordDevelopment"]),
                ("linux", &["discord-development", "DiscordDevelopment"]),
                ("flatpak", &["com.discordapp.DiscordDevelopment"]),
            ],
        }
    }

    /// The bundle names this branch ships under for `kind` (`mac`, `win`,
    /// `linux` or `flatpak`). `macdata` is the folder under
    /// `~/Library/Application Support` used by Discord's macOS launcher layout.
    fn names_for(self, kind: &str) -> &'static [&'static str] {
        self.ids()
            .iter()
            .find(|(k, _)| *k == kind)
            .map(|(_, names)| *names)
            .unwrap_or(&[])
    }
}

impl fmt::Display for Branch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Custom => "custom",
            Self::Stable => "stable",
            Self::Canary => "canary",
            Self::Ptb => "ptb",
            Self::Development => "development",
        };
        f.write_str(text)
    }
}

/// The three desktop platforms Discord ships, plus an explicit `Other` so a
/// caller can enumerate candidates for a platform this build does not know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// macOS: `Discord.app` and friends under `/Applications`.
    MacOs,
    /// Windows: `%LOCALAPPDATA%\Discord` and friends.
    Windows,
    /// Linux: system prefixes, `~`, and Flatpak.
    Linux,
    /// Any other platform. Treated like Linux for candidate enumeration, which
    /// is the conservative choice: it looks in the shared prefixes rather than
    /// assuming nothing exists.
    Other,
}

impl Platform {
    /// The platform this binary is running on.
    pub fn current() -> Self {
        match std::env::consts::OS {
            "macos" => Self::MacOs,
            "windows" => Self::Windows,
            "linux" => Self::Linux,
            _ => Self::Other,
        }
    }

    /// Parse a Node-style platform string, which is what the JavaScript tests
    /// pass in. Keeping the same vocabulary makes the parity tests readable.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "darwin" => Self::MacOs,
            "win32" => Self::Windows,
            "linux" => Self::Linux,
            _ => Self::Other,
        }
    }
}

impl fmt::Display for Platform {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::MacOs => "macOS",
            Self::Windows => "Windows",
            Self::Linux => "Linux",
            Self::Other => "this platform",
        };
        f.write_str(text)
    }
}

/// Search roots. Every field is a *parent* directory; the branch names in
/// [`BRANCHES`] are appended to it.
///
/// The roots are a parameter rather than a constant so that the search can be
/// pointed somewhere specific (`SYNCORD_DISCORD_PATH`, a portable install on a
/// removable drive) and so the tests can enumerate a temporary tree. Nothing
/// here is ever derived from an archive.
// Field names are the contract with the JavaScript discovery code; restating
// them as prose would be noise.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryEnv {
    pub platform: Platform,
    /// `%LOCALAPPDATA%`. Windows discovery produces no candidates without it,
    /// matching the JavaScript, which returns early.
    pub local_app_data: Option<PathBuf>,
    pub home: PathBuf,
    /// macOS: `/Applications` and `~/Applications` by default.
    pub mac_parents: Vec<PathBuf>,
    /// Linux: `/usr/share`, `/usr/lib64`, `/usr/lib`, `/opt` by default.
    pub linux_prefixes: Vec<PathBuf>,
    /// Flatpak: `~/.local/share/flatpak/app` and `/var/lib/flatpak/app`.
    pub flatpak_parents: Vec<PathBuf>,
    /// An explicit pin, equivalent to `SYNCORD_DISCORD_PATH`.
    pub preferred: Option<PathBuf>,
}

impl DiscoveryEnv {
    /// The real environment on this machine.
    #[must_use]
    pub fn from_system() -> Self {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map_or_else(|| PathBuf::from("."), PathBuf::from);

        let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let preferred = std::env::var_os("SYNCORD_DISCORD_PATH").map(PathBuf::from);

        let mut mac_parents = vec![PathBuf::from("/Applications")];
        if !home.as_os_str().is_empty() {
            mac_parents.push(home.join("Applications"));
        }

        let mut flatpak_parents = Vec::new();
        if !home.as_os_str().is_empty() {
            flatpak_parents.push(home.join(".local/share/flatpak/app"));
        }
        flatpak_parents.push(PathBuf::from("/var/lib/flatpak/app"));

        Self {
            platform: Platform::current(),
            local_app_data,
            home,
            mac_parents,
            linux_prefixes: LINUX_PREFIXES.iter().map(PathBuf::from).collect(),
            flatpak_parents,
            preferred,
        }
    }

    /// A minimal environment for tests and for enumerating a chosen tree.
    #[must_use]
    pub fn for_platform(platform: Platform, home: PathBuf) -> Self {
        let mut env = Self {
            platform,
            local_app_data: None,
            home,
            mac_parents: Vec::new(),
            linux_prefixes: Vec::new(),
            flatpak_parents: Vec::new(),
            preferred: None,
        };
        if platform == Platform::MacOs {
            env.mac_parents = vec![env.home.join("Applications")];
        }
        if platform == Platform::Linux {
            env.linux_prefixes = LINUX_PREFIXES.iter().map(PathBuf::from).collect();
        }
        env
    }
}

/// The four branch definitions, in the same order as the JavaScript `BRANCHES`.
pub const BRANCHES: [Branch; 4] = [
    Branch::Stable,
    Branch::Canary,
    Branch::Ptb,
    Branch::Development,
];

/// System prefixes searched on Linux, in order.
pub const LINUX_PREFIXES: [&str; 4] = ["/usr/share", "/usr/lib64", "/usr/lib", "/opt"];

/// A candidate location that may hold a Discord install.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub branch: Branch,
    pub root: PathBuf,
}

/// A confirmed Discord install.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    pub branch: Branch,
    /// The path the user would recognise: the `.app`, the folder, or whatever
    /// was pinned. Display only — never a write target.
    pub root: PathBuf,
    /// The canonicalized `resources` directory. **This** is the only path
    /// `inject` writes under, and it is assembled from fixed names.
    pub resources: PathBuf,
    /// Whether Syncord is already installed here.
    pub injected: bool,
}

impl Install {
    /// The `app.asar` inside this install, if it is still in Discord's name.
    #[must_use]
    pub fn original_asar(&self) -> PathBuf {
        self.resources.join("app.asar")
    }

    /// The renamed original, present whenever an install is in injected state.
    #[must_use]
    pub fn backup_asar(&self) -> PathBuf {
        self.resources.join("_app.asar")
    }

    /// The directory Syncord's bundles live in once injected.
    #[must_use]
    pub fn app_dir(&self) -> PathBuf {
        self.resources.join("app")
    }
}

/// Why discovery failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    /// `SYNCORD_DISCORD_PATH` was set but does not resolve to an install.
    PreferredPathInvalid(PathBuf),
    /// Nothing was found. Carries the platform-specific guidance.
    NotFound(Platform),
    /// A path could not be canonicalized or inspected.
    Io {
        /// The path that could not be inspected.
        path: PathBuf,
        /// The underlying reason, for display.
        message: String,
    },
}

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PreferredPathInvalid(path) => write!(
                f,
                "SYNCORD_DISCORD_PATH is not a Discord install: {}\n\
                 Point it at Discord.app, the Discord folder, or the resources \
                 folder that contains app.asar.",
                path.display()
            ),
            Self::NotFound(platform) => {
                writeln!(f, "Discord desktop install not found.")?;
                match platform {
                    Platform::MacOs => writeln!(
                        f,
                        "Looked in /Applications, ~/Applications and ~/Library/Application Support for Discord, Canary, PTB, and Development."
                    )?,
                    Platform::Windows => {
                        writeln!(
                            f,
                            "Looked in %LOCALAPPDATA% for Discord, DiscordCanary, DiscordPTB, and DiscordDevelopment."
                        )?;
                        writeln!(f, "The Microsoft Store build is not supported.")?;
                    }
                    _ => {
                        writeln!(f, "Looked in /usr/share, /usr/lib, /opt, ~/ , and Flatpak.")?;
                        writeln!(f, "Snap builds are read-only and are not supported.")?;
                    }
                }
                write!(
                    f,
                    "Set SYNCORD_DISCORD_PATH to Discord.app, the Discord folder, or the resources \
                     folder that contains app.asar."
                )
            }
            Self::Io { path, message } => {
                write!(f, "Could not inspect {}: {message}", path.display())
            }
        }
    }
}

impl std::error::Error for DiscoveryError {}

/// Does this directory look like a Discord `resources` folder?
///
/// Both names are accepted: `app.asar` is Discord's own, `_app.asar` is what it
/// becomes after an injection. A directory with neither is not an install.
#[must_use]
pub fn has_asar(dir: &Path) -> bool {
    dir.join("app.asar").exists() || dir.join("_app.asar").exists()
}

/// Compare dotted numeric version strings.
///
/// Matches the JavaScript exactly, including its treatment of non-numeric
/// parts: `parseInt(part, 10) || 0`, so `"3-beta"` is `3` and `"beta"` is `0`.
/// That quirk is load-bearing for the `app-*` folder names on Windows, which
/// are numeric but must still sort numerically rather than lexically.
#[must_use]
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |value: &str| -> i64 {
        let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<i64>().unwrap_or(0)
    };
    let left: Vec<i64> = a.split('.').map(parse).collect();
    let right: Vec<i64> = b.split('.').map(parse).collect();
    let len = left.len().max(right.len());
    for index in 0..len {
        let diff = left.get(index).copied().unwrap_or(0) - right.get(index).copied().unwrap_or(0);
        if diff != 0 {
            return diff.cmp(&0);
        }
    }
    Ordering::Equal
}

/// The newest `app-*` folder under `root` that still contains an asar.
///
/// Windows keeps superseded `app-<version>` folders behind, so the newest
/// numeric one wins. Falls back to `None` when the directory cannot be read,
/// which is the common case for most candidates.
fn newest_app_resources(root: &Path) -> Option<PathBuf> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return probe_launcher_resources(root);
        }
        Err(_) => return None,
    };

    let mut versions: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix("app-") else {
            continue;
        };
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        versions.push(rest.to_string());
    }

    versions.sort_by(|a, b| compare_versions(a, b));

    for version in versions.iter().rev() {
        let folder = root.join(format!("app-{version}"));
        let resources = folder.join("resources");
        if has_asar(&resources) {
            return Some(resources);
        }
        if let Some(resources) = bundle_resources(&folder) {
            return Some(resources);
        }
    }
    None
}

/// Highest `app-0.0.<n>` we probe when a folder cannot be listed.
const LAUNCHER_PROBE_MAX: u32 = 20_000;

/// Find a launcher install inside a folder macOS will not let us list.
///
/// macOS 27 tags Discord Stable's `~/Library/Application Support/discord`
/// (`com.apple.macl`) so other apps cannot list it or its `app-*` folders, yet
/// paths inside the `.app` bundle stay reachable by name. Discord numbers these
/// folders `0.0.<n>`, so probe newest-first by name instead of listing.
fn probe_launcher_resources(root: &Path) -> Option<PathBuf> {
    const BUNDLES: [&str; 4] = [
        "Discord.app",
        "Discord Canary.app",
        "Discord PTB.app",
        "Discord Development.app",
    ];
    (0..=LAUNCHER_PROBE_MAX).rev().find_map(|n| {
        let folder = root.join(format!("app-0.0.{n}"));
        if !folder.exists() {
            return None;
        }
        BUNDLES
            .iter()
            .map(|bundle| folder.join(bundle).join("Contents").join("Resources"))
            .find(|resources| has_asar(resources))
    })
}

/// `Contents/Resources` of the first `.app` bundle (by name) inside a macOS
/// launcher `app-<version>` folder that still contains an asar.
fn bundle_resources(folder: &Path) -> Option<PathBuf> {
    let mut bundles: Vec<PathBuf> = std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
        .collect();
    bundles.sort();
    bundles
        .into_iter()
        .map(|bundle| bundle.join("Contents").join("Resources"))
        .find(|resources| has_asar(resources))
}

/// Accept a `.app` bundle, a Discord folder, an `app-*` folder, or a resources
/// folder, and return the resources directory.
#[must_use]
pub fn resources_in(root: &Path) -> Option<PathBuf> {
    if !root.exists() {
        return None;
    }
    if has_asar(root) {
        return Some(root.to_path_buf());
    }

    let mac = root.join("Contents").join("Resources");
    if has_asar(&mac) {
        return Some(mac);
    }

    let direct = root.join("resources");
    if has_asar(&direct) {
        return Some(direct);
    }

    newest_app_resources(root)
}

/// Every location that might hold a Discord install, in search order.
///
/// This is a pure function of the environment, which is what makes it testable
/// and what makes it auditable: the full set of paths the Injector will ever
/// consider can be read off the end of this function.
#[must_use]
pub fn install_candidates(env: &DiscoveryEnv) -> Vec<Candidate> {
    let mut out = Vec::new();

    match env.platform {
        Platform::MacOs => {
            let support = env.home.join("Library").join("Application Support");
            for branch in BRANCHES {
                for parent in &env.mac_parents {
                    for name in branch.names_for("mac") {
                        out.push(Candidate {
                            branch,
                            root: parent.join(name),
                        });
                    }
                }
                // Discord's macOS launcher (2026-11) leaves only a stub in
                // /Applications and runs `app-<version>/Discord.app` from here.
                for name in branch.names_for("macdata") {
                    out.push(Candidate {
                        branch,
                        root: support.join(name),
                    });
                }
            }
        }
        Platform::Windows => {
            // Windows discovery is rooted entirely at %LOCALAPPDATA%. Without
            // it there are no candidates at all, matching the JavaScript early
            // return. Guessing at a profile path instead would be inventing a
            // filesystem location, which is exactly what this module avoids.
            let Some(local) = env.local_app_data.clone() else {
                return out;
            };
            for branch in BRANCHES {
                for name in branch.names_for("win") {
                    out.push(Candidate {
                        branch,
                        root: local.join(name),
                    });
                }
            }
        }
        _ => {
            for branch in BRANCHES {
                for prefix in &env.linux_prefixes {
                    for name in branch.names_for("linux") {
                        out.push(Candidate {
                            branch,
                            root: prefix.join(name),
                        });
                    }
                }
                for name in branch.names_for("linux") {
                    out.push(Candidate {
                        branch,
                        root: env.home.join(name),
                    });
                }
                for parent in &env.flatpak_parents {
                    for id in branch.names_for("flatpak") {
                        let base = parent.join(id).join("current").join("active").join("files");
                        out.push(Candidate {
                            branch,
                            root: base.join("discord"),
                        });
                        out.push(Candidate {
                            branch,
                            root: base.join("extra").join("discord"),
                        });
                    }
                }
            }
        }
    }

    out
}

/// Canonicalize a discovered resources directory.
///
/// A symlinked `resources` is legitimate — a user may have symlinked their
/// whole Discord folder — so this resolves rather than refuses. The point is
/// that [`Install::resources`] is the *real* directory, so a link swapped after
/// discovery cannot redirect a write somewhere else. Returns `None` when the
/// path does not resolve to an existing directory.
fn canonical_resources(resources: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(resources).ok()?;
    if !canonical.is_dir() {
        return None;
    }
    Some(canonical)
}

/// Every installed Discord, stable first.
///
/// An explicit `preferred` path short-circuits everything else, matching the
/// JavaScript: it is how a user pins a non-standard install, and silently
/// merging it with the auto-discovered list would make it impossible to say
/// which one a later write was aimed at.
pub fn find_installs(env: &DiscoveryEnv) -> Result<Vec<Install>, DiscoveryError> {
    if let Some(preferred) = env.preferred.clone() {
        let resources = resources_in(&preferred)
            .ok_or_else(|| DiscoveryError::PreferredPathInvalid(preferred.clone()))?;
        let canonical = canonical_resources(&resources)
            .ok_or_else(|| DiscoveryError::PreferredPathInvalid(preferred.clone()))?;
        let injected = canonical.join("app").is_dir();
        return Ok(vec![Install {
            branch: Branch::Custom,
            root: preferred,
            resources: canonical,
            injected,
        }]);
    }

    let mut found: Vec<Install> = Vec::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();

    for candidate in install_candidates(env) {
        let Some(resources) = resources_in(&candidate.root) else {
            continue;
        };
        // Deduplicate on the canonical path, not the candidate path: the macOS
        // probe can reach the same directory by two routes, and injecting the
        // same install twice because of a symlinked /Applications would be
        // confusing rather than harmful — but the list the user sees should
        // still be one entry per real install.
        let Some(canonical) = canonical_resources(&resources) else {
            continue;
        };
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let injected = canonical.join("app").is_dir();
        found.push(Install {
            branch: candidate.branch,
            root: candidate.root,
            resources: canonical,
            injected,
        });
    }

    // Stable sort, so two installs of the same branch keep search order.
    found.sort_by_key(|install| install.branch.rank());

    if found.is_empty() {
        return Err(DiscoveryError::NotFound(env.platform));
    }
    Ok(found)
}

/// What to tell the user when a write was refused for lack of permission.
///
/// The last resort, for a caller that has not measured the cause. Anything that
/// can call [`crate::access::probe`] should: this text is a guess, and on
/// macOS the guess it used to make was wrong. It said to run
/// `sudo pnpm inject` — a command belonging to the Electron client, which is not
/// the program that is running, elevating a process that elevation cannot help,
/// because a macOS privacy permission is granted to an application through
/// System Settings and not to an account. And it pointed at Full Disk Access,
/// which is a separate service that does not cover modifying another
/// application's bundle.
///
/// The measured path lives in [`crate::access`]. This is kept because the
/// command line has no window to open a settings pane from, so the honest thing
/// it can still do is name the right place.
#[must_use]
pub fn permission_help(platform: Platform) -> String {
    if platform == Platform::Windows {
        return "Quit Discord completely, including the tray icon, then try again.\n\
                If Discord is installed outside your user folder, run the command \
                line tool from an Administrator terminal."
            .to_string();
    }
    if platform == Platform::MacOs {
        return "Quit Discord completely, including the tray icon, then try again.\n\
                If macOS is refusing the write, it has not allowed this app to \
                change the Discord application: open System Settings, then Privacy \
                & Security, then App Management, and turn on \"Syncord Injector\".\n\
                Full Disk Access is a different permission and does not cover this."
            .to_string();
    }
    "Quit Discord completely, including the tray icon, then try again.".to_string()
}

/// Reject a path that is not usable as a write target.
///
/// Called on every install before `inject` touches anything, so a discovery
/// result that was tampered with between the two — or a future caller that
/// built an [`Install`] by hand — is caught here rather than half way through a
/// directory swap.
///
/// The check is deliberately narrow: the target must be an existing directory
/// that still contains an asar. If a user deleted Discord between discovery and
/// the click, this is what turns that into a clear error.
pub fn validate_install(install: &Install) -> Result<PathBuf, DiscoveryError> {
    let canonical = canonical_resources(&install.resources).ok_or_else(|| DiscoveryError::Io {
        path: install.resources.clone(),
        message: "the resources directory no longer exists".to_string(),
    })?;
    if !has_asar(&canonical) {
        return Err(DiscoveryError::Io {
            path: canonical,
            message: "no app.asar or _app.asar here, so this is not a Discord install".to_string(),
        });
    }
    Ok(canonical)
}

/// The `resources` directory names used by the Injector, for display.
///
/// The Injector names its own working directories with this prefix so they are
/// never confused with Discord's, and so `uninject` can recognise its own
/// leftovers without guessing.
pub const SYNCORD_PREFIX: &str = ".syncord-";

/// The staging directory an install is written into before it is swapped in.
#[must_use]
pub fn staging_dir(resources: &Path) -> PathBuf {
    resources.join(format!("{SYNCORD_PREFIX}staging"))
}

/// The previous install, kept until the new one is confirmed in place.
#[must_use]
pub fn rollback_dir(resources: &Path) -> PathBuf {
    resources.join(format!("{SYNCORD_PREFIX}rollback"))
}

/// A directory name built from a version, for logs and error messages only.
///
/// Never joined onto a path: version strings are validated upstream, and the
/// display form is produced here so no caller can pass an unvalidated segment.
#[must_use]
pub fn display_version(raw: &str) -> OsString {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .take(32)
        .collect();
    OsString::from(cleaned)
}
