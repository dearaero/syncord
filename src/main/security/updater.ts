/**
 * Update service (main process).
 *
 * Owns everything privileged about auto-update: the outbound request, the
 * signature check, the download, and the hand-off to the Injector. The renderer
 * never touches the network, the filesystem or a process handle for updates —
 * it asks a question and gets an answer.
 *
 * ── What this module deliberately cannot do ──────────────────────────────────
 *
 * It **never writes into a Discord install.** The whole point of moving
 * injection out of the main process is that the running client is not the thing
 * that rewrites its own `main.js`. The download lands in a staging directory
 * under Syncord's own user-data path, and the actual write is performed by the
 * Injector, a separate process, after the user sees what is about to happen.
 * That keeps the blast radius of a bug here to a file in our own directory
 * rather than a client that will not boot.
 *
 * ── Trust model ─────────────────────────────────────────────────────────────
 *
 * GitHub is *not* trusted. It is a transport. The release descriptor is signed
 * with the release key whose public half is compiled into this binary, and the
 * signature covers each asset's SHA-256. So the security property does not
 * depend on the transport being honest:
 *
 *   - a hostile release descriptor fails the signature check and is discarded;
 *   - a redirect to any host at all can only cause a *failed* download, because
 *     bytes that do not hash to the signed digest are thrown away;
 *   - a compromised GitHub account can publish a new release, but cannot make
 *     an existing client install it silently — that requires the private key.
 *
 * Redirects are followed (GitHub's asset endpoint 302s to a signed CDN URL) but
 * are bounded in count, forced to `https:`, and irrelevant to integrity for the
 * reason above. They are bounded in *availability* too: count, total bytes,
 * wall-clock time, and the redirect chain is re-resolved from scratch each hop.
 */
import { spawn } from "node:child_process";
import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

import { LOG_PREFIX, VERSION } from "../../shared/constants";
import { bootLog } from "../../shared/bootLog";
import {
  RELEASE_HOSTS,
  RELEASE_LIMITS,
  buildAssetDownloadUrl,
  buildReleaseFeedUrl,
  canonicalReleasePayload,
  evaluateReleaseDescriptor,
  evaluateUpdateOffer,
  isReleaseChannel,
  type ReleaseAsset,
  type ReleaseChannel,
  type ReleaseDescriptor,
  type UpdateOffer,
  type ReleasePlatform,
} from "../../shared/release";
import { isPrivateOrReservedHost } from "../../security/url";
import { SyncordUserDataPath, securityLog } from "./core";
import { isLockdown } from "./modes";
import { verifyDetachedSignature, signingKeyPresent } from "./signing";

/**
 * Transport ceilings.
 *
 * Separate from `RELEASE_LIMITS` because these bound *this process's* resource
 * use during a fetch, not the shape of an accepted document. A response that
 * trips one of these is destroyed mid-stream; it is never buffered first.
 */
const TRANSPORT_LIMITS = {
  timeoutMs: 15_000,
  maxRedirects: 3,
  /** Header block ceiling, before any body is read. */
  maxHeaderBytes: 16 * 1024,
} as const;

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "handing-off"
  | "handed-off"
  | "awaiting-restart"
  | "error";

export type UpdateStatus = {
  phase: UpdatePhase;
  /** Safe to render. Never contains a filesystem path or a raw server message. */
  detail: string;
  /**
   * The running build, as compiled in.
   *
   * Separate from `current` because `current` is the version *being compared
   * against* the release and is deliberately allowed to be a non-version
   * string; the Security Center needs the build it is actually running, and
   * conflating the two is how an unbundled or keyless build renders as
   * "v0.0.0" instead of "vunbuilt".
   */
  build: string;
  current: string;
  latest: string | null;
  channel: ReleaseChannel;
  platform: ReleasePlatform | null;
  /** 0..1 while downloading, otherwise null. */
  progress: number | null;
  /** Version staged on disk and awaiting hand-off, if any. */
  stagedVersion: string | null;
  /** Why the last attempt failed, for the Security Center and the log. */
  lastError: string | null;
};

let status: UpdateStatus = {
  phase: "idle",
  detail: "Update checks have not run yet.",
  build: VERSION,
  current: VERSION,
  latest: null,
  channel: "stable",
  platform: null,
  progress: null,
  stagedVersion: null,
  lastError: null,
};

/** The last accepted descriptor. Kept so `stageUpdate` cannot be pointed elsewhere. */
let accepted: { descriptor: ReleaseDescriptor; asset: ReleaseAsset } | null = null;

/**
 * In-flight guard.
 *
 * `checkForUpdate` and `stageUpdate` are both reachable from a renderer that
 * could be driven by a loop, so a second call while one is running is refused
 * rather than queued. Two concurrent downloads would race on the same staging
 * file and the second would corrupt the first.
 */
let busy = false;
let checkGeneration = 0;
let pendingWorker: ReturnType<typeof spawn> | null = null;
let restartRequested = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

export function updateStatus(): UpdateStatus {
  return { ...status };
}

/**
 * Record a status change, tell the subscribers, and leave a line in the boot log.
 *
 * -- Why the log line is here and not at the call sites --
 *
 * Every branch in this file ends in `setStatus`, and until now that was the whole
 * of its behaviour: the status was correct, the settings panel showed it, and
 * nothing was written anywhere. So when the client stopped finding updates the
 * only evidence was an absent dot in a titlebar, and the reason -- a build with no
 * signing key, a feed that 404s, a descriptor rejected on a format rule -- had to
 * be guessed at from outside a running Electron process.
 *
 * Putting it here means a branch cannot forget, and it means the log records what
 * the user would have been told rather than what a developer assumed. Both matter:
 * this file has now had three separate bugs that each produced a correct,
 * plausible and completely unhelpful status.
 *
 * Logged on a **phase change** only. `stageUpdate` calls this on every progress
 * tick, and a boot log with one line per percent is a boot log nobody reads.
 */
function setStatus(patch: Partial<UpdateStatus>): void {
  const previousPhase = status.phase;
  status = { ...status, ...patch };

  if (status.phase !== previousPhase) {
    const version = status.latest === null ? "-" : status.latest;
    const line =
      `update ${previousPhase} -> ${status.phase} · latest=${version} · ` +
      `platform=${status.platform ?? "-"} · channel=${status.channel}` +
      (status.lastError === null ? "" : ` · reason=${status.lastError}`);

    // `bootLog` has no levels, so the tag is in the line. `UPDATE FAILED` for the
    // one a human needs to go and read, because it is the phase that produces no
    // visible change anywhere in the UI.
    if (status.phase === "error") {
      bootLog(`UPDATE FAILED: ${line} — ${status.detail}`);
    } else {
      bootLog(`[update] ${line}`);
    }
  }

  updateSubscribers.forEach((listener) => {
    // A listener that throws must not take down the update service; the status
    // is already recorded, and the next event will carry the same truth.
    try {
      listener(status);
    } catch {
      /* ignored on purpose */
    }
  });
}

type Subscriber = (status: UpdateStatus) => void;
const updateSubscribers = new Set<Subscriber>();

/** Subscribe to status changes. Returns an unsubscribe function. */
export function onUpdateStatus(listener: Subscriber): () => void {
  updateSubscribers.add(listener);
  return () => {
    updateSubscribers.delete(listener);
  };
}

/** This client's platform, as the release pipeline names it. */
export function currentPlatform(): ReleasePlatform | null {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (arch === null) return null;
  if (process.platform === "win32") return `windows-${arch}`;
  if (process.platform === "darwin") return `mac-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  return null;
}

function stagingRoot(): string {
  return path.join(SyncordUserDataPath(), "staging");
}

/**
 * Staging directory for one version.
 *
 * The version segment is `normalizeVersion`-clean by the time it arrives (it
 * came out of a validated descriptor), and this function re-checks it anyway.
 * A path segment that has not been through `normalizeVersion` in *this* frame
 * does not get used.
 */
function stagingDirFor(version: string): string | null {
  if (!/^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?$/.test(version)) return null;
  return path.join(stagingRoot(), version);
}

// ── Transport ─────────────────────────────────────────────────────────────────

type FetchOptions = {
  /** Hard ceiling on the response body. */
  maxBytes: number;
  /** Called with each chunk so a download can report progress. */
  onProgress?: (received: number) => void;
  /** Resolve to a file path to stream to disk instead of buffering. */
  sinkPath?: string;
};

type FetchResult =
  | { ok: true; body: Buffer; finalUrl: string }
  | { ok: false; reason: string };

/**
 * One HTTPS GET, bounded in redirects, bytes, headers and time.
 *
 * `host` is passed in rather than derived from a caller-supplied URL string on
 * purpose: the two hosts in `RELEASE_HOSTS` are the only places this function
 * can be pointed, and the redirect target is re-checked against the same rules
 * on every hop.
 */
function httpsGet(url: string, options: FetchOptions, redirectsLeft: number): Promise<FetchResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: FetchResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      finish({ ok: false, reason: "url could not be parsed" });
      return;
    }

    if (parsed.protocol !== "https:") {
      finish({ ok: false, reason: `refusing a non-https request (${parsed.protocol})` });
      return;
    }
    // The redirect target is attacker-influenceable, so it gets the same
    // treatment as the original URL rather than being trusted because it came
    // from a server. A redirect to a private address is refused here.
    if (isPrivateOrReservedHost(parsed.hostname)) {
      finish({ ok: false, reason: "refusing a request to a private or reserved address" });
      return;
    }

    const request = https.get(
      parsed,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `Syncord/${VERSION}`,
          "x-github-api-version": "2022-11-28",
        },
        // Certificate and hostname verification are Node's defaults. They are
        // left alone deliberately: turning either off would defeat the digest
        // check's usefulness for availability and would be indefensible in a
        // module that downloads code.
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          response.resume();
          if (typeof location !== "string" || location.length === 0) {
            finish({ ok: false, reason: "redirect without a location" });
            return;
          }
          if (redirectsLeft <= 0) {
            finish({ ok: false, reason: "too many redirects" });
            return;
          }
          let next: string;
          try {
            next = new URL(location, parsed).toString();
          } catch {
            finish({ ok: false, reason: "redirect target could not be parsed" });
            return;
          }
          // Re-entered from scratch: the new URL is re-parsed, re-checked for
          // scheme and for a reserved address, and gets its own byte budget.
          void httpsGet(next, options, redirectsLeft - 1).then(finish);
          return;
        }

        if (status !== 200) {
          response.resume();
          finish({ ok: false, reason: `unexpected response status ${status}` });
          return;
        }

        // Header-block ceiling, checked before a single body byte is read. Node
        // has its own limits, but they are generous; this is the point where a
        // hostile endpoint stops being able to make us allocate.
        if (response.rawHeaders.join("").length > TRANSPORT_LIMITS.maxHeaderBytes) {
          response.destroy();
          finish({ ok: false, reason: "response headers are larger than allowed" });
          return;
        }

        const declared = Number(response.headers["content-length"] ?? Number.NaN);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          finish({ ok: false, reason: "response is larger than the allowed size" });
          return;
        }

        const sink =
          options.sinkPath === undefined
            ? null
            : fs.createWriteStream(options.sinkPath, { mode: 0o600, flags: "w" });

        const chunks: Buffer[] = [];
        let received = 0;

        const abort = (reason: string): void => {
          response.destroy();
          sink?.destroy();
          finish({ ok: false, reason });
        };

        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          // The running total is checked per chunk, not per response, so an
          // undeclared or lying `content-length` still cannot fill the disk or
          // the heap.
          if (received > options.maxBytes) {
            abort("response exceeded the allowed size");
            return;
          }
          options.onProgress?.(received);
          if (sink === null) chunks.push(chunk);
          else if (!sink.write(chunk)) {
            // Respect backpressure rather than buffering the remainder in memory.
            response.pause();
            sink.once("drain", () => {
              response.resume();
            });
          }
        });

        response.on("aborted", () => {
          sink?.destroy();
          finish({ ok: false, reason: "connection closed before the response completed" });
        });

        response.on("error", () => {
          sink?.destroy();
          finish({ ok: false, reason: "the response could not be read" });
        });

        const complete = (): void => {
          if (sink === null) {
            finish({ ok: true, body: Buffer.concat(chunks), finalUrl: parsed.toString() });
            return;
          }
          sink.end(() => {
            finish({ ok: true, body: Buffer.alloc(0), finalUrl: parsed.toString() });
          });
          sink.on("error", () => {
            finish({ ok: false, reason: "the download could not be written to disk" });
          });
        };

        response.on("end", complete);
      },
    );

    request.setTimeout(TRANSPORT_LIMITS.timeoutMs, () => {
      request.destroy();
      finish({ ok: false, reason: "the request timed out" });
    });
    request.on("error", () => {
      finish({ ok: false, reason: "the request could not be completed" });
    });
  });
}

// ── Public operations ─────────────────────────────────────────────────────────

/**
 * Ask GitHub for the current release, verify it, and decide whether it is an
 * update. Never throws; failures land in `lastError` and the status phase.
 */
export async function checkForUpdate(options: { channel?: unknown } = {}): Promise<UpdateStatus> {
  if (busy || status.phase === "awaiting-restart") {
    return updateStatus();
  }

  accepted = null;
  const generation = ++checkGeneration;
  const channel: ReleaseChannel = isReleaseChannel(options.channel) ? options.channel : "stable";
  const platform = currentPlatform();

  if (isLockdown()) {
    accepted = null;
    setStatus({
      phase: "error",
      detail: "Update checks are disabled while Emergency Lockdown is active.",
      lastError: "lockdown",
    });
    return updateStatus();
  }

  if (!signingKeyPresent()) {
    // Refusing up front is better than fetching a descriptor we could never
    // check: it makes an unsigned development build obvious instead of letting
    // it look like a network problem later.
    setStatus({
      phase: "error",
      channel,
      platform,
      detail: "This build has no release signing key, so updates cannot be verified.",
      lastError: "no-signing-key",
    });
    return updateStatus();
  }

  if (platform === null) {
    setStatus({
      phase: "error",
      channel,
      platform: null,
      detail: "This platform is not covered by Syncord releases.",
      lastError: "unsupported-platform",
    });
    return updateStatus();
  }

  busy = true;
  setStatus({ phase: "checking", channel, platform, latest: null, stagedVersion: null, progress: null, detail: "Checking for updates…", lastError: null });

  try {
    const feedUrl = buildReleaseFeedUrl(channel);
    if (feedUrl === null) {
      setStatus({ phase: "error", detail: "The configured release repository is not valid.", lastError: "bad-repo" });
      return updateStatus();
    }

    const response = await httpsGet(feedUrl, { maxBytes: RELEASE_LIMITS.maxDescriptorBytes }, TRANSPORT_LIMITS.maxRedirects);
    if (generation !== checkGeneration) return updateStatus();
    if (!response.ok) {
      setStatus({ phase: "error", detail: `The update check failed: ${response.reason}.`, lastError: response.reason });
      return updateStatus();
    }

    // The feed answers with the signed descriptor itself. Nothing in the
    // transport (host, path, headers) is trusted; the Ed25519 signature below is.
    let embedded: unknown;
    try {
      embedded = JSON.parse(response.body.toString("utf-8"));
    } catch {
      setStatus({ phase: "error", detail: "The release information was not valid JSON.", lastError: "bad-json" });
      return updateStatus();
    }

    const verdict = evaluateReleaseDescriptor(embedded);
    if (!verdict.ok) {
      setStatus({ phase: "error", detail: `The release information was rejected: ${verdict.reason}.`, lastError: "descriptor" });
      return updateStatus();
    }

    const descriptor = verdict.descriptor;
    if (!verifyDetachedSignature(canonicalReleasePayload(descriptor), descriptor.signature)) {
      // The single most important line in this file. An unsigned or forged
      // descriptor is discarded here and never reaches the comparison below.
      securityLog().record({
        type: "PLUGIN_INTEGRITY_FAIL",
        reason: "release descriptor signature is invalid",
        host: RELEASE_HOSTS.api,
      });
      setStatus({
        phase: "error",
        detail: "The release information is not correctly signed and was discarded.",
        lastError: "bad-signature",
      });
      accepted = null;
      return updateStatus();
    }

    const offer = evaluateUpdateOffer(descriptor, VERSION, platform);
    accepted = offer.available && offer.asset !== null ? { descriptor, asset: offer.asset } : null;

    if (!offer.available) {
      setStatus({
        phase: "up-to-date",
        latest: offer.latest,
        detail: offer.reason === "already up to date" ? `Syncord ${offer.current} is up to date.` : offer.reason,
        lastError: null,
      });
      return updateStatus();
    }

    setStatus({
      phase: "available",
      latest: offer.latest,
      detail: `Syncord ${offer.latest} is available.`,
      lastError: null,
    });
    return updateStatus();
  } catch {
    if (generation === checkGeneration) {
      accepted = null;
      setStatus({phase:"error",detail:"The update check could not be completed. Please try again.",lastError:"check-failed"});
    }
    return updateStatus();
  } finally {
    busy = false;
  }
}

/**
 * Download the accepted release bundle and verify it against the signed digest.
 *
 * Writes only into Syncord's own staging directory. On success the phase is
 * `ready` and the Injector can be pointed at the staged file.
 */
export async function stageUpdate(): Promise<UpdateStatus> {
  if (busy || status.phase === "awaiting-restart") return updateStatus();
  if (isLockdown()) {
    setStatus({ phase: "error", detail: "Updates are disabled while Emergency Lockdown is active.", lastError: "lockdown" });
    return updateStatus();
  }
  if (accepted === null) {
    setStatus({ phase: "error", detail: "There is no verified update ready to download.", lastError: "nothing-staged" });
    return updateStatus();
  }

  const { descriptor, asset } = accepted;
  busy = true;
  setStatus({ phase: "downloading", progress: 0, detail: `Downloading Syncord ${descriptor.release}…`, lastError: null });

  const dir = stagingDirFor(descriptor.release);
  if (dir === null) {
    setStatus({ phase: "error", detail: "The release version is not usable as a staging path.", lastError: "bad-version" });
    busy = false;
    return updateStatus();
  }

  const downloadUrl = buildAssetDownloadUrl(descriptor.release, asset);
  if (downloadUrl === null) {
    setStatus({ phase: "error", detail: "The release asset address could not be built.", lastError: "bad-url" });
    busy = false;
    return updateStatus();
  }

  // Download to a temporary name and rename into place, so an interrupted
  // download can never be mistaken for a complete staged bundle: a partial
  // file has no digest match and would be discarded anyway, but the rename
  // means nothing downstream has to wonder.
  const tempPath = path.join(stagingRoot(), `${descriptor.release}.part`);

  try {
    fs.mkdirSync(stagingRoot(), { recursive: true, mode: 0o700 });
    fs.rmSync(tempPath, { force: true });

    const response = await httpsGet(
      downloadUrl,
      {
        maxBytes: asset.size,
        sinkPath: tempPath,
        onProgress: (received) => {
          setStatus({ progress: Math.min(1, received / Math.max(1, asset.size)) });
        },
      },
      TRANSPORT_LIMITS.maxRedirects,
    );

    if (!response.ok) {
      fs.rmSync(tempPath, { force: true });
      setStatus({ phase: "error", progress: null, detail: `The download failed: ${response.reason}.`, lastError: response.reason });
      return updateStatus();
    }

    const digest = await sha256File(tempPath);
    if (digest !== asset.sha256) {
      // The digest came from the signed descriptor, so a mismatch means the
      // bytes are not the release — corruption, a truncated transfer, or a
      // substituted file. The file is deleted rather than kept for inspection.
      fs.rmSync(tempPath, { force: true });
      securityLog().record({ type: "PLUGIN_INTEGRITY_FAIL", reason: "downloaded release digest mismatch" });
      setStatus({
        phase: "error",
        progress: null,
        detail: "The downloaded file did not match the signed checksum and was discarded.",
        lastError: "digest-mismatch",
      });
      return updateStatus();
    }

    fs.mkdirSync(stagingRoot(), { recursive: true, mode: 0o700 });
    try {
      writeStagedRelease(dir, descriptor.release, asset.name, asset.sha256, tempPath);
    } catch (err) {
      // The download is already verified at this point, so a throw here is a
      // bug in the descriptor's shape rather than a network problem. Remove the
      // partial file so a retry starts clean.
      fs.rmSync(tempPath, { force: true });
      const reason = err instanceof Error ? err.message : "unknown";
      setStatus({
        phase: "error",
        progress: null,
        detail: "The update could not be staged.",
        lastError: reason,
      });
      return updateStatus();
    }

    setStatus({
      phase: "ready",
      progress: 1,
      stagedVersion: descriptor.release,
      detail: `Syncord ${descriptor.release} is downloaded and verified.`,
    });
    return updateStatus();
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    const reason = err instanceof Error ? err.message : "unknown";
    setStatus({ phase: "error", progress: null, detail: "The update could not be prepared.", lastError: reason });
    return updateStatus();
  } finally {
    busy = false;
  }
}

/** Streaming SHA-256, so a large bundle is never held in memory. */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// ── Injector discovery ────────────────────────────────────────────────────────

/**
 * Where the Syncord Installer is looked for, per platform.
 *
 * A fixed list of read-only candidates, in priority order. Nothing here is
 * derived from a download, a registry, or a search path — the set is small
 * because a large set is a large attack surface, and every entry is a location
 * the packaging step in `injector/scripts/package.mjs` can actually produce.
 *
 * A user-configured path still wins; this is the fallback that makes the
 * common case not require one.
 */
function injectorCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const localAppData = process.env.LOCALAPPDATA ?? "";

  if (process.platform === "darwin") {
    // The `.app` bundle: the executable is at Contents/MacOS, which is the name
    // `Info.plist`'s CFBundleExecutable declares, not the directory name.
    return [
      "/Applications/Syncord Injector.app/Contents/MacOS/Syncord Injector",
      path.join(home, "Applications", "Syncord Injector.app", "Contents", "MacOS", "Syncord Injector"),
      "/Applications/Syncord Installer.app/Contents/MacOS/Syncord Injector",
      path.join(home, "Applications", "Syncord Installer.app", "Contents", "MacOS", "Syncord Injector"),
      // The bare name too, for a user who unpacked the archive without the
      // bundle. `package.mjs` produces exactly that at the archive root.
      path.join(home, "Applications", "Syncord Installer", "syncord-injector"),
      "/usr/local/bin/syncord-injector",
    ];
  }

  if (process.platform === "win32") {
    return [
      path.join(localAppData, "Syncord", "syncord-injector.exe"),
      path.join(home, "AppData", "Local", "Syncord", "syncord-injector.exe"),
      path.join(home, "syncord-injector.exe"),
    ];
  }

  return [
    path.join(home, ".local", "share", "Syncord", "syncord-injector"),
    path.join(home, ".local", "bin", "syncord-injector"),
    "/usr/local/bin/syncord-injector",
    "/usr/bin/syncord-injector",
  ];
}

/**
 * Is this path a regular file we are willing to execute?
 *
 * `lstat`, not `stat`. The difference is the whole point: `stat` follows
 * symlinks, so a link at `~/.local/bin/syncord-injector` pointing at something
 * the user did not put there would pass every other check while executing a
 * different file. `lstat` reports the link itself, which is not a regular file,
 * so a discovered candidate that is a symlink is refused outright.
 *
 * Only *discovered* candidates go through this with `rejectSymlinks` set. A path
 * the user typed into a setting is allowed to be a symlink, because a symlinked
 * install is an ordinary thing to want and refusing it would break a legitimate
 * setup without adding anything: the user chose that path. It is still required
 * to resolve to a regular file.
 *
 * Exported so the rule itself can be asserted. The symlink distinction is
 * invisible in a code review — `lstatSync` and `statSync` differ by four
 * characters — and it is the difference between "the candidate is a file" and
 * "the candidate is a link to whatever happens to be there today".
 */
export function isExecutableFile(candidate: string, rejectSymlinks: boolean): boolean {
  try {
    if (rejectSymlinks) {
      if (!fs.lstatSync(candidate).isFile()) return false;
    } else if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the Syncord Installer, or `null`.
 *
 * Exported because the renderer needs to tell the user *where* it looked when
 * nothing is found, and because the candidates are worth asserting directly.
 */
export function discoverInjector(): string | null {
  for (const candidate of injectorCandidates()) {
    if (candidate.length === 0) continue;
    if (isExecutableFile(candidate, true)) return candidate;
  }
  return null;
}

/** For the error message: the places that were looked in, minus the noisy ones. */
export function injectorSearchPaths(): string[] {
  return injectorCandidates().filter((p) => p.length > 0);
}

// ── Hand-off ──────────────────────────────────────────────────────────────────

/** How long the Installer gets before we stop waiting. */
const HANDOFF_TIMEOUT_MS = 120_000;

/** Captured output from the Installer, bounded. */
function collectStream(stream: NodeJS.ReadableStream | null, limit = 4096): () => string {
  let text = "";
  stream?.on("data", (chunk: Buffer) => {
    if (text.length < limit) text += chunk.toString("utf-8");
  });
  return () => text.slice(0, limit);
}

/**
 * Move a verified download into its staging directory and describe it.
 *
 * Exported for one reason: the end-to-end test needs to produce a staged update
 * that is byte-for-byte what this function produces, and a test that builds its
 * own copy of the layout is a test that passes while the real layout changes.
 * The asset name and the digest are both validated here as well as by the
 * Injector, because this is the point where a name from a signed document
 * becomes a filename.
 *
 * Returns the path to `release.json`, which is what gets handed to the
 * Injector.
 */
export function writeStagedRelease(
  dir: string,
  version: string,
  assetName: string,
  digest: string,
  downloadedFrom: string,
): string {
  // The descriptor is validated, so this cannot currently fail — but a name from
  // a document is a filename the moment it is joined to a path, and this is the
  // cheapest possible place to be sure.
  if (assetName !== path.basename(assetName) || assetName.length === 0) {
    throw new Error("the release asset name is not a plain filename");
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("the release asset digest is not a sha-256 hex string");
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Rename, not copy: a staging directory that ever contained a partial file
  // would be indistinguishable from a complete one to anything that did not
  // re-check the digest.
  fs.renameSync(downloadedFrom, path.join(dir, assetName));
  const releasePath = path.join(dir, "release.json");
  fs.writeFileSync(
    releasePath,
    `${JSON.stringify({ version, asset: assetName, sha256: digest }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return releasePath;
}

/**
 * Prepare an update in a detached native worker. Its version-bound acknowledgment
 * proves verification and retention only. The worker applies it after Discord
 * quits, then reopens the same install. A narrow explicit IPC requests app.quit.
 * Isolated non-Discord CLI hosts retain synchronous --apply-staged compatibility.
 * No shell or renderer-supplied install directory is accepted.
 */
export async function handOffToInjector(injectorPath: unknown): Promise<UpdateStatus> {
  if (busy || status.phase === "awaiting-restart") return updateStatus();
  if (isLockdown()) {
    setStatus({ phase: "error", detail: "Updates are disabled while Emergency Lockdown is active.", lastError: "lockdown" });
    return updateStatus();
  }
  if (status.phase !== "ready" || status.stagedVersion === null) {
    setStatus({ phase: "error", detail: "There is no verified update to install.", lastError: "nothing-staged" });
    return updateStatus();
  }

  // Discovery first, so the common case needs no configured path at all, and an
  // explicitly configured one still wins when it is set.
  const resolved = resolveInjector(injectorPath);
  if (!resolved.ok) {
    setStatus({
      phase: "error",
      detail: resolved.message,
      lastError: "no-injector",
    });
    return updateStatus();
  }

  const staged = path.join(stagingDirFor(status.stagedVersion) ?? "", "release.json");
  if (!fs.existsSync(staged)) {
    setStatus({ phase: "error", detail: "The staged update is no longer on disk.", lastError: "staging-gone" });
    return updateStatus();
  }

  busy = true;
  setStatus({ phase: "handing-off", progress: null, detail: "Installing the update with the Syncord Installer…" });

  const outcome = await runInjector(resolved.path, staged, status.stagedVersion);
  busy = false;

  if (outcome.ok && outcome.queued && isLockdown()) {
    cancelPendingUpdate();
  } else if (outcome.ok && outcome.queued && (pendingWorker === null || pendingWorker.exitCode !== null || pendingWorker.signalCode !== null)) {
    setStatus({ phase: "error", lastError: "worker-stopped", detail: "The update worker stopped before Discord restarted. Try installing the update again." });
  } else if (outcome.ok) {
    setStatus({
      phase: outcome.queued ? "awaiting-restart" : "handed-off",
      detail: outcome.queued
        ? `Syncord ${status.stagedVersion} is verified and ready. Restart Discord to install it.`
        : `Syncord ${status.stagedVersion} was installed. Restart Discord to load it.`,
    });
  } else {
    setStatus({
      phase: "error",
      progress: null,
      detail: outcome.message,
      lastError: outcome.code,
    });
  }
  return updateStatus();
}

type InjectorOutcome = { ok: true; queued?: boolean } | { ok: false; code: string; message: string };

/**
 * The configured path, or a discovered one, or a reason there is neither.
 *
 * ── Why this is a tagged result and not a bare string ────────────────────────
 *
 * The first version returned `string | string` — a path, or a sentence explaining
 * why there is none — and the caller tested `typeof resolved !== "string"`. That
 * test is never true, so with no installer found the code went on to `spawn` the
 * *error message* as a program name. The end-to-end test caught it by running on
 * a machine with no Syncord Installer in any candidate location, which is the
 * state every user is in before they download one.
 *
 * A sentence and a filesystem path are both strings, and no amount of care at
 * the call site fixes that. A tagged result makes the two impossible to confuse.
 */
type ResolvedInjector = { ok: true; path: string } | { ok: false; message: string };

function resolveInjector(configured: unknown): ResolvedInjector {
  if (typeof configured === "string" && configured.length > 0) {
    if (!path.isAbsolute(configured)) {
      return {
        ok: false,
        message: "The Syncord Installer path is not an absolute path. Set it again in Settings.",
      };
    }
    // A user-configured path may be a symlink; it still has to resolve to a
    // regular file, and the *resolved* path is what gets executed so the
    // argument the Injector sees is not a link.
    if (!isExecutableFile(configured, false)) {
      return { ok: false, message: "The Syncord Installer could not be found at the configured path." };
    }
    return { ok: true, path: fs.realpathSync(configured) };
  }

  const found = discoverInjector();
  if (found !== null) return { ok: true, path: found };

  return {
    ok: false,
    message:
      "The Syncord Installer was not found. Download it from the Syncord releases page " +
      "and put it in one of the standard locations, or set its path in Settings.",
  };
}

/** Spawn the Installer, wait for it, and turn its exit code into an outcome. */
/** A write target is derived from Electron, never from the renderer's request. */
function currentDiscordRoot(): string | null {
  const candidates: string[] = [];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resources === "string") candidates.push(resources);
  if (typeof app.getAppPath === "function") {
    const application = app.getAppPath();
    if (typeof application === "string" && ["app", "app.asar", "_app.asar"].includes(path.basename(application))) candidates.push(path.dirname(application));
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(path.join(candidate, "app")) || !fs.existsSync(path.join(candidate, "_app.asar"))) continue;
    return process.platform === "darwin" && path.basename(path.dirname(candidate)) === "Contents"
      ? path.dirname(path.dirname(candidate)) : path.dirname(candidate);
  }
  return null;
}

/** Emergency Lockdown cancels a prepared worker before any application quit. */
export function cancelPendingUpdate(): void {
  if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null; }
  restartRequested = false;
  if (pendingWorker !== null) { pendingWorker.kill(); pendingWorker = null; }
  ++checkGeneration;
  accepted = null;
  setStatus({ phase: "error", lastError: "lockdown", detail: "Updates are disabled and any prepared update was cancelled by Emergency Lockdown." });
}

/** Only an explicit UI gesture can close Discord, and only while its worker is alive. */
export function restartForUpdate(): boolean {
  if (isLockdown() || status.phase !== "awaiting-restart" || pendingWorker === null || pendingWorker.exitCode !== null || pendingWorker.signalCode !== null || restartRequested) return false;
  restartRequested = true;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!isLockdown() && pendingWorker !== null && pendingWorker.exitCode === null && pendingWorker.signalCode === null) app.quit();
    else restartRequested = false;
  }, 100);
  return true;
}

function runInjector(binary: string, stagedRelease: string, version: string): Promise<InjectorOutcome> {
  const root = currentDiscordRoot();
  if (root !== null) return queueInjector(binary, stagedRelease, version, root);
  // Isolated/non-Discord callers can still use the existing synchronous CLI.

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["--apply-staged", stagedRelease], {
        // No shell, so both arguments are filenames and never a command line.
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      resolve({ ok: false, code: "spawn-failed", message: `The Syncord Installer could not be started: ${reason}` });
      return;
    }

    const stdout = collectStream(child.stdout);
    const stderr = collectStream(child.stderr);

    let settled = false;
    const finish = (outcome: InjectorOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    // A bound, because a process that hangs must not hold the UI in
    // "installing" forever. It is killed rather than left running, since a
    // half-finished install is worse than a reported failure.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* the process may already be gone */
      }
      finish({
        ok: false,
        code: "timeout",
        message: "The Syncord Installer did not finish in time. Nothing was changed; try again.",
      });
    }, HANDOFF_TIMEOUT_MS);

    child.on("error", (err) => {
      finish({
        ok: false,
        code: "spawn-failed",
        message: `The Syncord Installer could not be started: ${err.message}`,
      });
    });

    child.on("close", (code, signal) => {
      if (signal !== null) {
        finish({
          ok: false,
          code: "killed",
          message: `The Syncord Installer was stopped before it finished. Nothing was changed.`,
        });
        return;
      }
      resolveExit(code ?? -1, `${stderr()}${stdout()}`, finish);
    });
  });
}

/** The acknowledgment proves the worker verified and retained the exact payload. */
function queueInjector(binary: string, stagedRelease: string, version: string, root: string): Promise<InjectorOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["--wait-and-apply-staged", stagedRelease], {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SYNCORD_DISCORD_PATH: root },
      });
    } catch {
      resolve({ ok: false, code: "spawn-failed", message: "The Syncord Injector could not start the update worker." });
      return;
    }
    let acknowledged = false;
    let settled = false;
    let output = "";
    const stderr = collectStream(child.stderr);
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish({ ok: false, code: "timeout", message: "The Injector did not verify the update in time. Discord was not closed." });
    }, HANDOFF_TIMEOUT_MS);
    const finish = (outcome: InjectorOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-8192);
      if (!output.split(/\r?\n/).includes(`SYNCORD_UPDATE_READY:${version}`)) return;
      acknowledged = true;
      pendingWorker = child;
      restartRequested = false;
      // The native worker tolerates closed pipes and records its result to staging.
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      finish({ ok: true, queued: true });
    });
    child.on("error", () => finish({ ok: false, code: "spawn-failed", message: "The Injector could not start its update worker." }));
    child.on("exit", (code) => {
      if (!acknowledged) {
        const error = `${stderr()}${output}`;
        if (error.includes("unknown argument") || error.includes("--wait-and-apply-staged") && code === 3) {
          finish({ ok: false, code: "old-injector", message: "This Injector needs a one-time upgrade to support safe updates. Install the new Injector; later client updates use the same binary." });
        } else resolveExit(code ?? -1, error, (outcome) => finish(outcome.ok
          ? { ok: false, code: "missing-ack", message: "The Injector exited without confirming the update is ready. Discord was not closed." }
          : outcome));
        return;
      }
      if (pendingWorker !== child) return;
      pendingWorker = null;
      if (!restartRequested && status.phase === "awaiting-restart") {
        setStatus({ phase: "error", lastError: "worker-stopped", detail: "The update worker stopped before Discord restarted. Try installing the update again." });
      }
    });
  });
}

/**
 * Map the Injector's documented exit codes to something actionable.
 *
 * The codes are the Injector's contract (`injector/src-tauri/src/main.rs`):
 * 0 applied, 1 a write failure, 2 refused, 3 no target. Its stderr is written
 * for a human and is already specific, so it is passed through — with a length
 * bound, because it is still process output and this is still a renderer-bound
 * string.
 */
function resolveExit(code: number, output: string, finish: (outcome: InjectorOutcome) => void): void {
  const message = output.trim().split("\n").filter(Boolean).slice(0, 3).join(" ").trim();

  if (code === 0) {
    finish({ ok: true });
    return;
  }

  const code_name =
    code === 3 ? "no-target" : code === 2 ? "refused" : code === 1 ? "write-failed" : `exit-${code}`;

  const detail = message.length > 0 ? ` ${message.slice(0, 300)}` : "";
  const prefix =
    code === 3
      ? "The Syncord Installer could not find a Discord to install into."
      : code === 2
        ? "The Syncord Installer refused the update."
        : code === 1
          ? "The Syncord Installer could not write to the Discord install."
          : "The Syncord Installer did not complete.";

  finish({ ok: false, code: code_name, message: `${prefix}${detail}` });
}

/** Forget any accepted descriptor. Called when a check is disabled. */
export function resetUpdateState(): void {
  // Disabling checks must not orphan a verified worker waiting for a restart.
  if (status.phase === "awaiting-restart") return;
  ++checkGeneration;
  accepted = null;
  setStatus({
    phase: "idle",
    detail: "Update checks are turned off.",
    latest: null,
    progress: null,
    stagedVersion: null,
    lastError: null,
  });
  console.log(`${LOG_PREFIX} update state reset`);
}
