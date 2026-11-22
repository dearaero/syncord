/**
 * Detached Ed25519 signature verification for release artifacts.
 *
 * Extracted from `integrity.ts` so the *key* and the *verification primitive*
 * exist in exactly one place. The updater and the startup integrity check have
 * to agree on both; two copies of a public-key constant is the kind of drift
 * that produces a client which verifies updates with one key and its own
 * bundles with another, and neither copy is wrong on its own.
 */
import crypto from "node:crypto";

/**
 * Public half of the release signing key, compiled in.
 *
 * `Syncord_SIGNING_KEY` (the private key) is used by the release pipeline and
 * never enters a build. This public half is compiled into the bundle by
 * `scripts/build.mjs` as `__SYNCORD_INTEGRITY_KEY__`.
 *
 * ── Why this is a define and not `process.env` ────────────────────────────────
 *
 * This used to be `process.env.Syncord_INTEGRITY_KEY ?? <placeholder>`, and the
 * consequence was that **no shipped client could verify anything, ever**. The
 * Discord process has no `Syncord_*` variables in its environment, so the main
 * process fell through to the placeholder on every launch.
 *
 * The failure was silent in the most complete sense available:
 *
 *  - the updater refused every release with "this build has no release signing
 *    key", and logged nothing, so there was no dot and no reason;
 *  - the client's own integrity check reported every plugin as
 *    `Failed to read asymmetric key`, which looked like tampering with the
 *    plugins rather than with the verifier;
 *  - nothing threw, because the placeholder is not a valid key, so
 *    "fails closed" held exactly as designed.
 *
 * The tests all passed, because every one of them ran with the variable set in
 * the environment — the same way the release pipeline runs. They were testing the
 * build machine's shell, not the artifact that machine produced.
 *
 * Reading the trust anchor from the environment is also a small attack surface in
 * its own right, for the same reason `__SYNCORD_RELEASE_REPO__` is a define: the
 * repository decides *where* an update comes from and a signature still has to
 * verify, but the key decides *whether anything is genuine at all*. No user sets
 * this variable, so nothing would look wrong if it were tampered with — which is
 * the worst possible property for the one value everything else trusts.
 *
 * There is deliberately **no environment fallback**. One that is "only for tests"
 * is one that is also in production, and its whole appeal is that it is invisible.
 * An unbundled test run simply gets an absent define, `signingKeyPresent()`
 * returns false, and the build is inert — which is the correct behaviour for a
 * build that does not know its own key.
 */
declare const __SYNCORD_INTEGRITY_KEY__: string | undefined;

/*
 * Named the way `release-preflight.mjs` reads it out of the bundle.
 *
 * That script finds this value by pattern in the emitted JavaScript, so the shape
 * of the emitted expression is a contract between the two files rather than an
 * implementation detail — hence the inline `typeof` test, and hence **no
 * `.trim()` here**. esbuild folds `typeof DEF === "string" ? DEF : ""` into
 * `var NAME = true ? "…" : ""`, the same shape the version and the repository
 * compile to; a method call survives the fold, and the preflight's pattern then
 * cannot see the key at all. Trimming belongs at the use, where it already
 * happens: `signingKeyPresent()` and `verifyDetachedSignature()` both call
 * `.trim()` on this value.
 */
export const COMPILED_INTEGRITY_KEY: string =
  typeof __SYNCORD_INTEGRITY_KEY__ === "string" ? __SYNCORD_INTEGRITY_KEY__ : "";

export const INTEGRITY_PUBLIC_KEY: string = COMPILED_INTEGRITY_KEY;

/**
 * Is a usable public key compiled in?
 *
 * Checked separately from `verifyDetachedSignature` so the Security Center can
 * say *why* verification is unavailable instead of showing a bare "unsigned".
 */
export function signingKeyPresent(): boolean {
  const key = INTEGRITY_PUBLIC_KEY.trim();
  if (key.length === 0) return false;
  try {
    return crypto.createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/**
 * Verify a detached Ed25519 signature over `payload`.
 *
 * Returns `false` for every possible failure — missing key, malformed base64,
 * wrong algorithm, bad signature — rather than throwing. The caller's response
 * to a bad signature is always the same (refuse), so there is nothing to
 * distinguish and nothing to leak in an error message.
 */
export function verifyDetachedSignature(payload: string, signatureBase64: unknown): boolean {
  if (!signingKeyPresent()) return false;
  if (typeof signatureBase64 !== "string" || signatureBase64.length === 0) return false;
  if (payload.length === 0) return false;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    return false;
  }
  // An Ed25519 signature is exactly 64 bytes. Checking the length up front means
  // a short or padded value is rejected before it reaches the verifier, and a
  // caller cannot pass a 10 MB string that happens to be valid base64.
  if (signature.length !== 64) return false;

  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(INTEGRITY_PUBLIC_KEY.trim(), "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(payload, "utf-8"), key, signature);
  } catch {
    return false;
  }
}
