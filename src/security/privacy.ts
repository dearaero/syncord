/** Known Discord telemetry only. Never classify messages, auth or voice by keyword. */
export type PrivacyRequestKind = "analytics" | "metrics" | "crashReports" | "sentryScript";

const API_HOSTS = new Set([
  "discord.com", "canary.discord.com", "ptb.discord.com",
  "discordapp.com", "canary.discordapp.com", "ptb.discordapp.com",
]);
// Discord's desktop crash-reporting organization and its web reporter. These
// are dedicated ingestion hosts, not a blanket block of third-party Sentry.
const CRASH_HOSTS = new Set(["o64374.ingest.sentry.io", "o447951.ingest.sentry.io"]);

export function classifyPrivacyRequest(rawUrl: string): PrivacyRequestKind | undefined {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase();
  if (CRASH_HOSTS.has(host)) return "crashReports";
  if (host === "sentry.io" && /^\/api\/140984\/(?:envelope|store|minidump)\/?$/.test(url.pathname)) return "crashReports";
  if (!API_HOSTS.has(host)) return undefined;
  if (/^\/error-reporting-proxy(?:\/|$)/.test(url.pathname)) return "crashReports";
  // Version is deliberately unpinned. Anchors keep e.g. /channels/id/metrics,
  // /science-fiction and an attachment named science.js out of this policy.
  const route = url.pathname.replace(/^\/api(?:\/v\d+)?(?=\/)/, "");
  if (/^\/(?:science|track|beaker)\/?$/.test(route)) return "analytics";
  if (/^\/metrics(?:\/v\d+)?\/?$/.test(route)) return "metrics";
  // This independent script publishes optional window.DiscordSentry. Prevent
  // SDK listeners, breadcrumbs and timers from being installed in the first place.
  if (/^\/assets\/sentry(?:[.-][a-zA-Z0-9_-]+)*\.js$/.test(url.pathname)) return "sentryScript";
  return undefined;
}
