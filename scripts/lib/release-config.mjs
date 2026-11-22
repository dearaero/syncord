import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Only build/publisher configuration is read here. The runtime receives literals.
export function readReleaseConfiguration(root, environment = process.env) {
  const local = {};
  const envFile = path.join(root, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?((?:SYNCORD|Syncord)_[A-Z_]+)\s*=\s*(.*)$/.exec(line);
      if (match) local[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  const value = suffix => {
    const upper = `SYNCORD_${suffix}`, legacy = `Syncord_${suffix}`;
    // An explicit environment value takes precedence over either spelling in .env.
    const explicit = [environment[upper], environment[legacy]].some(v => typeof v === "string" && v.trim());
    const source = explicit ? environment : local;
    const a = source[upper]?.trim(), b = source[legacy]?.trim();
    if (a && b && a !== b) throw new Error(`${upper} and ${legacy} disagree`);
    return a || b || "";
  };
  const source = fs.readFileSync(path.join(root, "src/shared/release.ts"), "utf8");
  const repository = value("RELEASE_REPO") || /export const DEFAULT_RELEASE_REPO = "([^"\n]+)"/.exec(source)?.[1];
  if (!repository || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/.test(repository)
    || repository.split("/").some(part => part === "." || part === "..")
    || /^(?:api|www|raw|github|apps|status|support)\//i.test(repository)) throw new Error("The release repository is not a valid owner/repo");

  const publicFile = path.join(root, "config/release-public-key.base64");
  const integrityKey = value("INTEGRITY_KEY") || (fs.existsSync(publicFile) ? fs.readFileSync(publicFile, "utf8").trim() : "");
  if (integrityKey) {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(integrityKey, "base64"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") throw new Error();
    } catch { throw new Error("The release public key must be base64 SPKI Ed25519"); }
  }
  return { repository, integrityKey, signingKey: value("SIGNING_KEY"), releaseVersion: value("RELEASE_VERSION"), releaseChannel: value("RELEASE_CHANNEL") };
}
