//! Payload verification: SHA-256 digests and Ed25519 signatures.
//!
//! Two independent checks stand between a downloaded file and a written one,
//! and they answer different questions:
//!
//! * **SHA-256** answers "are these the bytes the release described?".
//! * **Ed25519** answers "did the Syncord release key describe those bytes?".
//!
//! The first alone is worthless — whoever controls the release can also
//! compute a digest — and the second alone is impractical to apply to every
//! bundle. Together: a compromised mirror, a corrupted download, or a tampered
//! GitHub asset all fail the first; publishing a *different* payload under a
//! valid digest requires the private key.
//!
//! ── The canonical payload ───────────────────────────────────────────────────
//!
//! The signature covers a *re-serialization* of the manifest, not the file's
//! bytes. This is the single most delicate cross-implementation contract in the
//! project: `src/main/security/integrity.ts` and
//! `scripts/release.mjs` build the same JSON with JavaScript's
//! `JSON.stringify`, and this module builds it with serde. If the three
//! disagree about field order or spacing, verification fails closed on a
//! perfectly good release — which is safe but useless.
//!
//! Two things keep them in step:
//!
//! 1. The struct field order below is `version`, `algorithm`, `files`, and each
//!    file is `name`, `sha256` — the order `scripts/build.mjs` writes them.
//! 2. `tests/parity.rs` verifies a manifest produced by the real TypeScript
//!    build with a signature from a real key, and asserts this module accepts
//!    it. If someone reorders a field in either language, that test fails.
//!
//! `deny_unknown_fields` is stricter than the TypeScript, which silently drops
//! unrecognised manifest keys. That divergence is deliberate and safe: this
//! side refuses, the other accepts, and a release can never be *more* verified
//! on one platform than another.

use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};

// The trait is aliased: this module's own `Verifier` type would otherwise be
// shadowed by it at every call site, which is exactly the kind of ambiguity
// that turns a security predicate into a different one during a rename.
use ed25519_dalek::{Signature, Verifier as Ed25519Verify, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The three bundles a Syncord install is made of.
///
/// Must match `INTEGRITY_FILES` in `src/main/security/integrity.ts` and
/// `SIGNED_FILES` in `scripts/build.mjs`.
pub const INTEGRITY_FILES: [&str; 3] = ["main.js", "preload.js", "renderer.js"];

/// The manifest filename, written into the install by the Injector.
pub const MANIFEST_NAME: &str = "integrity.manifest.json";

/// The `package.json` the Injector writes so Electron treats the directory as
/// an app.
pub const PACKAGE_JSON_NAME: &str = "package.json";

/// Upper bound on a bundle. A bundle that exceeds this is not something this
/// client produced, and hashing it unbounded would be a denial-of-service lever
/// from a hostile download.
pub const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;

/// Read once at compile time from `build.rs`, which reads the build environment.
const EMBEDDED_PUBLIC_KEY_B64: &str = env!("SYNCORD_INTEGRITY_KEY");

/// One entry of the signed manifest.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestFile {
    pub name: String,
    pub sha256: String,
}

/// The signed manifest, in the exact shape `src/main/security/integrity.ts`
/// expects.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub algorithm: String,
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub signature: Option<String>,
}

/// Why verification failed. Every variant is a refusal; there is no "warned and
/// continued" path in this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// No usable key was compiled in. Distinct from a bad signature so the UI
    /// can say "this build cannot verify updates" rather than "someone attacked
    /// you".
    NoKeyCompiled,
    /// The compiled key is not a valid Ed25519 public key.
    KeyMalformed,
    /// The manifest is absent, unreadable, or not the shape we expect.
    ManifestUnreadable(String),
    /// The manifest is unsigned.
    ManifestUnsigned,
    /// The manifest claims an algorithm other than `ed25519`.
    UnsupportedAlgorithm(String),
    /// The signature did not verify against the embedded key.
    SignatureInvalid,
    /// The manifest does not cover exactly the three bundles.
    CoverageMismatch(Vec<String>),
    /// A bundle is missing from the install directory.
    BundleMissing(String),
    /// A bundle did not match its manifest digest.
    BundleDigestMismatch(String),
    /// A bundle is larger than [`MAX_BUNDLE_BYTES`].
    BundleTooLarge(String),
    /// An I/O error while reading a bundle.
    Io {
        /// The file that could not be read.
        path: PathBuf,
        /// The underlying error, for display.
        message: String,
    },
    /// A digest was not 64 lowercase hex characters.
    DigestMalformed(String),
    /// The payload carries no readable version stamp.
    ///
    /// `read_version_stamp` returns `None` for both a missing stamp and a
    /// malformed one, and the refusal is the same either way. An install that
    /// cannot describe its own version would be shown as "unknown" forever, so
    /// it is not installed.
    VersionStampMissing,
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoKeyCompiled => {
                f.write_str("this build has no release signing key, so updates cannot be verified")
            }
            Self::KeyMalformed => {
                f.write_str("the compiled release key is not a valid Ed25519 public key")
            }
            Self::ManifestUnreadable(why) => {
                write!(f, "the integrity manifest could not be read: {why}")
            }
            Self::ManifestUnsigned => f.write_str("the integrity manifest is unsigned"),
            Self::UnsupportedAlgorithm(algo) => write!(f, "unsupported manifest algorithm: {algo}"),
            Self::SignatureInvalid => f.write_str("the integrity manifest signature is invalid"),
            Self::CoverageMismatch(names) => {
                write!(
                    f,
                    "the manifest does not cover the expected bundles: {names:?}"
                )
            }
            Self::BundleMissing(name) => write!(f, "{name} is missing from the install directory"),
            Self::BundleDigestMismatch(name) => {
                write!(f, "{name} does not match the signed manifest")
            }
            Self::BundleTooLarge(name) => {
                write!(f, "{name} is larger than the {MAX_BUNDLE_BYTES} byte limit")
            }
            Self::Io { path, message } => {
                write!(f, "could not read {}: {message}", path.display())
            }
            Self::DigestMalformed(name) => {
                write!(f, "{name} has a malformed digest in the manifest")
            }
            Self::VersionStampMissing => f.write_str("the payload has no readable version stamp"),
        }
    }
}

impl std::error::Error for VerifyError {}

/// SHA-256 of a byte slice, lowercase hex.
#[must_use]
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

/// SHA-256 of a file, streamed.
///
/// Streaming rather than `read` because a hostile download is exactly the case
/// where a file could be large, and the point of the size check is to not
/// allocate it.
pub fn sha256_file(path: &Path) -> Result<String, VerifyError> {
    let file = std::fs::File::open(path).map_err(|err| VerifyError::Io {
        path: path.to_path_buf(),
        message: err.to_string(),
    })?;

    let declared = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if declared > MAX_BUNDLE_BYTES {
        return Err(VerifyError::BundleTooLarge(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        ));
    }

    let mut reader = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];

    loop {
        let read = reader.read(&mut buffer).map_err(|err| VerifyError::Io {
            path: path.to_path_buf(),
            message: err.to_string(),
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        // Writing into a String cannot fail, and the alternative is a
        // formatting error path in a function that has no other failure mode.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A verifier bound to one key.
///
/// The key is fixed when the type is built and cannot be swapped afterwards, so
/// "verify against a key that came with the payload" is not expressible. The
/// only constructor reachable from outside this crate is [`Verifier::embedded`],
/// which takes no argument; the key-accepting ones are `pub(crate)` and exist
/// for this crate's tests.
#[derive(Debug, Clone)]
pub struct Verifier {
    key: VerifyingKey,
}

impl Verifier {
    /// A verifier using the key compiled into this binary.
    ///
    /// This is the only public constructor, and it takes no key argument —
    /// which is the point. There is no way to obtain a `Verifier` that trusts
    /// anything other than the key this binary was built with, so "verify the
    /// update against a key that came with the update" is not expressible.
    ///
    /// [`crate::inject::inject`] takes a `&Verifier` rather than constructing
    /// one, and that does not weaken this: a caller can only pass what
    /// `embedded()` returned.
    pub fn embedded() -> Result<Self, VerifyError> {
        Self::from_base64_key(EMBEDDED_PUBLIC_KEY_B64)
    }

    /// Build from a base64 SPKI DER public key.
    ///
    /// **This is not what the Injector uses.** Production code calls
    /// [`Verifier::embedded`], which is the only path that ties verification to
    /// the key this binary was *built* with — a key that arrived with an update
    /// cannot verify that update.
    ///
    /// It exists for two reasons and should not be used for a third:
    ///
    ///   * this crate's own tests need a verifier bound to a throwaway key,
    ///     because the *compiled-in* key is deliberately a placeholder that
    ///     verifies nothing;
    ///   * `src-tauri`'s integration tests drive the real commands in-process
    ///     and need the same.
    ///
    /// It is `#[doc(hidden)]` so it does not read as an ordinary option, and it
    /// shares the single parsing path with `embedded()` rather than adding a
    /// second way to turn bytes into a key.
    #[doc(hidden)]
    pub fn from_base64_key(encoded: &str) -> Result<Self, VerifyError> {
        let trimmed = encoded.trim();
        if trimmed.is_empty() {
            return Err(VerifyError::NoKeyCompiled);
        }
        let der = base64_decode(trimmed).ok_or(VerifyError::KeyMalformed)?;
        Self::from_spki_der(&der).map_err(|_| VerifyError::KeyMalformed)
    }

    /// Build from a raw 32-byte Ed25519 public key. `pub(crate)` so that only
    /// this crate's tests can reach it.
    pub(crate) fn from_raw(key: [u8; 32]) -> Result<Self, VerifyError> {
        let key = VerifyingKey::from_bytes(&key).map_err(|_| VerifyError::KeyMalformed)?;
        Ok(Self { key })
    }

    fn from_spki_der(der: &[u8]) -> Result<Self, VerifyError> {
        // An SPKI DER public key for Ed25519 is 44 bytes: a fixed 12-byte
        // prefix followed by the 32-byte key. Rather than pull in a full ASN.1
        // parser, check the exact length and the algorithm identifier, then
        // take the tail. The prefix is fixed by the Ed25519 OID.
        const ED25519_SPKI_PREFIX: [u8; 12] = [
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        if der.len() != ED25519_SPKI_PREFIX.len() + 32 {
            return Err(VerifyError::KeyMalformed);
        }
        if der[..ED25519_SPKI_PREFIX.len()] != ED25519_SPKI_PREFIX {
            return Err(VerifyError::KeyMalformed);
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&der[ED25519_SPKI_PREFIX.len()..]);
        Self::from_raw(key)
    }

    /// The exact bytes a manifest signature covers.
    ///
    /// Field order and compactness must match `canonicalPayload` in
    /// `src/main/security/integrity.ts` and `canonicalPayload` in
    /// `scripts/release.mjs`.
    #[must_use]
    pub fn canonical_payload(manifest: &Manifest) -> String {
        let files: Vec<ManifestFile> = manifest
            .files
            .iter()
            .map(|entry| ManifestFile {
                name: entry.name.clone(),
                sha256: entry.sha256.clone(),
            })
            .collect();
        let canonical = CanonicalManifest {
            version: manifest.version,
            algorithm: &manifest.algorithm,
            files: &files,
        };
        // serde_json::to_string on this struct cannot fail: every field is a
        // string, a u32, or a slice of structs. A failure here would mean the
        // memory allocator is broken.
        serde_json::to_string(&canonical).unwrap_or_default()
    }

    /// Verify a manifest's signature.
    ///
    /// Structural checks first, then the signature, then coverage. The order
    /// matters: refusing an unsigned manifest before attempting a signature
    /// check keeps the failure reasons distinguishable, and checking coverage
    /// last means the thing that is actually being trusted — the signature — is
    /// validated before anything is interpreted.
    pub fn verify_manifest(&self, manifest: &Manifest) -> Result<(), VerifyError> {
        if manifest.algorithm != "ed25519" {
            return Err(VerifyError::UnsupportedAlgorithm(
                manifest.algorithm.clone(),
            ));
        }

        let Some(signature_b64) = manifest.signature.as_deref() else {
            return Err(VerifyError::ManifestUnsigned);
        };

        let payload = Self::canonical_payload(manifest);
        if !self.verify_bytes(payload.as_bytes(), signature_b64) {
            return Err(VerifyError::SignatureInvalid);
        }

        self.check_coverage(manifest)?;
        Ok(())
    }

    /// The manifest must cover exactly the three bundles, each once.
    fn check_coverage(&self, manifest: &Manifest) -> Result<(), VerifyError> {
        for name in INTEGRITY_FILES {
            let matches: Vec<&ManifestFile> = manifest
                .files
                .iter()
                .filter(|entry| entry.name == name)
                .collect();
            if matches.len() != 1 {
                return Err(VerifyError::CoverageMismatch(vec![name.to_string()]));
            }
            if !is_sha256_hex(&matches[0].sha256) {
                return Err(VerifyError::DigestMalformed(name.to_string()));
            }
        }
        let extra: Vec<String> = manifest
            .files
            .iter()
            .map(|entry| entry.name.clone())
            .filter(|name| !INTEGRITY_FILES.contains(&name.as_str()))
            .collect();
        if !extra.is_empty() {
            return Err(VerifyError::CoverageMismatch(extra));
        }
        Ok(())
    }

    /// Verify a bounded detached release or manifest signature with this trust anchor.
    pub fn verify_bytes(&self, payload: &[u8], signature_b64: &str) -> bool {
        if signature_b64.len() != 88 {
            return false;
        }
        let Some(signature_bytes) = base64_decode(signature_b64) else {
            return false;
        };
        // An Ed25519 signature is exactly 64 bytes. Rejecting on length first
        // means a caller cannot hand us a very large base64 string and have it
        // decoded before the check.
        if signature_bytes.len() != 64 {
            return false;
        }
        let Ok(signature_array) = <[u8; 64]>::try_from(signature_bytes.as_slice()) else {
            return false;
        };
        let signature = Signature::from_bytes(&signature_array);
        self.key.verify(payload, &signature).is_ok()
    }

    /// Verify an extracted install directory end to end.
    ///
    /// Order: manifest shape, manifest signature, per-bundle digests. Nothing
    /// is written by this function — the caller decides what to do with a
    /// directory that passed, which is the point. Verification and mutation are
    /// separate steps so a failure can never leave a half-installed client.
    pub fn verify_install(&self, dir: &Path) -> Result<Manifest, VerifyError> {
        let manifest_path = dir.join(MANIFEST_NAME);
        let raw = std::fs::read(&manifest_path).map_err(|err| {
            VerifyError::ManifestUnreadable(format!("{}: {err}", manifest_path.display()))
        })?;

        let manifest: Manifest = serde_json::from_slice(&raw)
            .map_err(|err| VerifyError::ManifestUnreadable(err.to_string()))?;

        self.verify_manifest(&manifest)?;
        self.verify_bundles(dir, &manifest)?;
        Ok(manifest)
    }

    /// Hash each bundle in `dir` and compare it with the signed manifest.
    pub fn verify_bundles(&self, dir: &Path, manifest: &Manifest) -> Result<(), VerifyError> {
        for name in INTEGRITY_FILES {
            let entry = manifest
                .files
                .iter()
                .find(|entry| entry.name == name)
                .ok_or_else(|| VerifyError::CoverageMismatch(vec![name.to_string()]))?;

            let path = dir.join(name);
            let actual = sha256_file(&path).map_err(|err| match err {
                VerifyError::Io { .. } => VerifyError::BundleMissing(name.to_string()),
                other => other,
            })?;

            if actual != entry.sha256 {
                return Err(VerifyError::BundleDigestMismatch(name.to_string()));
            }
        }
        Ok(())
    }
}

/// A borrowed view with the exact field order the signature covers.
///
/// Separate from [`Manifest`] on purpose: `Manifest` has a `signature` field
/// that must **not** be part of the signed bytes, and keeping a second type
/// makes that exclusion structural rather than a field someone could reorder.
#[derive(Debug, Serialize)]
struct CanonicalManifest<'a> {
    version: u32,
    algorithm: &'a str,
    files: &'a [ManifestFile],
}

/// Standard base64 decode, returning `None` on anything malformed.
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .ok()
}

/// The `package.json` the Injector writes into `resources/app`.
///
/// Byte-identical to what `scripts/inject.mjs` writes, so a directory produced
/// by either tool is the same directory.
#[must_use]
pub fn package_json_bytes() -> Vec<u8> {
    // Literal, not `serde_json`, on purpose: the point is an exact byte match
    // with the JavaScript, and a serializer would make that a coincidence of
    // key order rather than a stated fact.
    b"{\n  \"name\": \"discord\",\n  \"main\": \"main.js\",\n  \"private\": true\n}\n".to_vec()
}

/// The file recording which Syncord version an install contains.
///
/// ── This is display-only, and that is a decision, not an oversight ──────────
///
/// It is **not** covered by the signed manifest, because the manifest's file
/// list is fixed at three by `src/main/security/integrity.ts` and
/// `scripts/build.mjs`, and widening that list means changing the Electron
/// client's own integrity check.
///
/// That is acceptable because this file grants no capability and decides
/// nothing:
///
/// * it cannot make an unverified bundle verify — the digest check is over the
///   three real bundles and does not read this file;
/// * it cannot cause an update to be skipped — the update decision is made in
///   the Electron client from the *signed release descriptor*, compared against
///   the running version compiled into its own bundle, never from a file on
///   disk;
/// * the worst a tamper achieves is a misleading version number in this GUI.
///
/// The one thing that does matter is that the value is a well-formed version and
/// nothing else, since it is written to a path. [`read_version_stamp`] enforces
/// the same grammar as the TypeScript `parseVersion`.
pub const VERSION_FILE: &str = "syncord-version.json";

/// Render a version stamp.
///
/// `version` must already have passed [`normalize_version`]; this function does
/// not validate, because the caller validated it when the payload was accepted.
#[must_use]
pub fn version_stamp_bytes(version: &str) -> Vec<u8> {
    format!("{{\n  \"version\": \"{version}\"\n}}\n").into_bytes()
}

/// Read the version stamp from a payload or install directory.
///
/// Returns `None` when the file is absent, unparseable, or does not contain a
/// well-formed version. A malformed value is treated as absent rather than
/// being passed through, so a bad stamp can never reach a path or the UI as
/// something other than "unknown".
#[must_use]
pub fn read_version_stamp(dir: &Path) -> Option<String> {
    let raw = std::fs::read(dir.join(VERSION_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    let version = value.get("version")?.as_str()?;
    normalize_version(version)
}

/// Normalize and validate a version string, or return `None`.
///
/// The grammar is deliberately identical to `NUMERIC_CORE` and `PRE_RELEASE` in
/// `src/shared/version.ts`: one to four dot-separated numeric components with
/// no leading zeros, optionally followed by `-` and a pre-release identifier.
/// A build-metadata suffix is not accepted, matching the TypeScript, which
/// discards it before comparing.
#[must_use]
pub fn normalize_version(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 64 {
        return None;
    }
    if !raw.is_ascii() {
        return None;
    }

    let (core, pre) = match raw.split_once('-') {
        Some((core, pre)) => {
            if pre.is_empty() || pre.len() > 32 {
                return None;
            }
            if !pre
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            {
                return None;
            }
            if pre.split('.').any(str::is_empty) {
                return None;
            }
            (core, pre)
        }
        None => (raw, ""),
    };

    let parts: Vec<&str> = core.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    for part in &parts {
        if part.is_empty() || part.len() > 6 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        // "01" is ambiguous and is refused rather than coerced, matching
        // `src/shared/version.ts`.
        if part.len() > 1 && part.starts_with('0') {
            return None;
        }
    }

    Some(if pre.is_empty() {
        core.to_string()
    } else {
        format!("{core}-{pre}")
    })
}
