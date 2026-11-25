import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where official Discord desktop builds live.
 * Add a branch or a prefix here when Discord ships a new install layout.
 * `pnpm inject` picks stable when several are present. Point
 * Syncord_DISCORD_PATH at another one (the .app, the Discord folder,
 * or the resources folder that contains app.asar).
 */
const BRANCHES = [
  {
    id: "stable",
    mac: ["Discord.app"],
    macdata: ["discord"],
    win: ["Discord"],
    linux: ["discord", "Discord"],
    flatpak: ["com.discordapp.Discord"],
  },
  {
    id: "canary",
    mac: ["Discord Canary.app"],
    macdata: ["discordcanary"],
    win: ["DiscordCanary"],
    linux: ["discord-canary", "DiscordCanary"],
    flatpak: ["com.discordapp.DiscordCanary"],
  },
  {
    id: "ptb",
    mac: ["Discord PTB.app"],
    macdata: ["discordptb"],
    win: ["DiscordPTB"],
    linux: ["discord-ptb", "DiscordPTB"],
    flatpak: ["com.discordapp.DiscordPTB"],
  },
  {
    id: "development",
    mac: ["Discord Development.app"],
    macdata: ["discorddevelopment"],
    win: ["DiscordDevelopment"],
    linux: ["discord-development", "DiscordDevelopment"],
    flatpak: ["com.discordapp.DiscordDevelopment"],
  },
];

const LINUX_PREFIXES = ["/usr/share", "/usr/lib64", "/usr/lib", "/opt"];

function hasAsar(dir) {
  return (
    fs.existsSync(path.join(dir, "app.asar")) ||
    fs.existsSync(path.join(dir, "_app.asar"))
  );
}

function compareVersions(a, b) {
  const pa = a.split(".").map((part) => parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Newest `app-*` folder that still has an asar. Windows keeps old ones behind. */
function newestAppResources(root) {
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const apps = names
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("app-"))
    .map((entry) => entry.name.slice(4))
    .sort(compareVersions);

  for (let i = apps.length - 1; i >= 0; i--) {
    const folder = path.join(root, `app-${apps[i]}`);
    const resources = path.join(folder, "resources");
    if (hasAsar(resources)) return resources;
    const bundled = bundleResources(folder);
    if (bundled) return bundled;
  }
  return null;
}

/** `Contents/Resources` of the first `.app` inside a macOS launcher `app-*` folder. */
function bundleResources(folder) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  const bundles = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => entry.name)
    .sort();
  for (const name of bundles) {
    const resources = path.join(folder, name, "Contents", "Resources");
    if (hasAsar(resources)) return resources;
  }
  return null;
}

/**
 * Accept a .app bundle, a Discord folder, an `app-*` folder, or a resources
 * folder. Returns the resources directory, or null.
 */
export function resourcesIn(root) {
  if (!root || !fs.existsSync(root)) return null;
  if (hasAsar(root)) return root;

  const mac = path.join(root, "Contents", "Resources");
  if (hasAsar(mac)) return mac;

  const direct = path.join(root, "resources");
  if (hasAsar(direct)) return direct;

  return newestAppResources(root);
}

/**
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export function installCandidates(platform, env, home) {
  /** @type {{ branch: string, root: string }[]} */
  const out = [];

  if (platform === "darwin") {
    const parents = ["/Applications", path.join(home, "Applications")];
    const support = path.join(home, "Library", "Application Support");
    for (const branch of BRANCHES) {
      for (const parent of parents) {
        for (const name of branch.mac) {
          out.push({ branch: branch.id, root: path.join(parent, name) });
        }
      }
      // Discord's macOS launcher (2026-11) leaves only a stub in /Applications
      // and runs `app-<version>/Discord.app` from here.
      for (const name of branch.macdata) {
        out.push({ branch: branch.id, root: path.join(support, name) });
      }
    }
    return out;
  }

  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (!local) return out;
    for (const branch of BRANCHES) {
      for (const name of branch.win) {
        out.push({ branch: branch.id, root: path.join(local, name) });
      }
    }
    return out;
  }

  for (const branch of BRANCHES) {
    for (const prefix of LINUX_PREFIXES) {
      for (const name of branch.linux) {
        out.push({ branch: branch.id, root: path.join(prefix, name) });
      }
    }
    for (const name of branch.linux) {
      out.push({ branch: branch.id, root: path.join(home, name) });
    }
    const flatpakParents = [
      path.join(home, ".local", "share", "flatpak", "app"),
      "/var/lib/flatpak/app",
    ];
    for (const parent of flatpakParents) {
      for (const id of branch.flatpak) {
        const base = path.join(parent, id, "current", "active", "files");
        out.push({ branch: branch.id, root: path.join(base, "discord") });
        out.push({ branch: branch.id, root: path.join(base, "extra", "discord") });
      }
    }
  }
  return out;
}

const RANK = { custom: -1, stable: 0, canary: 1, ptb: 2, development: 3 };

function notFoundError(platform) {
  const lines = ["Discord desktop install not found."];
  if (platform === "darwin") {
    lines.push(
      "Looked in /Applications, ~/Applications and ~/Library/Application Support for Discord, Canary, PTB, and Development.",
    );
  } else if (platform === "win32") {
    lines.push(
      "Looked in %LOCALAPPDATA% for Discord, DiscordCanary, DiscordPTB, and DiscordDevelopment.",
    );
    lines.push("The Microsoft Store build is not supported.");
  } else {
    lines.push("Looked in /usr/share, /usr/lib, /opt, ~/ , and Flatpak.");
    lines.push("Snap builds are read-only and are not supported.");
  }
  lines.push(
    "Set Syncord_DISCORD_PATH to Discord.app, the Discord folder, or the resources folder that contains app.asar.",
  );
  return new Error(lines.join("\n"));
}

/** Every installed branch. Stable is first. */
export function findInstalls(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const preferred = env.Syncord_DISCORD_PATH;

  if (preferred) {
    const resources = resourcesIn(preferred);
    if (!resources) {
      throw new Error(
        `Syncord_DISCORD_PATH is not a Discord install: ${preferred}\n` +
          "Point it at Discord.app, the Discord folder, or the resources folder that contains app.asar.",
      );
    }
    return [{ branch: "custom", root: preferred, resources }];
  }

  /** @type {{ branch: string, root: string, resources: string }[]} */
  const found = [];
  const seen = new Set();
  for (const candidate of installCandidates(platform, env, home)) {
    const resources = resourcesIn(candidate.root);
    if (!resources || seen.has(resources)) continue;
    seen.add(resources);
    found.push({ branch: candidate.branch, root: candidate.root, resources });
  }

  found.sort((a, b) => (RANK[a.branch] ?? 9) - (RANK[b.branch] ?? 9));
  if (found.length === 0) throw notFoundError(platform);
  return found;
}

/**
 * What to show when a write is refused.
 *
 * This text was wrong in two ways and is kept in step with
 * `permission_help` in `syncord-core`:
 *
 *   - it told a macOS user to run `sudo pnpm inject`, which is a command to
 *     elevate this process. It cannot work: a macOS privacy permission is
 *     granted to an *application* through System Settings, not to an account, so
 *     elevating changes who is asking without changing what they may ask for.
 *   - it pointed at Full Disk Access, which is a different service and does not
 *     cover modifying another application's bundle.
 *
 * What is actually in the way on macOS 13 and later is App Management. The
 * Injector measures it and can open the right pane; this is the fallback for
 * the command line, which has no window to open one from, so all it can do is
 * name the right place.
 */
export function permissionHelp(platform = process.platform) {
  const quit = "Quit Discord completely, including the tray icon, then try again.";
  if (platform === "win32") {
    return `${quit}\nIf Discord is installed outside your user folder, run this from an Administrator terminal.`;
  }
  if (platform === "darwin") {
    return (
      `${quit}\nIf macOS is refusing the write, it has not allowed this app to ` +
      `change the Discord application: open System Settings, then Privacy & ` +
      `Security, then App Management, and turn on the app you are running from.\n` +
      `Full Disk Access is a different permission and does not cover this.`
    );
  }
  return quit;
}
