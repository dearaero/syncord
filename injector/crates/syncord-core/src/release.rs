//! Signed release policy shared by the Injector's GUI and command line.
//! No sockets or caller-supplied download addresses belong in this module.

use crate::verify::{normalize_version, Verifier};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// The public feed is independent of the source repository.
pub const REPOSITORY: &str = "dearaero/syncord-releases";
/// Maximum bytes accepted for a GitHub release response.
pub const MAX_DESCRIPTOR_BYTES: u64 = 256 * 1024;
/// Maximum signed archive size.
pub const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;

/// Signed platform-specific archive description; order matches TypeScript.
#[allow(missing_docs)]
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Asset {
    pub platform: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

/// Exact signed JSON field order from scripts/release.mjs.
#[derive(Debug, Deserialize, Serialize)]
struct Descriptor {
    version: u32,
    channel: String,
    release: String,
    #[serde(rename = "publishedAt")]
    published_at: String,
    assets: Vec<Asset>,
    #[serde(skip_serializing)]
    signature: String,
}

#[derive(Debug, Deserialize)]
struct Envelope {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: String,
}

/// A selected release whose descriptor and signature have already passed.
#[allow(missing_docs)]
#[derive(Debug, Clone)]
pub struct VerifiedRelease {
    pub version: String,
    pub asset: Asset,
}

/// Payload platform for the current binary, never supplied by the webview.
#[must_use]
pub fn current_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "mac",
        "windows" => "windows",
        _ => "linux",
    };
    let arch = if std::env::consts::ARCH == "aarch64" {
        "arm64"
    } else {
        "x64"
    };
    format!("{os}-{arch}")
}

/// Version ordering compatible with the client's 1–4 component version format.
#[must_use]
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    fn parts(raw: &str) -> (Vec<u32>, String) {
        let normal = normalize_version(raw).unwrap_or_default();
        let (core, pre) = normal.split_once('-').unwrap_or((&normal, ""));
        (
            core.split('.').filter_map(|p| p.parse().ok()).collect(),
            pre.to_string(),
        )
    }
    let (a, ap) = parts(left);
    let (b, bp) = parts(right);
    for i in 0..4 {
        let ord = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if ord != Ordering::Equal {
            return ord;
        }
    }
    match (ap.is_empty(), bp.is_empty()) {
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    let aa: Vec<_> = ap.split('.').collect();
    let bb: Vec<_> = bp.split('.').collect();
    for (a, b) in aa.iter().zip(&bb) {
        let ord = match (a.parse::<u64>(), b.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            _ => a.cmp(b),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    aa.len().cmp(&bb.len())
}

/// Validate metadata, platform binding and the Ed25519 descriptor signature.
pub fn verify_release(
    bytes: &[u8],
    verifier: &Verifier,
    platform: &str,
) -> Result<VerifiedRelease, String> {
    if bytes.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return Err("Release information is too large.".into());
    }
    let envelope: Envelope = serde_json::from_slice(bytes)
        .map_err(|_| "GitHub returned invalid release information.")?;
    if envelope.draft || envelope.prerelease {
        return Err("The stable feed returned a draft or prerelease.".into());
    }
    let descriptor: Descriptor = serde_json::from_str(&envelope.body)
        .map_err(|_| "The release has no valid signed descriptor.")?;
    let normalized =
        normalize_version(&descriptor.release).ok_or("The release version is malformed.")?;
    if descriptor.version != 1
        || descriptor.channel != "stable"
        || envelope.tag_name != format!("v{normalized}")
        || normalized != descriptor.release
    {
        return Err(
            "Release tag, version or channel does not agree with the signed descriptor.".into(),
        );
    }
    let valid_time = descriptor
        .published_at
        .bytes()
        .enumerate()
        .all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 | 16 => b == b':',
            19 => b == b'Z',
            _ => b.is_ascii_digit(),
        });
    if descriptor.published_at.len() != 20
        || !valid_time
        || descriptor.assets.is_empty()
        || descriptor.assets.len() > 12
    {
        return Err("The signed release descriptor has an invalid shape.".into());
    }
    let mut seen = std::collections::HashSet::new();
    for asset in &descriptor.assets {
        let valid_platform = [
            "windows-x64",
            "windows-arm64",
            "mac-x64",
            "mac-arm64",
            "linux-x64",
            "linux-arm64",
        ]
        .contains(&asset.platform.as_str());
        let safe_name = asset.name.starts_with("syncord-")
            && asset.name.len() <= 96
            && !asset.name.contains("..")
            && asset
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
            && (asset.name.ends_with(".tar.gz") || asset.name.ends_with(".zip"));
        if !valid_platform
            || !seen.insert(&asset.platform)
            || !safe_name
            || asset.size == 0
            || asset.size > MAX_ASSET_BYTES
            || asset.sha256.len() != 64
            || !asset
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("The release describes an invalid or duplicate archive.".into());
        }
    }
    let canonical =
        serde_json::to_vec(&descriptor).map_err(|_| "The release could not be canonicalized.")?;
    if !verifier.verify_bytes(&canonical, &descriptor.signature) {
        return Err("The release signature is invalid. Nothing will be installed.".into());
    }
    let asset = descriptor
        .assets
        .iter()
        .find(|a| a.platform == platform)
        .cloned()
        .ok_or("This release has no payload for this platform.")?;
    Ok(VerifiedRelease {
        version: normalized,
        asset,
    })
}

impl VerifiedRelease {
    /// Construct from trusted constants and validated signed names only.
    #[must_use]
    pub fn download_url(&self) -> String {
        format!(
            "https://github.com/{REPOSITORY}/releases/download/v{}/{}",
            self.version, self.asset.name
        )
    }
}
