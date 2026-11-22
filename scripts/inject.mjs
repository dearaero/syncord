import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findInstalls,
  permissionHelp,
} from "./lib/discordInstalls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

function assertBuilt() {
  for (const file of ["main.js", "preload.js", "renderer.js"]) {
    if (!fs.existsSync(path.join(dist, file))) {
      throw new Error(`Missing dist/${file}. Run: pnpm build`);
    }
  }
}

function renameWithHelp(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    const code = err && err.code;
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
      throw new Error(
        `Cannot modify Discord (${from}).\n${permissionHelp()}`,
      );
    }
    throw err;
  }
}

function targetInstall() {
  const installs = findInstalls();
  const chosen = installs[0];
  const others = installs.slice(1);
  console.log(
    `[Syncord] Using Discord ${chosen.branch} at ${chosen.resources}`,
  );
  if (others.length > 0) {
    console.log(
      "[Syncord] Other installs (set Syncord_DISCORD_PATH to use one):",
    );
    for (const install of others) {
      console.log(`  ${install.branch}: ${install.resources}`);
    }
  }
  return chosen.resources;
}

function inject() {
  assertBuilt();
  const resources = targetInstall();
  const asar = path.join(resources, "app.asar");
  const backup = path.join(resources, "_app.asar");
  const appDir = path.join(resources, "app");

  if (fs.existsSync(appDir)) {
    console.log("[Syncord] Already injected (resources/app exists). Re-copying build…");
  } else {
    if (!fs.existsSync(backup)) {
      if (!fs.existsSync(asar)) {
        throw new Error(`Neither app.asar nor _app.asar found in ${resources}`);
      }
      renameWithHelp(asar, backup);
      console.log("[Syncord] Renamed app.asar → _app.asar");
    }
    fs.mkdirSync(appDir, { recursive: true });
  }

  // Copy the bundles, their source maps, and the integrity manifest. The
  // manifest is what `main.js` verifies at startup, so injecting the bundles
  // without it would leave every install reporting UNVERIFIED for no reason.
  for (const file of fs.readdirSync(dist)) {
    if (!file.endsWith(".js") && !file.endsWith(".map") && !file.endsWith(".json")) continue;
    fs.copyFileSync(path.join(dist, file), path.join(appDir, file));
  }

  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify(
      {
        name: "discord",
        main: "main.js",
        private: true,
      },
      null,
      2,
    ),
  );

  console.log(`[Syncord] Injected into ${appDir}`);
  console.log("[Syncord] Restart Discord to load Syncord.");
}

function uninject() {
  const resources = targetInstall();
  const asar = path.join(resources, "app.asar");
  const backup = path.join(resources, "_app.asar");
  const appDir = path.join(resources, "app");

  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
    console.log("[Syncord] Removed resources/app");
  }

  if (fs.existsSync(backup) && !fs.existsSync(asar)) {
    renameWithHelp(backup, asar);
    console.log("[Syncord] Restored _app.asar → app.asar");
  }

  console.log("[Syncord] Uninjected. Restart Discord.");
}

const cmd = process.argv[2] ?? "inject";
if (cmd === "inject" || cmd === "sync") {
  inject();
  if (cmd === "sync") {
    console.log("[Syncord] Sync done — press Syncord.reload() or reload the client.");
  }
} else if (cmd === "uninject") uninject();
else {
  console.error(`Unknown command: ${cmd}. Use inject | sync | uninject`);
  process.exit(1);
}
