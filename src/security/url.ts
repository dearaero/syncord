/**
 * URL / hostname primitives.
 *
 * Everything in `src/security` is intentionally dependency-free so the exact
 * same bytes get bundled into main (CJS/node), preload (CJS/node) and renderer
 * (IIFE/browser). That means: no `node:url`, no `node:net`, no `node:path`.
 * The parsers below are hand-rolled and deliberately strict — a URL that we
 * cannot fully understand is treated as untrusted, never as "probably fine".
 */

/** A URL we managed to parse *and* fully understand. */
export type CheckedUrl = {
  /** Normalized (WHATWG) absolute URL. */
  href: string;
  protocol: string;
  /** Lowercased hostname with any trailing root dot removed. */
  hostname: string;
  /** `hostname` bracketed again for IPv6 literals, else identical. */
  host: string;
  /** Explicit port, or "" when the URL relied on the protocol default. */
  port: string;
  /** Always starts with "/". */
  pathname: string;
  /** Raw query string without the leading "?". */
  search: string;
  /** True when the hostname is an IPv4/IPv6 literal rather than a name. */
  isIpLiteral: boolean;
  /**
   * True for `https://user:pass@host/`. `URL` keeps these; every consumer that
   * is not a human-facing logger must reject them, because they are a classic
   * way to make a log line read like it points somewhere else.
   */
  hasCredentials: boolean;
};

const MAX_URL_LENGTH = 2048;

/**
 * Parse a URL string into a `CheckedUrl`, or return null.
 *
 * Null means "do not trust this". It is returned for: non-strings, empty or
 * oversized input, anything `URL` cannot parse, and any scheme that is not
 * explicitly listed as acceptable by the caller. We never throw from here, so
 * callers cannot accidentally turn a parse error into a crash path.
 */
export function parseUrl(raw: unknown): CheckedUrl | null {
  if (typeof raw !== "string") return null;
  // Control characters (incl. \n, \r, \t and NUL) are a classic way to smuggle
  // a second URL past a naive validator. Reject rather than strip.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw.length === 0) return null;
  if (raw.length > MAX_URL_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // `new URL("data:text/html,...")` parses fine and has an empty hostname. We
  // keep it (rather than returning null) so callers can report the *reason* it
  // was rejected — "protocol not allowed" is far more actionable for the
  // security log than a generic "malformed".
  const hostname = normalizeHostname(url.hostname);

  return {
    href: url.href,
    protocol: url.protocol,
    hostname,
    host: hostname.includes(":") ? `[${hostname}]` : hostname,
    port: url.port,
    pathname: url.pathname.length > 0 ? url.pathname : "/",
    search: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    isIpLiteral: isIpLiteral(hostname),
    hasCredentials: url.username.length > 0 || url.password.length > 0,
  };
}

/** Lowercase, strip the DNS root dot, and unwrap IPv6 brackets. */
export function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // A single trailing dot is the FQDN root and is semantically the same host.
  while (h.endsWith(".") && h.length > 1) h = h.slice(0, -1);
  return h;
}

/**
 * Match a hostname against an allowlist entry.
 *
 * Supports exactly two forms and nothing else:
 *   - `"discord.com"`      → that host and any subdomain of it
 *   - `"*.discord.com"`    → any subdomain of it, but not the apex
 *
 * We deliberately do NOT support `"*"` or `"*example.com"`: a wildcard that can
 * match a suffix is exactly how `discord.com.evil.com` slips through. Substring
 * matching is banned for the same reason, and the suffix is always anchored on a
 * `.` boundary so `evil-discord.com` can never match `*.discord.com`.
 */
export function hostnameMatches(hostname: string, pattern: string): boolean {
  const host = normalizeHostname(hostname);
  const pat = normalizeHostname(pattern);
  if (host.length === 0 || pat.length === 0) return false;
  if (pat === "*" || pat === "*.*") return false;

  if (pat.startsWith("*.")) {
    const base = pat.slice(2);
    if (base.length === 0) return false;
    return host.endsWith(`.${base}`);
  }

  if (host === pat) return true;
  return host.endsWith(`.${pat}`);
}

export function isIpLiteral(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return isIpv4(h) || isIpv6(h);
}

export function isIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
  }
  return true;
}

/**
 * Parse an IPv4 literal to its numeric value, or null.
 * Note that the WHATWG URL parser already normalizes decimal/hex/octal forms
 * (`http://2130706433` → `127.0.0.1`), so we only ever see dotted quads here.
 */
export function ipv4ToNumber(hostname: string): number | null {
  if (!isIpv4(hostname)) return null;
  const parts = hostname.split(".");
  let n = 0;
  for (const part of parts) n = (n << 8) | Number(part);
  return n >>> 0;
}

/** True for a syntactically valid IPv6 literal (no brackets). */
export function isIpv6(hostname: string): boolean {
  return expandIpv6(hostname) !== null;
}

/**
 * Expand an IPv6 literal into 8 sixteen-bit groups, or null if malformed.
 * Handles `::` compression and a trailing embedded IPv4 literal.
 */
function expandIpv6(input: string): number[] | null {
  const raw = input;
  if (raw.length === 0 || raw.length > 45) return null;
  if (!/^[0-9a-f:.]+$/.test(raw)) return null;
  if ((raw.match(/::/g) ?? []).length > 1) return null;

  let head = raw;
  let tailGroups: number[] = [];
  let embeddedV4: string | undefined;

  // A trailing IPv4 literal (e.g. ::ffff:127.0.0.1) becomes two groups.
  const lastColon = raw.lastIndexOf(":");
  const lastPart = raw.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    if (!isIpv4(lastPart)) return null;
    const n = ipv4ToNumber(lastPart)!;
    embeddedV4 = lastPart;
    tailGroups = [(n >>> 16) & 0xffff, n & 0xffff];
    head = raw.slice(0, lastColon + 1);
    if (head.endsWith("::")) head = head.slice(0, -1);
    else if (!head.endsWith(":")) return null;
  }

  const doubleColonAt = head.indexOf("::");
  let headText: string;
  let tailText: string;
  if (doubleColonAt >= 0) {
    headText = head.slice(0, doubleColonAt);
    tailText = head.slice(doubleColonAt + 2);
  } else {
    headText = head;
    tailText = "";
  }

  const parseGroups = (text: string): number[] | null => {
    if (text.length === 0) return [];
    // Splitting "ffff:" yields a trailing empty chunk; that is the separator we
    // already consumed, not a malformed group.
    const chunks = text.split(":").filter((chunk, index, all) => !(chunk === "" && index === all.length - 1));
    const out: number[] = [];
    for (const chunk of chunks) {
      if (chunk.length === 0 || chunk.length > 4) return null;
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      out.push(parseInt(chunk, 16));
    }
    return out;
  };

  const h = parseGroups(headText);
  const t = parseGroups(tailText);
  if (h === null || t === null) return null;

  // `::` compresses a run of zero groups *in the middle*, so head groups stay
  // at the front, tail groups stay at the back, and the zeros go between them.
  const fixed = h.length + t.length + tailGroups.length;
  if (fixed > 8) return null;

  let all: number[];
  if (doubleColonAt >= 0) {
    const zeros = 8 - fixed;
    // `::` must stand for at least one group, otherwise `1:2:3` would parse.
    if (zeros < 1) return null;
    all = [...h, ...new Array<number>(zeros).fill(0), ...t, ...tailGroups];
  } else {
    if (fixed !== 8) return null;
    all = [...h, ...t, ...tailGroups];
  }
  return all;
}

/**
 * Is this hostname an IP literal that points at loopback, link-local,
 * private, CGNAT, documentation, multicast or otherwise reserved space?
 *
 * This is the SSRF guard. A permission for `example.com` must never let a
 * request reach the developer's own machine, the LAN, or a cloud metadata
 * endpoint by way of a numeric address.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);

  if (isIpv4(host)) return isReservedIpv4(ipv4ToNumber(host)!);
  if (isIpv6(host)) return isReservedIpv6(host);

  // Named loopback / mDNS / internal zones. `.internal` and `home.arpa` are the
  // names cloud providers hand out to their metadata services.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.endsWith(".home.arpa")) return true;
  if (host === "metadata" || host === "metadata.google.internal") return true;
  if (host === "instance-data" || host === "instance-data.ec2.internal") return true;

  // A single-label name can only resolve through local search domains
  // (router admin pages, intranet hosts). Default-deny it.
  if (!host.includes(".")) return true;

  return false;
}

function isReservedIpv4(n: number): boolean {
  const inRange = (base: number, bits: number): boolean => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  };
  const RANGES: Array<[string, number]> = [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // RFC1918
    ["100.64.0.0", 10], // CGNAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local + AWS/GCP/Azure metadata
    ["172.16.0.0", 12], // RFC1918
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // TEST-NET-1
    ["192.88.99.0", 24], // 6to4 relay anycast
    ["192.168.0.0", 16], // RFC1918
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // TEST-NET-2
    ["203.0.113.0", 24], // TEST-NET-3
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved + broadcast
  ];
  for (const [base, bits] of RANGES) {
    if (inRange(ipv4ToNumber(base)!, bits)) return true;
  }
  return false;
}

function isReservedIpv6(input: string): boolean {
  const g = expandIpv6(input);
  if (g === null) return true; // unparseable ⇒ untrusted

  const isZeroPrefix = (groups: number[], count: number): boolean =>
    groups.slice(0, count).every((x) => x === 0);

  // ::  unspecified
  if (isZeroPrefix(g, 7) && g[7] === 0) return true;
  // ::1 loopback
  if (isZeroPrefix(g, 7) && g[7] === 1) return true;

  // ::ffff:0:0/96 IPv4-mapped and ::/96 IPv4-compatible → look at the embedded
  // IPv4 address, otherwise `::ffff:127.0.0.1` would be a trivial loopback bypass.
  if (isZeroPrefix(g, 5) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isReservedIpv4(ipv4ToNumber(v4)!);
  }

  // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && isZeroPrefix(g.slice(2), 4)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isReservedIpv4(ipv4ToNumber(v4)!);
  }

  // 2002::/16 6to4 embeds the IPv4 address in the next 32 bits. (The mask is
  // `0xff00`, not `0xffff` — 0x2002 must be the whole first group.)
  if (g[0] === 0x2002) {
    const v4 = `${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`;
    return isReservedIpv4(ipv4ToNumber(v4)!);
  }

  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;

  // 100::/64 discard-only, 2001:db8::/32 documentation, 2001::/32 Teredo
  if (g[0] === 0x100 && isZeroPrefix(g.slice(1), 3)) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  if (g[0] === 0x2001 && g[1] === 0x0000) return true;

  return false;
}

/** True when the URL targets the loopback interface in any spelling. */
export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const v4 = ipv4ToNumber(host);
  if (v4 !== null) return (v4 & 0xff000000) >>> 0 === 0x7f000000;
  return false;
}
