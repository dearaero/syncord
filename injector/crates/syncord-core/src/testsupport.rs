//! Shared test helpers.
//!
//! `SIGNING_KEY` and `PUBLIC_KEY` are the one place the test key pair lives, and
//! `build.rs` reads `SIGNING_KEY` at compile time. That is what makes
//! `Verifier::embedded()` testable: the crate under test is compiled with a
//! real key in it, so the tests exercise the actual verification path rather
//! than the "no key" short-circuit.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};

/// Ed25519 private key, base64 PKCS#8 DER, matching `PUBLIC_KEY`.
///
/// A throwaway pair generated for this test suite. It is committed on purpose:
/// the key is worthless outside the tests, and pinning it means the fixtures
/// below are reproducible and the compiled-in key is verifiable by inspection.
pub const SIGNING_KEY: &str = "MC4CAQAwBQYDK2VwBCIEIFCmGafBqqcA1yt3dsFJc5yuhy0KUE9irGd/8wyQrT1x";

/// Ed25519 public key, base64 SPKI DER. This is what `build.rs` compiles in.
pub const PUBLIC_KEY: &str = "MCowBQYDK2VwAyEAlIcNZNNi+8A0KiBIM0AJPq6UCNVviv7XGFsQjEprMK4=";

/// A second, unrelated key pair. Used to prove that a signature from the wrong
/// key is refused rather than merely "different".
pub const OTHER_SIGNING_KEY: &str =
    "MC4CAQAwBQYDK2VwBCIEIHDv3V2nRWaXoBx6n75mgrkfjOWKtpjjAs/yf8id9s23";

fn decode_b64(value: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .expect("valid base64 in the test module")
}

/// The raw 32-byte signing key behind [`SIGNING_KEY`].
#[must_use]
pub fn signing_bytes() -> [u8; 32] {
    // A PKCS#8 Ed25519 private key is 48 bytes: a fixed 16-byte prefix and the
    // 32-byte seed.
    let der = decode_b64(SIGNING_KEY);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&der[der.len() - 32..]);
    seed
}

/// Sign `payload` with the test key, returning base64.
#[must_use]
pub fn sign(payload: &[u8]) -> String {
    use base64::Engine;
    let signing = SigningKey::from_bytes(&signing_bytes());
    base64::engine::general_purpose::STANDARD.encode(signing.sign(payload).to_bytes())
}

/// Sign `payload` with a key that is *not* the compiled one.
#[must_use]
pub fn sign_with_other(payload: &[u8]) -> String {
    use base64::Engine;
    let der = decode_b64(OTHER_SIGNING_KEY);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&der[der.len() - 32..]);
    let signing = SigningKey::from_bytes(&seed);
    base64::engine::general_purpose::STANDARD.encode(signing.sign(payload).to_bytes())
}

/// The public key bytes this crate was compiled with.
#[must_use]
pub fn embedded_raw_key() -> [u8; 32] {
    // Matches the SPKI prefix check in `verify.rs`.
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    let der = decode_b64(PUBLIC_KEY);
    assert_eq!(
        der.len(),
        PREFIX.len() + 32,
        "the test public key must be a 32-byte SPKI key"
    );
    assert_eq!(
        der[..PREFIX.len()],
        PREFIX,
        "the test public key must be Ed25519 SPKI"
    );
    let mut out = [0u8; 32];
    out.copy_from_slice(&der[PREFIX.len()..]);
    out
}

/// The verifier every test uses.
///
/// Built through the `pub(crate)` constructor rather than `Verifier::embedded`,
/// because `build.rs` deliberately embeds the *placeholder* key in a test build.
/// That is the correct production behaviour — a build without
/// `SYNCORD_INTEGRITY_KEY` must refuse everything — and the tests need a real
/// key to exercise the accepting paths. `keyless_builds_refuse_everything` covers
/// the other half.
#[must_use]
pub fn verifier() -> crate::verify::Verifier {
    crate::verify::Verifier::from_raw(embedded_raw_key())
        .expect("the test public key must be a valid Ed25519 key")
}

/// Lowercase hex SHA-256.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The three bundle bodies used throughout the tests.
pub fn bundle_bodies() -> Vec<(&'static str, &'static str)> {
    vec![
        ("main.js", "console.log('main');\n"),
        ("preload.js", "console.log('preload');\n"),
        ("renderer.js", "console.log('renderer');\n"),
    ]
}

/// A signed manifest covering `bodies`, plus the canonical payload it signs.
///
/// Returned together because the two are only meaningful as a pair: a test that
/// signs one payload and verifies another is testing the wrong thing.
#[must_use]
pub fn signed_manifest(bodies: &[(&str, &str)]) -> (String, String) {
    let files: Vec<String> = bodies
        .iter()
        .map(|(name, body)| {
            format!(
                "{{\"name\":\"{}\",\"sha256\":\"{}\"}}",
                name,
                sha256_hex(body.as_bytes())
            )
        })
        .collect();

    // The exact shape `src/main/security/integrity.ts` and `scripts/build.mjs`
    // produce: `version`, then `algorithm`, then the `files` array in order.
    let payload = format!(
        "{{\"version\":1,\"algorithm\":\"ed25519\",\"files\":[{}]}}",
        files.join(",")
    );
    let signature = sign(payload.as_bytes());
    let manifest = format!(
        "{{\"version\":1,\"algorithm\":\"ed25519\",\"files\":[{}],\"signature\":\"{signature}\"}}",
        files.join(",")
    );
    (manifest, payload)
}

/// The version every test payload is stamped with.
pub const TEST_VERSION: &str = "1.4.0";

/// Write a complete, signed payload directory.
///
/// This is the "everything is fine" fixture that `inject` is supposed to accept.
pub fn write_verified_payload(dir: &Path) -> String {
    write_verified_payload_versioned(dir, TEST_VERSION)
}

/// As [`write_verified_payload`], with an explicit version stamp.
///
/// Returns the manifest, which several tests re-sign after changing a bundle.
pub fn write_verified_payload_versioned(dir: &Path, version: &str) -> String {
    std::fs::create_dir_all(dir).expect("create payload dir");
    let bodies = bundle_bodies();
    let (manifest, _) = signed_manifest(&bodies);
    for (name, body) in &bodies {
        std::fs::write(dir.join(name), body).expect("write bundle");
    }
    std::fs::write(dir.join(crate::verify::MANIFEST_NAME), &manifest).expect("write manifest");
    // The stamp is display-only and unsigned by design, but `inject` requires
    // one, so a fixture without it is a payload that would be refused.
    std::fs::write(
        dir.join(crate::verify::VERSION_FILE),
        crate::verify::version_stamp_bytes(version),
    )
    .expect("write version stamp");
    manifest
}

/// A unique temporary directory, removed when dropped.
#[derive(Debug)]
pub struct TempDir(PathBuf);

impl TempDir {
    #[must_use]
    pub fn new(tag: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "syncord-{tag}-{nanos}-{unique}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.0
    }

    #[must_use]
    pub fn join(&self, tail: &str) -> PathBuf {
        self.0.join(tail)
    }

    /// Create a directory, returning its path.
    pub fn dir(&self, tail: &str) -> PathBuf {
        let path = self.0.join(tail);
        std::fs::create_dir_all(&path).expect("create dir");
        path
    }

    /// Write a file, creating parent directories.
    pub fn file(&self, tail: &str, contents: &str) -> PathBuf {
        let path = self.0.join(tail);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&path, contents).expect("write file");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Build a fake Discord install: `<resources>/app.asar` plus a marker file.
///
/// `injected = true` additionally creates `resources/app`, which is what
/// discovery reports as "Syncord is already here".
pub fn make_discord_install(parent: &Path, name: &str, injected: bool) -> PathBuf {
    let root = parent.join(name);
    let resources = root.join("Contents").join("Resources");
    std::fs::create_dir_all(&resources).expect("create resources");
    std::fs::write(resources.join("app.asar"), b"discord").expect("write asar");
    if injected {
        std::fs::create_dir_all(resources.join("app")).expect("create app dir");
        std::fs::write(resources.join("app").join("main.js"), b"old main").expect("write main");
    }
    resources
}
