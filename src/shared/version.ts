/**
 * Version parsing and comparison (pure, no Node, no DOM).
 *
 * Deliberately *not* a full SemVer implementation. The whole auto-update
 * decision rests on one question — "is the release newer than what is
 * running?" — and a full SemVer parser brings precedence rules, build
 * metadata, loose ranges and a large surface for an attacker who controls the
 * release feed to exploit. What Syncord actually needs is a strict,
 * conservative subset:
 *
 *   - `MAJOR.MINOR.PATCH`, numeric, no leading zeros beyond a bare `0`.
 *   - An optional 4th numeric component, because the project already ships
 *     versions like `1.1` in its change history and a hard reject would strand
 *     users on an older build forever.
 *   - An optional pre-release suffix, compared with SemVer precedence so
 *     `1.2.0-beta.1 < 1.2.0`.
 *
 * Anything that does not parse is *not* a version, and "not a version" always
 * loses. A hostile or corrupt feed therefore cannot make a downgrade look like
 * an upgrade by sending `">=0.0.0"`, `""` or `"1.2.3 || 1.2.4"`.
 */

/** Hard ceiling. A version string longer than this is rejected unread. */
export const MAX_VERSION_LENGTH = 64;

/** Bounded component count: `1`, `1.2`, `1.2.3`, `1.2.3.4`. */
const MAX_COMPONENTS = 4;

export type ParsedVersion = {
  readonly parts: readonly number[];
  /** `""` for a final release, or the pre-release identifier without `-`. */
  readonly pre: string;
  /** The exact input that produced this value, for logs and audit records. */
  readonly raw: string;
};

/**
 * Dot-separated numeric core, with no leading `+`, no `v` prefix and no
 * whitespace. Anchored on purpose: an unanchored `\d+(\.\d+)*` accepts
 * `"1.2.3.4.5.6.7"` and `parseInt` happily truncates the overflow, which is
 * exactly the "attacker controls the ordering" case this module exists to stop.
 */
const NUMERIC_CORE = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;

/**
 * Pre-release identifier: alphanumerics, dots and hyphens, no empty segments.
 * `+build` metadata is stripped and ignored — it does not affect precedence in
 * SemVer and accepting it would only add a way to make two strings look
 * different while meaning the same thing.
 */
const PRE_RELEASE = /^[0-9A-Za-z.-]{1,32}$/;

/** Parse a version, or return `null`. Never throws. */
export function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;

  // Control characters are stripped by the matchers below, but a leading or
  // trailing space is a realistic human/formatting bug and is worth refusing
  // loudly rather than silently tolerating.
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_VERSION_LENGTH) return null;

  const plus = text.indexOf("+");
  const withoutBuild = plus === -1 ? text : text.slice(0, plus);
  // A second `+` means the build metadata itself contains one, which cannot be
  // legitimate; refuse rather than silently truncating.
  if (plus !== -1 && withoutBuild.includes("+")) return null;

  const dash = withoutBuild.indexOf("-");
  // A dash with nothing after it (`"1.2.3-"`) is a malformed pre-release, not
  // the absence of one. Without this, `"1.2.3-"` and `"1.2.3"` would compare
  // equal and a feed could pad a version with a meaningless suffix.
  if (dash !== -1 && withoutBuild.length === dash + 1) return null;
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? "" : withoutBuild.slice(dash + 1);

  if (pre !== "" && !PRE_RELEASE.test(pre)) return null;
  // Guarded on `pre !== ""` because `"".split(".")` is `[""]`, and an empty
  // segment here is a malformed pre-release — not the absence of one.
  if (pre !== "" && pre.split(".").some((segment) => segment.length === 0)) return null;
  if (!NUMERIC_CORE.test(core)) return null;

  const parts = core.split(".");
  if (parts.length > MAX_COMPONENTS) return null;
  // `01.2.3` is ambiguous (octal-looking) and is refused rather than coerced.
  if (parts.some((part) => part.length > 1 && part.startsWith("0"))) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    numbers.push(value);
  }

  return { parts: numbers, pre, raw: text };
}

export function isValidVersion(raw: unknown): boolean {
  return parseVersion(raw) !== null;
}

/** SemVer numeric comparison: `-1`, `0`, `1`. Longer releases pad with zeros. */
function compareNumbers(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length, MAX_COMPONENTS);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

/**
 * SemVer pre-release precedence: dot-separated identifiers, compared left to
 * right. A numeric identifier always has lower precedence than an alphanumeric
 * one, and a *release* always outranks any pre-release of the same number.
 */
function comparePre(a: string, b: string): number {
  if (a === "" && b === "") return 0;
  // A final release outranks any pre-release of the same version.
  if (a === "") return 1;
  if (b === "") return -1;

  const left = a.split(".");
  const right = b.split(".");
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNumeric = /^\d{1,9}$/.test(x);
    const yNumeric = /^\d{1,9}$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two versions. Returns `-1` when `a` is older, `1` when newer, `0`
 * when equal.
 *
 * An unparseable operand loses to a parseable one, in both directions. That is
 * asymmetric with the return value (`parseVersion` of the bad side is `null`),
 * so callers can rely on: if exactly one side is a real version, the real one
 * is the one they want.
 */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 {
  const left = parseVersion(a);
  const right = parseVersion(b);

  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;

  const numeric = compareNumbers(left.parts, right.parts);
  if (numeric !== 0) return numeric < 0 ? -1 : 1;

  const pre = comparePre(left.pre, right.pre);
  if (pre !== 0) return pre < 0 ? -1 : 1;
  return 0;
}

/** Is `candidate` strictly newer than `current`? */
export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * Normalize a version for display and for the staging directory name.
 *
 * Returns `null` for anything unparseable. Callers use the `null` to refuse the
 * value outright, so this is the single gate a version must pass before it is
 * allowed anywhere near a filesystem path.
 */
export function normalizeVersion(raw: unknown): string | null {
  const parsed = parseVersion(raw);
  if (parsed === null) return null;
  return `${parsed.parts.join(".")}${parsed.pre === "" ? "" : `-${parsed.pre}`}`;
}
