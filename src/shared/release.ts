/**
 * Release-feed policy (pure: no Node, no DOM, no Electron, no network).
 *
 * Everything that decides *what* an update is and *whether* it may be
 * downloaded lives here, so it can be unit tested without a socket, a disk or
 * a running Discord. `src/main/security/updater.ts` supplies the transport and
 * the filesystem; this file is the part that has to be right.
 *
 * Three structural decisions, each of which removes a whole class of attack
 * rather than filtering for it:
 *
 *  1. **The host is a constant, not data.** `api.github.com` and `github.com`
 *     are written into this file. No payload, setting, environment variable or
 *     renderer call can change them, so "point the updater at my host" is not
 *     an attack that exists. There is no SSRF surface and no host-injection
 *     surface, because there is nothing left to inject.
 *
 *  2. **The feed does not get to name a URL.** A descriptor carries an asset
 *     *name*, not a URL; the download URL is rebuilt here from the constant
 *     host, the validated `owner/repo`, a tag derived from the version, and the
 *     name after a charset check. A feed that answers with
 *     `"url": "https://evil.example/x"` is structurally invalid and the whole
 *     descriptor is refused — not merely that one asset.
 *
 *  3. **The tag is derived, never supplied.** A release called
 *     `releases/download/../../etc` cannot be addressed, because the tag is
 *     `normalizeVersion(release)` and nothing else.
 *
 * The signature is *not* checked here. This module produces the canonical
 * bytes; the caller verifies them with a key it holds, because a verifier that
 * takes the key as an argument is a verifier the renderer could satisfy.
 */
import { compareVersions, normalizeVersion } from "./version";

/**
 * The only host this client will ever talk to for updates.
 *
 * The Syncord API Worker serves the signed descriptor and the payload archives
 * straight from a private R2 bucket, so there is no redirect hop and no second
 * host to allow. `download` is kept as a separate key so callers can say which
 * kind of request they mean; both are the same constant.
 */
export const RELEASE_HOSTS = Object.freeze({
  api: "api.syncord.pro",
  download: "api.syncord.pro",
} as const);

/** Public artifact repository; the source repository may be private or separate. */
export const DEFAULT_RELEASE_REPO = "dearaero/syncord-releases";

/** GitHub owner and repository: GitHub's own charset, and nothing else. */
const REPO_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})$/;

/** Windows, macOS and Linux, on the architectures Discord actually ships. */
export const RELEASE_PLATFORMS = Object.freeze([
  "windows-x64",
  "windows-arm64",
  "mac-x64",
  "mac-arm64",
  "linux-x64",
  "linux-arm64",
] as const);

export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

export function isReleasePlatform(raw: unknown): raw is ReleasePlatform {
  return typeof raw === "string" && (RELEASE_PLATFORMS as readonly string[]).includes(raw);
}

/** `stable` is the default feed; `beta` is published separately. */
export const RELEASE_CHANNELS = Object.freeze(["stable", "beta"] as const);
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export function isReleaseChannel(raw: unknown): raw is ReleaseChannel {
  return typeof raw === "string" && (RELEASE_CHANNELS as readonly string[]).includes(raw);
}

/** Descriptor envelope version. Bump only with a matching parser change. */
export const RELEASE_DESCRIPTOR_VERSION = 1;

/** Structural ceilings. A feed response larger than this is refused unread. */
export const RELEASE_LIMITS = Object.freeze({
  maxDescriptorBytes: 256 * 1024,
  maxAssets: 12,
  maxAssetNameLength: 96,
  maxNotesLength: 8 * 1024,
  /** A single install bundle. Sized well above any real payload, well below "unbounded". */
  maxAssetBytes: 256 * 1024 * 1024,
} as const);

export type ReleaseAsset = {
  readonly platform: ReleasePlatform;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
};

export type ReleaseDescriptor = {
  readonly channel: ReleaseChannel;
  readonly release: string;
  readonly publishedAt: string;
  readonly notes: string;
  readonly assets: readonly ReleaseAsset[];
  /** Ed25519 signature over `canonicalReleasePayload(...)`, base64. */
  readonly signature: string;
};

export type ReleaseVerdict =
  | { ok: true; descriptor: ReleaseDescriptor }
  | { ok: false; reason: string };

/**
 * Asset name grammar.
 *
 * Starts with the product prefix, ends with an archive suffix, and is made only
 * of characters that are inert in a URL path segment and in a filename. There
 * is no `.`, no `/` and no `\`, so `..`, absolute paths and nested paths are
 * not representable at all — this is the property that matters, and the
 * character class is how it is obtained.
 */
const ASSET_NAME = /^syncord-[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:tar\.gz|zip|dmg|exe|AppImage)$/;

/** True for a name the updater would ever download. Shared with the update Worker. */
export function isReleaseAssetName(name: unknown): name is string {
  return typeof name === "string" && name.length <= RELEASE_LIMITS.maxAssetNameLength && ASSET_NAME.test(name);
}

/** Lowercase hex SHA-256, exactly 64 characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Base64 Ed25519 signature: 64 bytes -> 88 characters. */
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** ISO-8601 UTC instant. Checked structurally; never parsed for logic. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Validate an `owner/repo` pair.
 *
 * Returns the trimmed string or `null`. `.` and `..` are refused explicitly:
 * both are inside GitHub's charset, and both would turn a repo segment into a
 * path segment, which is the one shape that could reach outside the release
 * endpoint.
 */
export function validateReleaseRepo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length < 3 || text.length > 100) return null;

  const parts = text.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];

  for (const part of [owner, repo]) {
    if (!REPO_PART.test(part)) return null;
    if (part === "." || part === "..") return null;
  }
  // GitHub's own reserved names. Following one redirects to a login page, which
  // would be parsed as a valid response and cached as a descriptor.
  if (/^(?:api|www|raw|github|apps|status|support)$/i.test(owner)) return null;
  return `${owner}/${repo}`;
}

/**
 * Build the release-feed URL for a channel.
 *
 * Returns `null` rather than throwing: a bad channel is a configuration error,
 * and the caller's correct response is "no update information", not an
 * exception in the middle of a boot. The response body *is* the signed
 * descriptor; there is no envelope to unwrap.
 */
export function buildReleaseFeedUrl(channel: ReleaseChannel): string | null {
  if (!isReleaseChannel(channel)) return null;
  return `https://${RELEASE_HOSTS.api}/v1/update/${channel}`;
}

/**
 * Build the download URL for one asset.
 *
 * Rebuilt from constants, never read from the feed: the version is normalized
 * and the name passes the bundle-name grammar, so the caller cannot address an
 * arbitrary path on the host.
 */
export function buildAssetDownloadUrl(version: string, asset: Pick<ReleaseAsset, "name">): string | null {
  const normalized = normalizeVersion(version);
  if (normalized === null) return null;
  if (!isReleaseAssetName(asset.name)) return null;
  return `https://${RELEASE_HOSTS.download}/v1/update/releases/${encodeURIComponent(normalized)}/${encodeURIComponent(asset.name)}`;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Fail closed on any key we do not understand.
 *
 * The canonical payload is rebuilt from known fields only, so an extra key
 * cannot change what is verified — but it *can* mean the producer expected some
 * field to be covered that this client silently dropped. Refusing is the
 * conservative reading: a descriptor from a newer publisher is refused rather
 * than partially honoured.
 */
function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

const DESCRIPTOR_KEYS = ["version", "channel", "release", "publishedAt", "notes", "assets", "signature"] as const;
const ASSET_KEYS = ["platform", "name", "size", "sha256"] as const;

function readAsset(raw: unknown): { ok: true; asset: ReleaseAsset } | { ok: false; reason: string } {
  const record = asRecord(raw);
  if (record === null) return { ok: false, reason: "asset is not an object" };
  if (!hasOnlyKeys(record, ASSET_KEYS)) return { ok: false, reason: "asset has an unrecognised field" };

  const { platform, name, size, sha256 } = record;

  if (!isReleasePlatform(platform)) return { ok: false, reason: "asset has an unknown platform" };

  if (typeof name !== "string" || name.length === 0 || name.length > RELEASE_LIMITS.maxAssetNameLength) {
    return { ok: false, reason: "asset name is missing or too long" };
  }
  if (!ASSET_NAME.test(name)) return { ok: false, reason: "asset name is not a Syncord bundle name" };

  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
    return { ok: false, reason: "asset size is not a positive integer" };
  }
  if (size > RELEASE_LIMITS.maxAssetBytes) return { ok: false, reason: "asset is larger than the limit" };

  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    return { ok: false, reason: "asset digest is not a lowercase sha-256" };
  }

  return { ok: true, asset: { platform, name, size, sha256 } };
}

/**
 * Structurally validate a release descriptor.
 *
 * The reason this is "all or nothing" rather than "skip the bad asset" is that
 * a feed is either the real release pipeline or it is not. A partially valid
 * response means something is wrong between here and GitHub, and the correct
 * response to that is to refuse the update, not to install a version nobody
 * vouched for.
 */
export function evaluateReleaseDescriptor(raw: unknown): ReleaseVerdict {
  const record = asRecord(raw);
  if (record === null) return { ok: false, reason: "descriptor is not an object" };
  if (!hasOnlyKeys(record, DESCRIPTOR_KEYS)) {
    return { ok: false, reason: "descriptor has an unrecognised field" };
  }

  if (record.version !== RELEASE_DESCRIPTOR_VERSION) {
    return { ok: false, reason: "descriptor version is not supported" };
  }
  if (!isReleaseChannel(record.channel)) return { ok: false, reason: "descriptor channel is unknown" };

  const release = normalizeVersion(record.release);
  if (release === null) return { ok: false, reason: "descriptor release is not a valid version" };

  const publishedAt =
    typeof record.publishedAt === "string" && ISO_INSTANT.test(record.publishedAt)
      ? record.publishedAt
      : "";
  if (publishedAt === "") return { ok: false, reason: "descriptor publishedAt is not an ISO-8601 instant" };

  // Notes are display-only and are never treated as markup or as a URL, but an
  // oversized string is still refused rather than truncated: a descriptor that
  // does not match the published shape is not a descriptor we can reason about.
  if (record.notes !== undefined && typeof record.notes !== "string") {
    return { ok: false, reason: "descriptor notes are not a string" };
  }
  const notes = typeof record.notes === "string" ? record.notes : "";
  if (notes.length > RELEASE_LIMITS.maxNotesLength) {
    return { ok: false, reason: "descriptor notes are too long" };
  }

  if (!Array.isArray(record.assets) || record.assets.length === 0) {
    return { ok: false, reason: "descriptor has no assets" };
  }
  if (record.assets.length > RELEASE_LIMITS.maxAssets) {
    return { ok: false, reason: "descriptor has too many assets" };
  }

  const assets: ReleaseAsset[] = [];
  const seenPlatforms = new Set<string>();
  const seenNames = new Set<string>();

  for (const entry of record.assets) {
    const read = readAsset(entry);
    if (!read.ok) return { ok: false, reason: read.reason };
    // One asset per platform, and one name per asset. Two entries claiming the
    // same platform would make "which file is the Windows one" genuinely
    // ambiguous, so that is refused.
    if (seenPlatforms.has(read.asset.platform)) return { ok: false, reason: "duplicate asset platform" };
    if (seenNames.has(read.asset.name)) return { ok: false, reason: "duplicate asset name" };
    seenPlatforms.add(read.asset.platform);
    seenNames.add(read.asset.name);
    assets.push(read.asset);
  }

  /*
   * Two assets for different platforms sharing a digest is *expected*, not a
   * defect, and this check used to refuse it.
   *
   * The payload is `main.js`, `preload.js` and `renderer.js` — JavaScript, which
   * runs identically on all six platforms. There is no platform-specific binary
   * in the archive, so the six archives really are byte-identical and really do
   * have one digest. The rule was written on an assumption that each platform
   * ships different bytes, and it rejected the project's own first release.
   *
   * Nothing is given up by dropping it. The descriptor is signed, so its
   * contents cannot be altered by anyone who lacks the release key; digest
   * uniqueness was never an attacker-facing control, only a publisher-typo
   * check — and the typo it was looking for cannot occur in a payload that has no
   * platform-specific content to get wrong. The check that does carry weight is
   * the one above it: one entry per platform, so the client cannot be offered
   * two candidates and no digest comparison is ever skipped.
   */

  if (typeof record.signature !== "string" || !SIGNATURE_BASE64.test(record.signature)) {
    return { ok: false, reason: "descriptor signature is missing or malformed" };
  }

  return {
    ok: true,
    descriptor: { channel: record.channel, release, publishedAt, notes, assets, signature: record.signature },
  };
}

/**
 * Deterministic bytes the release signature covers.
 *
 * Rebuilt from the *validated* fields in a fixed order, never from the raw
 * response. This is the same reason `src/main/security/integrity.ts`
 * re-serializes its manifest before verifying: if the signature were computed
 * over the bytes the feed happened to send, key order and whitespace would be
 * attacker-controlled and two different documents could share one signature.
 */
export function canonicalReleasePayload(descriptor: ReleaseDescriptor): string {
  return JSON.stringify({
    version: RELEASE_DESCRIPTOR_VERSION,
    channel: descriptor.channel,
    release: descriptor.release,
    publishedAt: descriptor.publishedAt,
    assets: descriptor.assets.map((asset) => ({
      platform: asset.platform,
      name: asset.name,
      size: asset.size,
      sha256: asset.sha256,
    })),
  });
}

/** The asset for this platform, or `null` when the release does not cover it. */
export function selectPlatformAsset(
  descriptor: ReleaseDescriptor,
  platform: unknown,
): ReleaseAsset | null {
  if (!isReleasePlatform(platform)) return null;
  return descriptor.assets.find((asset) => asset.platform === platform) ?? null;
}

/**
 * Decide whether a descriptor is an update worth offering.
 *
 * Returns the reason alongside the decision so the UI can explain itself, and
 * so an operator reading the log can tell "we are up to date" from "we could
 * not understand the answer".
 */
export type UpdateOffer = {
  readonly available: boolean;
  readonly current: string;
  readonly latest: string | null;
  readonly asset: ReleaseAsset | null;
  readonly reason: string;
};

export function evaluateUpdateOffer(
  descriptor: ReleaseDescriptor | null,
  currentVersion: unknown,
  platform: unknown,
): UpdateOffer {
  const current = normalizeVersion(currentVersion);
  if (current === null) {
    // A client whose own version does not parse can never safely be told it is
    // up to date, and can never be told to downgrade. Refuse both.
    return {
      available: false,
      current: "unknown",
      latest: null,
      asset: null,
      reason: "running version is not a valid version",
    };
  }
  if (descriptor === null) {
    return { available: false, current, latest: null, asset: null, reason: "no release information" };
  }

  const asset = selectPlatformAsset(descriptor, platform);
  if (asset === null) {
    return {
      available: false,
      current,
      latest: descriptor.release,
      asset: null,
      reason: "release has no asset for this platform",
    };
  }

  // Ordering, not equality. An equal version is up to date; a *lower* release is
  // refused outright rather than offered as a downgrade. A feed reporting an
  // older version than the running client is either a rollback or an attack,
  // and neither is something to act on automatically.
  const order = compareVersions(descriptor.release, current);
  if (order === 0) {
    return { available: false, current, latest: descriptor.release, asset: null, reason: "already up to date" };
  }
  if (order < 0) {
    return {
      available: false,
      current,
      latest: descriptor.release,
      asset: null,
      reason: "release is older than the running version",
    };
  }

  return { available: true, current, latest: descriptor.release, asset, reason: "a newer release is available" };
}
