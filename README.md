<div align="center">

# Syncord

**A fast, privacy-minded client layer for the Discord desktop app.**

[Download](https://github.com/dearaero/syncord/releases/latest) · [Releases](https://github.com/dearaero/syncord/releases)

</div>

Syncord adds plugins, a settings panel and a set of quality-of-life features to the official Discord desktop client. It runs inside Discord's own Electron app, keeps its data on your machine, and updates itself through a signed release feed.

> **Heads up.** Syncord modifies the official Discord client. Discord updates can break the injection, and client modifications can violate Discord's Terms of Service. Some plugins automate actions on your account. Use Syncord at your own risk.

## Install

1. Download the **Syncord Injector** for your system from the [latest release](https://github.com/dearaero/syncord/releases/latest).
2. Quit Discord completely, including the tray icon (on macOS press `⌘Q`).
3. Open the Injector and press **Inject**. It finds your Discord install, downloads the latest signed Syncord build, verifies it, and installs it.
4. Start Discord. A **Syncord** button appears in the title bar next to the back/forward buttons.

| System | Installer |
| --- | --- |
| Windows | x64 |
| macOS | Apple silicon and Intel |
| Linux | x64 and arm64 |

Works with Discord Stable, PTB, Canary and Development. Snap and Microsoft Store builds are read-only and are not supported.

The Injector stays your installer, repair and uninstall tool. Keep it in a permanent location. Syncord stages updates and applies them through it when Discord closes.

## Using Syncord

- Click **Syncord** in the title bar, or press `Ctrl+Shift+D` (`⌘+Shift+D` on macOS), to open the settings panel.
- Turn plugins on and off individually. Each plugin stores its settings under its own namespace.
- **Settings → Performance → Performance mode** reduces UI motion and effects.
- **Settings → Security → Core privacy** shows blocked analytics requests per session.
- Syncord follows Discord's language and ships 18 translations.

## What's inside

Everything below can be switched off from the settings panel.

| Area | Examples |
| --- | --- |
| Messaging | Global message search, message logger, scheduled messages, long messages, notes, DM filters and closer, mark all as read |
| Media | Smart upload (on-device optimization), image zoom, screen recorder, Spotify controls |
| Servers and profiles | Show badges, show hidden channels, server cloner, hidden items, custom game presence, platform indicators |
| Interface | Pop-out chats, copy avatar and banner links, titlebar update indicator, plugin bulk controls |
| Tools | Time Machine snapshots, Statistics (RAM, CPU, disk and network per session), Syncord Drop, experiments |
| Privacy | Built-in blocking of known Discord analytics, metrics and crash reporting |

## Security

Syncord is split into three realms with narrow, typed bridges between them:

- **Main** (trusted): patches windows, owns IPC, navigation policy, settings, integrity checks and the update worker.
- **Preload** (privileged): exposes a small bridge, only on trusted Discord origins.
- **Renderer** (not trusted): plugins and UI. No Node access, no raw IPC, no Discord token access.

Updates are signed with an Ed25519 key. The public key is compiled into the client and the Injector, so a tampered or downgraded release is refused. The update feed is served from `api.syncord.pro`; the client never follows a URL the feed supplies.

Report vulnerabilities privately through GitHub's **Security → Report a vulnerability** form on this repository rather than opening a public issue.

## Build from source

Requirements: [pnpm](https://pnpm.io) 12.6.0 and a Node.js version supported by it. The Injector additionally needs a Rust toolchain.

```bash
pnpm install
pnpm verify        # typecheck, tests, security scan, build
```

| Command | What it does |
| --- | --- |
| `pnpm build` | Builds `dist/main.js`, `dist/preload.js`, `dist/renderer.js` |
| `pnpm inject` | Builds and installs into your local Discord |
| `pnpm uninject` | Restores Discord's original `app.asar` |
| `pnpm sync` | Copies the current build into an existing install |
| `pnpm dev` | Rebuilds and syncs on every change (restart Discord to load it) |

Use `Syncord_DISCORD_PATH="/path/to/Discord.app" pnpm inject` for a non-standard install. Close Discord completely before injecting.

### Writing a plugin

Built-in plugins live in `src/renderer/plugins/`. Define one with `definePlugin`, declare the permissions it needs, and register it once in `src/renderer/plugins/index.ts`:

```ts
import { definePlugin } from "../api/plugin";

export const ExamplePlugin = definePlugin({
  id: "example",
  name: "Example",
  description: "Short description.",
  permissions: {},
  start(ctx) {
    ctx.log.info("started");
  },
});
```

Anything a plugin installs must be cleaned up when it stops (`ctx.disposable`). Plugins must declare the permissions they use and must not touch tokens, raw IPC or Node APIs.

## Project layout

```
src/main/       Electron main process: window patching, IPC, security, updater
src/preload/    Privileged bridge and renderer injection
src/renderer/   Webpack discovery, plugin API, settings UI, built-in plugins
src/shared/     IPC names, public types, release policy
src/security/   Policy logic shared between realms
injector/       Native installer (Rust + Tauri)
services/       Cloudflare Worker: ecosystem API and update feed
scripts/        Build, release and test tooling
```

## License

[ISC](LICENSE). Syncord is not affiliated with or endorsed by Discord Inc.
