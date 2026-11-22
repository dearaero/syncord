/**
 * Main-process credential injection for the Network Broker.
 *
 * Background. `scripts/build.mjs` used to inline `process.env.API_KEY` into the
 * renderer bundle, and the renderer's own UI printed it to the console. That put
 * a third-party secret into `dist/renderer.js` — a file that is copied into the
 * Discord install, readable by anything with filesystem access, and by every
 * plugin in the page.
 *
 * The fix inverts the flow: the renderer asks the broker for the resource, the
 * broker attaches the credential server-side, and the secret never enters the
 * renderer realm. The header filter in `networkPolicy` is what forced this — a
 * plugin is not allowed to set `X-API-Key` or `Authorization` on a request, so
 * the only way for Syncord's own integrations to authenticate is for the
 * main process to do it.
 *
 * Secrets are read from the environment at startup and never written to disk,
 * logged, or sent over IPC. `describeSecrets` returns names only.
 */

/** host → header name. Value comes from the environment, never from a file. */
type CredentialBinding = {
  host: string;
  header: string;
  envVar: string;
  /** Header is only attached to these methods. */
  methods: ReadonlySet<string>;
};

/**
 * First-party integrations that authenticate, host → header.
 *
 * Empty on purpose today: no built-in integration makes a request of its own, so
 * there is no secret for Syncord to hold and every broker request goes out with
 * exactly the headers its caller asked for.
 *
 * The mechanism stays because it is the only way a first-party integration can
 * authenticate at all: `networkPolicy` refuses `Authorization` and
 * `X-API-Key` from a plugin, so a credential has to be attached here, in main,
 * where it never enters the renderer realm. A new integration adds one entry
 * below and needs no other change — the broker re-derives it per redirect hop.
 */
const BINDINGS: CredentialBinding[] = [];

const loaded = new Map<string, string>();

/** Read the configured secrets from the environment. Called once at startup. */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): void {
  loaded.clear();
  for (const binding of BINDINGS) {
    const value = env[binding.envVar];
    if (typeof value === "string" && value.length > 0) {
      loaded.set(binding.host, value);
    }
  }
  if (loaded.size > 0) {
    // Names only. Values must never reach a log line, the Security Center, or
    // an IPC response.
    console.log(
      `[Syncord][security] ${loaded.size} broker credential(s) configured: ${describeSecrets().join(", ")}`,
    );
  }
}

/**
 * Attach any configured credential for this host/method pair.
 *
 * Returns a *new* object; the caller's plan is left untouched so a rejected
 * request cannot leave a secret behind in a structure that gets logged.
 */
export function applyCredentials(
  host: string,
  method: string,
  headers: Record<string, string>,
): Record<string, string> {
  const next = { ...headers };
  for (const binding of BINDINGS) {
    if (binding.host !== host) continue;
    if (!binding.methods.has(method.toUpperCase())) continue;
    const secret = loaded.get(binding.host);
    // No secret configured ⇒ header simply absent. We never send an empty
    // credential, because some servers treat "" as "present but invalid" and log
    // the attempt either way.
    if (secret === undefined) continue;
    next[binding.header] = secret;
  }
  return next;
}

/** Host names that have a credential configured. Values are never included. */
export function describeSecrets(): string[] {
  return BINDINGS.filter((binding) => loaded.has(binding.host)).map((binding) => binding.host);
}

/** Used by Emergency Lockdown (Phase 14) to drop credentials from memory. */
export function clearCredentials(): void {
  loaded.clear();
}
