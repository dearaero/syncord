//! Archive extraction for release payloads.
//!
//! Extraction is where a verified download becomes files on disk, so this is
//! the module with the most hostile input it will ever see. Everything in it is
//! written on the assumption that the archive is attacker-controlled even
//! though its digest came from a signed descriptor — a digest proves the bytes
//! are *the ones we published*, and a published archive can still contain a
//! traversal entry if our own packaging is ever wrong.
//!
//! ── zip-slip ─────────────────────────────────────────────────────────────────
//!
//! The rule is: an entry name is **data**, never a path. It is validated
//! against a fixed grammar and then joined onto a destination, and the joined
//! result is re-checked to be inside that destination. A name is refused if it
//! is absolute, contains `..` as a component, contains a backslash, a NUL, a
//! control character, a Windows drive or UNC prefix, or is not one of the
//! filenames a Syncord payload is allowed to contain.
//!
//! The allowlist is the second layer and the stronger one: a Syncord install is
//! exactly five files. Anything else in the archive is refused outright, so
//! even a grammar bypass cannot write a file nobody expected.
//!
//! Symlink and hardlink entries are refused rather than followed or recreated.
//! A payload has no use for a link, and recreating one is how an extractor
//! turns a single write into a write anywhere.
//!
//! ── Size limits ─────────────────────────────────────────────────────────────
//!
//! Three independent ceilings, because each catches a case the others do not:
//! declared per-entry size, bytes actually read per entry, and total bytes
//! across the archive. A lying header is caught by the second, a decompression
//! bomb by the third, and a legitimately enormous payload by the first.

use std::fmt;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

use crate::verify::INTEGRITY_FILES;

/// Files an archive must contain for extraction to succeed.
///
/// `package.json` is deliberately **not** here. The Injector writes it itself
/// from [`crate::verify::package_json_bytes`], and a test asserts that is
/// byte-identical to what `scripts/inject.mjs` produces. Accepting a copy from
/// the archive would mean trusting a file for content we generate
/// deterministically — and anything the archive supplied would be overwritten
/// immediately after the swap anyway.
///
/// [`crate::verify::VERSION_FILE`] *is* required, but only for its presence:
/// its value is not covered by the signed manifest, and
/// [`crate::verify::read_version_stamp`] validates the value separately. An
/// install that cannot state its own version is one the GUI shows as "unknown"
/// forever.
pub const PAYLOAD_REQUIRED: [&str; 5] = [
    "main.js",
    "preload.js",
    "renderer.js",
    crate::verify::MANIFEST_NAME,
    crate::verify::VERSION_FILE,
];

/// Every filename an archive entry may carry.
///
/// [`PAYLOAD_REQUIRED`] plus `package.json`, which is permitted so an archive
/// produced by a packaging step that includes it is not rejected, and refused
/// for every other name so a grammar bypass cannot write a file nobody expected.
pub const PAYLOAD_ALLOWED: [&str; 6] = [
    "main.js",
    "preload.js",
    "renderer.js",
    crate::verify::MANIFEST_NAME,
    crate::verify::VERSION_FILE,
    crate::verify::PACKAGE_JSON_NAME,
];

/// Ceilings applied to any extracted archive.
#[allow(missing_docs)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtractionLimits {
    /// Maximum declared size of a single entry.
    pub max_entry_bytes: u64,
    /// Maximum total decompressed size across the whole archive.
    pub max_total_bytes: u64,
    /// Maximum number of entries, including directories.
    pub max_entries: usize,
    /// Maximum length of an entry name.
    pub max_name_len: usize,
}

impl Default for ExtractionLimits {
    fn default() -> Self {
        Self {
            // Comfortably above `MAX_BUNDLE_BYTES` per bundle, because an
            // entry is one bundle.
            max_entry_bytes: 64 * 1024 * 1024,
            // Three bundles plus slack. A source map is the largest thing that
            // legitimately ships, and the total is still far below anything
            // that would fill a disk.
            max_total_bytes: 192 * 1024 * 1024,
            // A payload is five files. A generous ceiling still catches an
            // archive designed to exhaust inodes.
            max_entries: 64,
            max_name_len: 96,
        }
    }
}

/// Why extraction was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveError {
    /// The bytes are neither a zip nor a gzip-wrapped tar.
    UnrecognisedFormat,
    /// The archive itself is malformed.
    Malformed(String),
    /// An entry name is outside the allowed grammar. Carries the name, because
    /// refusing an archive without saying which entry caused it makes the
    /// failure impossible to diagnose.
    UnsafeEntryName(String),
    /// An entry is a link. Never followed, never created.
    LinkEntry(String),
    /// An entry is not a regular file or a directory.
    SpecialEntry(String),
    /// The entry name is not one of [`PAYLOAD_FILES`].
    UnexpectedEntry(String),
    /// A required payload file was missing.
    IncompletePayload(Vec<String>),
    /// A declared or actual size exceeded a limit.
    TooLarge {
        /// Which entry, or "the archive", for display.
        what: String,
        /// The ceiling that was exceeded.
        limit: u64,
    },
    /// Too many entries.
    TooManyEntries(usize),
    /// An I/O error writing to the destination.
    Io {
        /// The path that could not be written.
        path: PathBuf,
        /// The underlying error, for display.
        message: String,
    },
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnrecognisedFormat => {
                f.write_str("the payload is not a zip or a gzipped tar archive")
            }
            Self::Malformed(why) => write!(f, "the archive is malformed: {why}"),
            Self::UnsafeEntryName(name) => {
                write!(f, "refusing archive entry with an unsafe name: {name:?}")
            }
            Self::LinkEntry(name) => write!(f, "refusing a link entry in the archive: {name:?}"),
            Self::SpecialEntry(name) => {
                write!(f, "refusing an entry that is not a regular file: {name:?}")
            }
            Self::UnexpectedEntry(name) => write!(
                f,
                "the archive contains {name:?}, which is not part of a Syncord payload"
            ),
            Self::IncompletePayload(missing) => {
                write!(f, "the payload is missing required files: {missing:?}")
            }
            Self::TooLarge { what, limit } => {
                write!(f, "{what} exceeds the {limit} byte limit")
            }
            Self::TooManyEntries(count) => {
                write!(
                    f,
                    "the archive contains more than the permitted number of entries ({count})"
                )
            }
            Self::Io { path, message } => {
                write!(f, "could not write {}: {message}", path.display())
            }
        }
    }
}

impl std::error::Error for ArchiveError {}

/// Validate an entry name and resolve it against `dest`.
///
/// Returns the absolute path to write, having proved it is inside `dest`.
/// The proof is done twice: the name is checked component by component, and the
/// joined path is then re-examined. A single check is a single mistake away
/// from a traversal; two independent ones are not.
pub fn safe_entry_path(
    dest: &Path,
    name: &str,
    limits: &ExtractionLimits,
) -> Result<PathBuf, ArchiveError> {
    if name.is_empty() {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }
    if name.len() > limits.max_name_len {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }
    if name.contains('\0') {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }
    if name.chars().any(char::is_control) {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }
    // A backslash is a path separator on Windows and a legal filename character
    // on Unix. Treating it as data here means one archive cannot mean two
    // different things depending on where it is opened.
    if name.contains('\\') {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }
    // Absolute path, Windows drive prefix, or UNC share.
    if name.starts_with('/') {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }

    let relative = Path::new(name);
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                // `..` and `.` are not `Normal`, and the allowlist below would
                // reject them anyway. This loop is the explicit statement that
                // only plain names are acceptable.
                if part == ".." || part == "." || part.is_empty() {
                    return Err(ArchiveError::UnsafeEntryName(name.to_string()));
                }
            }
            _ => return Err(ArchiveError::UnsafeEntryName(name.to_string())),
        }
    }

    // Percent-encoded traversal.
    //
    // This extractor never decodes an entry name, so `..%2f..%2fevil` would be
    // created as a literal filename inside `dest` and is not a traversal *here*.
    // It is refused anyway, for two reasons: the allowlist would reject it
    // regardless, and refusing it here means a name that is dangerous to
    // *anything* downstream — a future decode step, a log line, an OS that
    // normalises — never reaches the filesystem in the first place. Matches
    // `containsTraversal` in `src/security/paths.ts`, which decodes repeatedly
    // for the same reason.
    if decodes_to_traversal(name) {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }

    // Second, independent check on the assembled path.
    let joined = dest.join(relative);
    let normalised = normalise(&joined);
    if !normalised.starts_with(dest) {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }
    // A payload never nests, so anything with a parent directory is refused.
    if normalised.parent() != Some(dest) {
        return Err(ArchiveError::UnsafeEntryName(name.to_string()));
    }

    Ok(normalised)
}

/// Does percent-decoding this name ever produce a `..` path segment?
///
/// Decoding is repeated a bounded number of times, because a single pass turns
/// `..%252f` into `..%2f` and stops. Three rounds matches the shared TypeScript
/// helper and is enough to catch any realistic double-encoding; the loop is
/// bounded so a crafted input cannot make this spin.
fn decodes_to_traversal(name: &str) -> bool {
    let mut current = name.to_string();
    for _ in 0..3 {
        let Ok(decoded) = percent_decode(&current) else {
            // A malformed escape is not a traversal, but it is also not a name
            // this extractor will accept, so report it as unsafe.
            return true;
        };
        if decoded == current {
            return current.split('/').any(|part| part == "..");
        }
        current = decoded;
    }
    current.split('/').any(|part| part == "..")
}

/// Percent-decode, treating `+` as literal and a malformed escape as an error.
fn percent_decode(input: &str) -> Result<String, ()> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| ())?;
            let value = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            out.push(value);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// Resolve `.` and `..` lexically, without touching the filesystem.
///
/// `canonicalize` is deliberately not used here: the destination does not exist
/// yet during a first install, and on macOS canonicalising a path under
/// `/var` versus `/private/var` would make a legitimate destination look like a
/// traversal. Lexical normalisation is the correct tool for a path built from a
/// validated name.
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Is this an allowed payload filename?
fn is_payload_file(name: &str) -> bool {
    PAYLOAD_ALLOWED.contains(&name)
}

/// Extract a payload archive into `dest`, which must already exist.
///
/// `dest` is expected to be a fresh, empty staging directory. The caller is
/// responsible for that: this function writes file by file, and an atomic
/// directory swap is what makes the whole set appear at once.
pub fn extract_payload(
    bytes: &[u8],
    dest: &Path,
    limits: &ExtractionLimits,
) -> Result<Extracted, ArchiveError> {
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        extract_tar_gz(bytes, dest, limits)
    } else if bytes.len() >= 4 && &bytes[..4] == b"PK\x03\x04" {
        extract_zip(bytes, dest, limits)
    } else {
        Err(ArchiveError::UnrecognisedFormat)
    }
}

/// What was extracted.
#[allow(missing_docs)]
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Extracted {
    pub files: Vec<String>,
    pub total_bytes: u64,
}

impl Extracted {
    /// Every required payload file must be present. A partial extraction is an
    /// error rather than a warning, because the caller would otherwise be
    /// invited to install a directory that will not boot.
    fn require_complete(&self) -> Result<(), ArchiveError> {
        let missing: Vec<String> = PAYLOAD_REQUIRED
            .iter()
            .filter(|name| !self.files.iter().any(|seen| seen == *name))
            .map(|name| (*name).to_string())
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(ArchiveError::IncompletePayload(missing))
        }
    }
}

/// Count a declared size against the limits.
fn check_declared(
    name: &str,
    declared: u64,
    limits: &ExtractionLimits,
) -> Result<(), ArchiveError> {
    if declared > limits.max_entry_bytes {
        return Err(ArchiveError::TooLarge {
            what: name.to_string(),
            limit: limits.max_entry_bytes,
        });
    }
    Ok(())
}

/// Copy at most `limit` bytes from `reader` into `dest`.
///
/// The counter is checked on every chunk, so a header that under-reports its
/// own size is caught by the running total rather than trusted.
fn copy_bounded(
    mut reader: impl Read,
    dest: &Path,
    name: &str,
    limits: &ExtractionLimits,
) -> Result<u64, ArchiveError> {
    let file = std::fs::File::create(dest).map_err(|err| ArchiveError::Io {
        path: dest.to_path_buf(),
        message: err.to_string(),
    })?;
    let mut writer = std::io::BufWriter::with_capacity(64 * 1024, file);
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;

    loop {
        let read = reader.read(&mut buffer).map_err(|err| ArchiveError::Io {
            path: dest.to_path_buf(),
            message: err.to_string(),
        })?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > limits.max_entry_bytes {
            return Err(ArchiveError::TooLarge {
                what: name.to_string(),
                limit: limits.max_entry_bytes,
            });
        }
        std::io::Write::write_all(&mut writer, &buffer[..read]).map_err(|err| {
            ArchiveError::Io {
                path: dest.to_path_buf(),
                message: err.to_string(),
            }
        })?;
    }

    std::io::Write::flush(&mut writer).map_err(|err| ArchiveError::Io {
        path: dest.to_path_buf(),
        message: err.to_string(),
    })?;
    Ok(total)
}

fn extract_zip(
    bytes: &[u8],
    dest: &Path,
    limits: &ExtractionLimits,
) -> Result<Extracted, ArchiveError> {
    let cursor = Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|err| ArchiveError::Malformed(err.to_string()))?;

    if archive.len() > limits.max_entries {
        return Err(ArchiveError::TooManyEntries(archive.len()));
    }

    let mut out = Extracted::default();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| ArchiveError::Malformed(err.to_string()))?;

        // The raw name, never `enclosed_name()`. `enclosed_name` *sanitises*
        // a bad name into a different, safe one and carries on; refusing is the
        // behaviour we want, because a sanitised name means the archive did not
        // contain what it claimed to.
        let raw_name = entry.name().to_string();

        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind == 0o120000 || kind == 0o100000 {
                return Err(ArchiveError::LinkEntry(raw_name));
            }
            if kind != 0 && kind != 0o100000 && kind != 0o040000 && kind != 0o140000 {
                return Err(ArchiveError::SpecialEntry(raw_name));
            }
            if kind == 0o140000 {
                return Err(ArchiveError::LinkEntry(raw_name));
            }
        }

        let trimmed = raw_name.trim_end_matches('/');
        if trimmed.is_empty() {
            // An explicit directory entry. Allowed, and ignored: a payload has
            // no subdirectories, and a directory entry alone is harmless.
            continue;
        }

        let target = safe_entry_path(dest, trimmed, limits)?;
        let name = trimmed.to_string();

        if !is_payload_file(&name) {
            return Err(ArchiveError::UnexpectedEntry(name));
        }
        if out.files.contains(&name) {
            // A duplicate name means one entry would silently overwrite
            // another. Refusing is the only safe reading of an archive that
            // disagrees with itself.
            return Err(ArchiveError::UnexpectedEntry(name));
        }

        check_declared(&name, entry.size(), limits)?;
        if out.total_bytes.saturating_add(entry.size()) > limits.max_total_bytes {
            return Err(ArchiveError::TooLarge {
                what: "the archive".to_string(),
                limit: limits.max_total_bytes,
            });
        }

        let written = copy_bounded(&mut entry, &target, &name, limits)?;
        out.total_bytes += written;
        out.files.push(name);
    }

    out.require_complete()?;
    Ok(out)
}

fn extract_tar_gz(
    bytes: &[u8],
    dest: &Path,
    limits: &ExtractionLimits,
) -> Result<Extracted, ArchiveError> {
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);

    let entries = archive
        .entries()
        .map_err(|err| ArchiveError::Malformed(err.to_string()))?;

    let mut out = Extracted::default();
    let mut seen_entries: usize = 0;

    for entry in entries {
        let mut entry = entry.map_err(|err| ArchiveError::Malformed(err.to_string()))?;
        seen_entries += 1;
        if seen_entries > limits.max_entries {
            return Err(ArchiveError::TooManyEntries(seen_entries));
        }

        let header_type = entry.header().entry_type();
        if header_type.is_dir() {
            continue;
        }
        if header_type.is_symlink() || header_type.is_hard_link() {
            let name = entry
                .path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "<unknown>".to_string());
            return Err(ArchiveError::LinkEntry(name));
        }
        // `is_file()` covers both a declared regular file and the "unknown"
        // type, which is what an archive written by a tool that does not set
        // the type flag looks like. Both are fine; anything else is not.
        if !header_type.is_file() {
            let name = entry
                .path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "<unknown>".to_string());
            return Err(ArchiveError::SpecialEntry(name));
        }

        let raw_path = entry
            .path()
            .map_err(|err| ArchiveError::Malformed(err.to_string()))?
            .to_string_lossy()
            .into_owned();

        // A tar can prefix every entry with `./`; normalise that away before
        // validating, since it changes nothing about where the file lands.
        let name = raw_path.strip_prefix("./").unwrap_or(&raw_path).to_string();

        let target = safe_entry_path(dest, &name, limits)?;

        if !is_payload_file(&name) {
            return Err(ArchiveError::UnexpectedEntry(name));
        }
        if out.files.contains(&name) {
            return Err(ArchiveError::UnexpectedEntry(name));
        }

        let declared = entry.header().size().unwrap_or(0);
        check_declared(&name, declared, limits)?;
        if out.total_bytes.saturating_add(declared) > limits.max_total_bytes {
            return Err(ArchiveError::TooLarge {
                what: "the archive".to_string(),
                limit: limits.max_total_bytes,
            });
        }

        let written = copy_bounded(&mut entry, &target, &name, limits)?;
        out.total_bytes += written;
        out.files.push(name);
    }

    out.require_complete()?;
    Ok(out)
}

/// The bundle names an install must contain, in manifest order.
///
/// Small helper so `inject` does not have to know that `INTEGRITY_FILES` and
/// `PAYLOAD_FILES` overlap but are not the same list.
#[must_use]
pub fn bundle_names() -> [&'static str; 3] {
    INTEGRITY_FILES
}
