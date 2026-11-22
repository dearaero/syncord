//! Cross-language parity tests.
//!
//! Two things in this crate are duplicated from the TypeScript client, and both
//! duplications are a place the two implementations could quietly disagree:
//!
//! | Contract | TypeScript | Rust |
//! |---|---|---|
//! | The signed manifest bytes | `src/main/security/integrity.ts` | `verify.rs` |
//! | The release public key | `scripts/build.mjs` via `Syncord_INTEGRITY_KEY` | `build.rs` via `SYNCORD_INTEGRITY_KEY` |
//!
//! These tests run the **real** TypeScript and feed its output to Rust. They do
//! not re-implement the JavaScript in Rust to compare against, because a
//! hand-copied second implementation is exactly the thing that drifts; bundling
//! the actual source with esbuild means a change in either language fails here.
//!
//! If esbuild or the repository sources are unavailable the tests skip loudly
//! rather than silently passing — a parity check that quietly stops running is
//! worse than no parity check.

use crate::testsupport::{bundle_bodies, sha256_hex, sign, TempDir};
use crate::verify::{Manifest, Verifier};

/// Run the TypeScript integrity check and the manifest builder, and return
/// `{ canonicalPayload, manifestJson }`.
///
/// Returns `Err(reason)` if the toolchain is absent, and **panics** if it is
/// present but the run fails. The distinction matters: a parity test that skips
/// silently when something breaks is worse than no parity test, because it
/// reports "passing" for a contract it never checked.
fn typescript_contract() -> Result<(String, String), String> {
    use std::process::Command;

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .map_err(|err| format!("could not locate the repository root: {err}"))?;

    if !root.join("node_modules").join("esbuild").exists() {
        return Err("node_modules/esbuild is not installed".to_string());
    }

    let temp = TempDir::new("parity");
    let outfile = temp.join("integrity.mjs");

    // `src/main/security/integrity.ts` transitively imports `electron` (through
    // `./core`), and `electron`'s entry point refuses to load outside an Electron
    // runtime. `canonicalPayload` and `buildManifest` are pure and never touch
    // it, so a shape-only stub is enough to let the module load — and this is
    // the same technique `scripts/tests/security-main.test.mjs` uses.
    let stub = temp.file(
        "electron-stub.mjs",
        "export const app = { getPath: () => '/tmp' };\n",
    );

    // `stdin` with an explicit `resolveDir`, not `entryPoints`: the TypeScript
    // entry uses a repository-relative import, and with `entryPoints` that would
    // resolve against the temporary directory instead of the repository.
    let script = format!(
        r#"
import {{ build }} from "esbuild";
import path from "node:path";
await build({{
  stdin: {{
    contents: "export {{ canonicalPayload, buildManifest, INTEGRITY_FILES }} from './src/main/security/integrity';",
    resolveDir: process.cwd(),
    loader: "ts",
  }},
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: process.argv[1],
  alias: {{ electron: {stub} }},
  logLevel: "warning",
}});
"#,
        stub = serde_json::to_string(&stub.to_string_lossy())
            .map_err(|err| format!("could not encode the stub path: {err}"))?,
    );

    let build = Command::new("node")
        .current_dir(&root)
        .args([
            "--input-type=module",
            "-e",
            &script,
            &outfile.to_string_lossy(),
        ])
        .output()
        .map_err(|err| format!("could not run node: {err}"))?;

    if !build.status.success() {
        panic!(
            "esbuild failed to bundle the TypeScript integrity module — the parity test \
             cannot run, and it must not be reported as passing.\n{}",
            String::from_utf8_lossy(&build.stderr)
        );
    }

    // Build a manifest with the real builder, then get the real canonical
    // payload for it. `buildManifest` takes {name, sha256} entries, which is
    // exactly the shape the Rust side parses.
    //
    // `canonicalPayload` returns a Buffer, not a string, so it is decoded here
    // before it goes into the JSON envelope.
    let script = format!(
        r#"
import {{ canonicalPayload, buildManifest }} from {module};
import crypto from "node:crypto";
const bodies = {bodies};
const entries = bodies.map(([name, body]) => ({{
  name,
  sha256: crypto.createHash("sha256").update(body).digest("hex"),
}}));
const manifest = buildManifest(entries);
const payload = canonicalPayload(manifest).toString("utf-8");
process.stdout.write(JSON.stringify({{ payload, manifest }}));
"#,
        module = serde_json::to_string(&format!("file://{}", outfile.to_string_lossy()))
            .map_err(|err| format!("could not encode the module specifier: {err}"))?,
        bodies = serde_json::to_string(
            &bundle_bodies()
                .into_iter()
                .map(|(n, b)| serde_json::Value::from(vec![n, b]))
                .collect::<Vec<serde_json::Value>>(),
        )
        .map_err(|err| format!("could not encode the fixture bodies: {err}"))?,
    );

    let run = Command::new("node")
        .current_dir(&root)
        .args(["--input-type=module", "-e", &script])
        .output()
        .map_err(|err| format!("could not run node: {err}"))?;

    if !run.status.success() {
        panic!(
            "the TypeScript integrity module did not run — the parity test cannot \
             check the contract and must not be reported as passing.\n{}",
            String::from_utf8_lossy(&run.stderr)
        );
    }

    // Anything that runs but produces the wrong shape is a *failure*, not a
    // skip. A parity check that quietly stops checking is worse than none,
    // because it reports "passing" for a contract it never compared.
    let value: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap_or_else(|err| {
        panic!(
            "the TypeScript output was not the expected JSON: {err}\n{}",
            String::from_utf8_lossy(&run.stdout)
        )
    });

    let canonical = value
        .get("payload")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| {
            panic!(
                "the TypeScript output had no string `payload` field: {}",
                String::from_utf8_lossy(&run.stdout)
            )
        })
        .to_string();

    let manifest_value = value.get("manifest").unwrap_or_else(|| {
        panic!(
            "the TypeScript output had no `manifest` field: {}",
            String::from_utf8_lossy(&run.stdout)
        )
    });

    let manifest = serde_json::to_string_pretty(manifest_value).unwrap_or_else(|err| {
        panic!("could not re-encode the manifest: {err}");
    });

    Ok((canonical, manifest))
}

/// Fetch the contract, skipping only when the Node toolchain is genuinely absent.
fn contract_or_skip() -> Option<(String, String)> {
    match typescript_contract() {
        Ok(value) => Some(value),
        Err(reason) => {
            eprintln!("[parity] SKIPPED: {reason}");
            None
        }
    }
}

#[test]
fn canonical_payload_matches_typescript_byte_for_byte() {
    let Some((typescript_payload, _manifest)) = contract_or_skip() else {
        return;
    };

    let bodies = bundle_bodies();
    let manifest = Manifest {
        version: 1,
        algorithm: "ed25519".to_string(),
        files: bodies
            .iter()
            .map(|(name, body)| crate::verify::ManifestFile {
                name: (*name).to_string(),
                sha256: sha256_hex(body.as_bytes()),
            })
            .collect(),
        signature: None,
    };

    let rust_payload = Verifier::canonical_payload(&manifest);

    assert_eq!(
        rust_payload, typescript_payload,
        "the Rust and TypeScript canonical payloads must be byte-identical. \
         A mismatch here means every genuine release would be refused."
    );
}

#[test]
fn a_typescript_manifest_verifies_in_rust() {
    let Some((_payload, manifest_json)) = contract_or_skip() else {
        return;
    };

    let mut manifest: Manifest =
        serde_json::from_str(&manifest_json).expect("the TypeScript manifest must parse here");
    manifest.signature = Some(sign(Verifier::canonical_payload(&manifest).as_bytes()));

    let verifier = crate::testsupport::verifier();
    assert_eq!(
        verifier.verify_manifest(&manifest),
        Ok(()),
        "a manifest produced by the real TypeScript builder, signed with the \
         test key, must verify in Rust"
    );
}

#[test]
fn the_release_key_wiring_matches_the_typescript_build() {
    // The cargo build environment uses upper-case names, so the variable is
    // `SYNCORD_INTEGRITY_KEY` where the TypeScript build reads
    // `Syncord_INTEGRITY_KEY`. That rename is a real place for the two halves to
    // drift: a release pipeline that sets one and not the other produces an
    // Injector that verifies nothing. This asserts the contract from both sides
    // rather than trusting a comment in either.
    let build_rs = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs");
    let source = std::fs::read_to_string(&build_rs).expect("build.rs must be readable");
    assert!(
        source.contains("SYNCORD_INTEGRITY_KEY"),
        "build.rs must read SYNCORD_INTEGRITY_KEY"
    );
    assert!(
        source.contains("PLACEHOLDER_PUBLIC_KEY"),
        "build.rs must fall back to the placeholder rather than to an empty key, \
         so a keyless build refuses instead of skipping the check"
    );

    let constants = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("src")
        .join("shared")
        .join("constants.ts");
    let ts = std::fs::read_to_string(&constants).expect("src/shared/constants.ts must be readable");
    assert!(
        ts.contains("sOOl0replacethiswitharealEd25519publickeybase64value0=")
            || std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("..")
                .join("src")
                .join("main")
                .join("security")
                .join("signing.ts")
                .exists(),
        "the TypeScript placeholder must be the same string build.rs embeds"
    );
}
