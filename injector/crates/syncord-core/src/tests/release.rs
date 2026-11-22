#![allow(clippy::unwrap_used)]
use crate::{
    release::{compare_versions, verify_release},
    testsupport::{sign, sign_with_other, verifier},
};
use std::cmp::Ordering;

fn canonical(version: &str) -> String {
    format!(
        r#"{{"version":1,"channel":"stable","release":"{version}","publishedAt":"2026-10-01T12:00:00Z","assets":[{{"platform":"mac-arm64","name":"syncord-{version}-mac-arm64.tar.gz","size":100,"sha256":"{}"}}]}}"#,
        "a".repeat(64)
    )
}
/// The feed serves the signed descriptor itself, with the signature added.
fn envelope(canonical: &str, signature: &str) -> Vec<u8> {
    let mut descriptor: serde_json::Value = serde_json::from_str(canonical).unwrap();
    descriptor["signature"] = signature.into();
    serde_json::to_vec(&descriptor).unwrap()
}
#[test]
fn signed_release_selects_a_future_client_without_an_injector_version_bound() {
    let canonical = canonical("0.1.4");
    let release = verify_release(
        &envelope(&canonical, &sign(canonical.as_bytes())),
        &verifier(),
        "mac-arm64",
    )
    .unwrap();
    assert_eq!(release.version, "0.1.4");
    assert_eq!(
        release.download_url(),
        "https://api.syncord.pro/v1/update/releases/0.1.4/syncord-0.1.4-mac-arm64.tar.gz"
    );
}
#[test]
fn forged_descriptor_and_cross_platform_selection_are_refused() {
    let canonical = canonical("0.1.4");
    assert!(verify_release(
        &envelope(&canonical, &sign_with_other(canonical.as_bytes())),
        &verifier(),
        "mac-arm64"
    )
    .is_err());
    let bytes = envelope(&canonical, &sign(canonical.as_bytes()));
    assert!(verify_release(&bytes, &verifier(), "windows-x64").is_err());
    let changed = canonical.replace("\"size\":100", "\"size\":200");
    assert!(verify_release(
        &envelope(&changed, &sign(canonical.as_bytes())),
        &verifier(),
        "mac-arm64"
    )
    .is_err());
}
#[test]
fn a_signed_unsafe_name_a_wrong_channel_and_a_github_envelope_are_refused() {
    let bad =
        canonical("0.1.4").replace("syncord-0.1.4-mac-arm64.tar.gz", "syncord-../secret.tar.gz");
    assert!(verify_release(
        &envelope(&bad, &sign(bad.as_bytes())),
        &verifier(),
        "mac-arm64"
    )
    .is_err());
    let beta = canonical("0.1.4").replace("\"stable\"", "\"beta\"");
    assert!(verify_release(
        &envelope(&beta, &sign(beta.as_bytes())),
        &verifier(),
        "mac-arm64"
    )
    .is_err());
    // The old feed wrapped the descriptor in a release object; that is not the feed.
    let canonical = canonical("0.1.4");
    let inner: serde_json::Value =
        serde_json::from_slice(&envelope(&canonical, &sign(canonical.as_bytes()))).unwrap();
    let wrapped = serde_json::json!({"tag_name": "v0.1.4", "draft": false, "prerelease": false, "body": inner.to_string()});
    assert!(verify_release(
        &serde_json::to_vec(&wrapped).unwrap(),
        &verifier(),
        "mac-arm64"
    )
    .is_err());
}
#[test]
fn the_feed_address_is_a_constant_on_the_update_host() {
    assert_eq!(
        crate::release::feed_url(),
        "https://api.syncord.pro/v1/update/stable"
    );
}
#[test]
fn ordering_prevents_downgrades_and_supports_future_versions() {
    for (left, right, expected) in [
        ("0.1.4", "0.1.3", Ordering::Greater),
        ("0.10.0", "0.9.9", Ordering::Greater),
        ("0.1.4-beta.10", "0.1.4-beta.2", Ordering::Greater),
        ("0.1.4", "0.1.4-beta", Ordering::Greater),
        ("0.1.4.0", "0.1.4", Ordering::Equal),
        ("0.1.2", "0.1.3", Ordering::Less),
    ] {
        assert_eq!(compare_versions(left, right), expected);
    }
}
