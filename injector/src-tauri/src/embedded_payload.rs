//! A release can carry its signed client archive inside the executable.
//! Extraction uses the same allowlist/limits as updates; embedding grants no trust.

use crate::release_client::PreparedPayload;
use syncord_core::archive::{extract_payload, ExtractionLimits};
use syncord_core::verify::{read_version_stamp, Verifier};

include!(concat!(env!("OUT_DIR"), "/embedded_payload.rs"));

pub(crate) fn load(verifier: Option<&Verifier>) -> Result<Option<PreparedPayload>, String> {
    ARCHIVE.map(|bytes| prepare(bytes, verifier)).transpose()
}

pub(crate) fn prepare(
    bytes: &[u8],
    verifier: Option<&Verifier>,
) -> Result<PreparedPayload, String> {
    let verifier = verifier.ok_or("The bundled payload has no trusted verification key.")?;
    let staging = PreparedPayload::new()?;
    extract_payload(bytes, &staging.0, &ExtractionLimits::default())
        .map_err(|e| format!("The embedded archive was rejected: {e}"))?;
    verifier
        .verify_install(&staging.0)
        .map_err(|e| format!("The embedded payload was rejected: {e}"))?;
    if read_version_stamp(&staging.0).is_none() {
        return Err("The embedded payload has no valid version.".into());
    }
    Ok(staging)
}
