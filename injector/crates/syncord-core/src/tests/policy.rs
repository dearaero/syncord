//! Policy tests for the Injector's dependency and licence rules.
//!
//! `injector/` is outside the reach of `scripts/security-scan.mjs`, which walks
//! `src/` and `scripts/` for `.ts`/`.js`/`.mjs`. `cargo clippy -D warnings` and
//! the `cargo deny` / `cargo audit` runs in CI are the automated gates on this
//! code — and a gate that can be widened without anyone noticing is not a gate.
//!
//! These tests exist for that reason. They assert the *shape* of `deny.toml`:
//! which advisories are pinned, which licences are allowed, and where crates may
//! come from. Changing any of them requires changing a test, which puts the
//! change in a diff where a reviewer sees it.
//!
//! They do not re-run `cargo deny` — that is the job's job, and duplicating it
//! would mean duplicating its licence database.

use std::path::PathBuf;

/// The policy file, relative to this crate.
fn deny_toml() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("deny.toml")
}

fn policy() -> String {
    std::fs::read_to_string(deny_toml()).unwrap_or_else(|err| {
        panic!(
            "deny.toml must be readable at {}: {err}",
            deny_toml().display()
        )
    })
}

/// Strip a TOML comment, respecting quoted strings.
///
/// TOML uses `#`, not `//` — and the crates.io registry URL in `deny.toml`
/// contains `//`, so a naive `split("//")` would truncate it while leaving the
/// real comments in place. This is not a TOML parser; it is just enough to read
/// the file this project writes, which keeps the test's own dependency count at
/// zero in a file whose job is constraining dependencies.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b'#' if !in_single && !in_double => return &line[..index],
            _ => {}
        }
    }
    line
}

/// The value of a string array in a `[section]` of the file.
fn string_array(source: &str, section: &str, key: &str) -> Vec<String> {
    let mut in_section = false;
    let mut out = Vec::new();
    let mut collecting = false;

    for raw in source.lines() {
        let trimmed_raw = raw.trim();
        // A whole-line comment is documentation, not content. Without this a
        // comment that happens to start with `[` would be read as a section
        // header.
        if trimmed_raw.starts_with('#') {
            continue;
        }
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            // Blank lines separate logical groups *inside* an array; the
            // licence list uses them. Treating one as the end of the array would
            // silently truncate it.
            continue;
        }
        if line.starts_with('[') {
            // A new section header ends both the section and any open array.
            in_section = line == format!("[{section}]");
            collecting = false;
            continue;
        }
        if !in_section {
            continue;
        }
        if collecting {
            if !line.starts_with('"') {
                collecting = false;
                continue;
            }
            let Some(value) = line.trim_end_matches(',').trim().strip_prefix('"') else {
                collecting = false;
                continue;
            };
            let Some(value) = value.strip_suffix('"') else {
                collecting = false;
                continue;
            };
            out.push(value.to_string());
            continue;
        }
        if line == key || line.starts_with(&format!("{key} = [")) {
            if line.ends_with(']') {
                // Single-line array.
                let inner = line
                    .trim_start_matches(&format!("{key} = ["))
                    .trim_end_matches(']');
                for part in inner.split(',') {
                    if let Some(value) = part
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        out.push(value.to_string());
                    }
                }
            } else {
                collecting = true;
            }
        }
    }

    out
}

/// A scalar string or bare value on its own line, e.g. `unknown-git = "deny"`.
fn scalar(source: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;
    for raw in source.lines() {
        let trimmed_raw = raw.trim();
        // A whole-line comment is documentation, not content. Without this a
        // comment that happens to start with `[` would be read as a section
        // header.
        if trimmed_raw.starts_with('#') {
            continue;
        }
        let line = strip_comment(raw).trim();
        if line.starts_with('[') {
            in_section = line == format!("[{section}]");
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(rest) = line.strip_prefix(&format!("{key} =")) {
            let value = rest
                .trim()
                .trim_end_matches(',')
                .trim()
                .trim_matches('"')
                .to_string();
            return Some(value);
        }
    }
    None
}

#[test]
fn the_pinned_advisory_list_does_not_grow() {
    // The whole point of listing RUSTSEC-2024-0370 by ID rather than
    // downgrading unmaintained warnings to non-fatal: adding a second entry is
    // a decision somebody has to make deliberately, in a diff, next to a test
    // that changes.
    let ignored = string_array(&policy(), "advisories", "ignore");
    assert_eq!(
        ignored,
        vec!["RUSTSEC-2024-0370"],
        "deny.toml ignores a different advisory set than the test expects. \
         If this is deliberate, update this test and the justification in \
         deny.toml at the same time — and check whether the dependency can be \
         upgraded instead."
    );
}

#[test]
fn every_pinned_advisory_carries_a_justification() {
    // An ignore entry with no comment next to it is an unexplained hole.
    let source = policy();
    let mut checked = 0;
    for line in source.lines() {
        let trimmed = line.trim();
        // Documentation of the entry, not the entry itself.
        if trimmed.starts_with('#') {
            continue;
        }
        if !trimmed.contains("RUSTSEC-") {
            continue;
        }
        assert!(
            trimmed.contains(" # "),
            "every RUSTSEC entry in deny.toml needs a trailing comment saying why: {trimmed}"
        );
        checked += 1;
    }
    assert!(
        checked > 0,
        "no RUSTSEC entry was found — the policy file changed shape"
    );
}

#[test]
fn no_strong_copyleft_is_allowed_in_syncord_core() {
    // MPL-2.0 is allowed once, with a written exception, because five crates
    // arrive through Tauri → wry → html5ever → servo/selectors. If the count of
    // copyleft entries ever rises, or MPL appears for a reason other than the
    // documented path, this fails.
    let allowed = string_array(&policy(), "licenses", "allow");
    let copyleft: Vec<&String> = allowed
        .iter()
        .filter(|licence| {
            let upper = licence.to_ascii_uppercase();
            upper.contains("GPL") || upper.contains("LGPL") || upper.contains("AGPL")
        })
        .collect();

    assert!(
        copyleft.is_empty(),
        "no GPL/LGPL/AGPL licence may be allowed; the allowlist is exhaustive \
         and these are refused by omission. Found: {copyleft:?}"
    );

    let mpl_count = allowed
        .iter()
        .filter(|licence| licence.as_str() == "MPL-2.0")
        .count();
    assert_eq!(mpl_count, 1, "MPL-2.0 appears in the allowlist");
}

#[test]
fn the_licence_allowlist_has_no_unused_entries() {
    // cargo-deny reports an "unmatched license allowance" for an entry that
    // matches nothing, but only as a warning. Asserting it here means the list
    // cannot quietly accumulate permissions nobody actually needs — which is
    // how an allowlist rots into a denylist by accident.
    let allowed = string_array(&policy(), "licenses", "allow");
    assert!(
        !allowed.is_empty(),
        "the licence allowlist must not be empty"
    );

    // Every entry must be one the resolved graph actually uses. These are the
    // licences present in the current lockfile.
    const IN_USE: [&str; 13] = [
        "ISC",
        "MIT",
        "MIT-0",
        "Apache-2.0",
        "Apache-2.0 WITH LLVM-exception",
        "0BSD",
        "BSD-1-Clause",
        "BSD-3-Clause",
        "Zlib",
        "Unicode-3.0",
        "CC0-1.0",
        "Unlicense",
        "MPL-2.0",
    ];
    for entry in &allowed {
        assert!(
            IN_USE.contains(&entry.as_str()),
            "{entry:?} is allowed but not used by any resolved dependency; \
             remove it so the allowlist stays a statement about reality"
        );
    }
}

#[test]
fn dependency_sources_are_locked_to_crates_io() {
    // The "someone's fork of a crate" supply-chain path, closed. A git
    // dependency, a local path outside the workspace, or a registry mirror all
    // fail here.
    let source = policy();
    assert_eq!(
        scalar(&source, "sources", "unknown-registry").as_deref(),
        Some("deny"),
        "an unrecognised registry must be denied"
    );
    assert_eq!(
        scalar(&source, "sources", "unknown-git").as_deref(),
        Some("deny"),
        "a git dependency must be denied"
    );
    assert!(
        string_array(&source, "sources", "allow-git").is_empty(),
        "no git source may be allowed"
    );

    let registries = string_array(&source, "sources", "allow-registry");
    assert_eq!(
        registries,
        vec!["https://github.com/rust-lang/crates.io-index"],
        "crates.io is the only permitted source"
    );
}

#[test]
fn every_target_platform_is_walked() {
    // A Linux-only or Windows-only transitive dependency is invisible to
    // cargo-deny unless its target is listed. Listing only the host would let a
    // GPL crate ride in on a platform nobody was looking at.
    let targets = string_array(&policy(), "graph", "targets");
    for required in [
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
        "x86_64-pc-windows-msvc",
        "aarch64-pc-windows-msvc",
        "x86_64-apple-darwin",
        "aarch64-apple-darwin",
    ] {
        assert!(
            targets.iter().any(|target| target == required),
            "{required} must be in [graph].targets, or a dependency only used on \
             that platform escapes the licence and advisory checks. Found: {targets:?}"
        );
    }
}

#[test]
fn an_unidentified_licence_is_not_assumed_permissive() {
    // `private.ignore = true` means "a private crate *inside this workspace* is
    // not a licensing problem". It is correct here, because the workspace has
    // two members and both declare `license.workspace = true`.
    //
    // It must stay `true` and nothing more may be added: a private crate from
    // *outside* the workspace is not something we ship, and that is the case
    // this setting could quietly start permitting.
    let source = policy();
    let private = scalar(&source, "licenses", "private").unwrap_or_default();
    assert_eq!(
        private, "{ ignore = true }",
        "cargo-deny's `private` setting must remain exactly `{{ ignore = true }}`"
    );
    assert!(
        !source.contains("private = { ignore = false }"),
        "a private crate from outside the workspace must not be accepted"
    );
}
