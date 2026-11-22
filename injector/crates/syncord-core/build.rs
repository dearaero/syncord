//! Compile-time configuration.
//!
//! The release public key is baked into the binary at build time, mirroring what
//! `scripts/build.mjs` does for the Electron bundle. Embedding it is the point:
//! an update is verified against a key that is part of the program, not one that
//! arrived with the update.
//!
//! A build without `SYNCORD_INTEGRITY_KEY` gets the same placeholder the
//! TypeScript build uses. That placeholder cannot verify anything signed by a
//! real key, so such a build **fails closed** — every update is refused —
//! rather than skipping the check. "We could not check" must never be
//! indistinguishable from "we checked and it was fine".

use std::env;

/// Same shape as `EMBEDDED_PUBLIC_KEY` in `src/main/security/integrity.ts`.
/// If one of these changes, the other must change with it.
const PLACEHOLDER_PUBLIC_KEY: &str = "sOOl0replacethiswitharealEd25519publickeybase64value0=";

fn main() {
    // Only ever the build environment or the placeholder. A test build does
    // *not* get a real key here: the crate's tests construct their own
    // `Verifier` through a `pub(crate)` constructor, and having `embedded()`
    // silently return a test key in test builds would be a genuinely dangerous
    // convenience — it is exactly the kind of thing that ends up shipped.
    let key = env::var("SYNCORD_INTEGRITY_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| PLACEHOLDER_PUBLIC_KEY.to_string());

    println!("cargo:rustc-env=SYNCORD_INTEGRITY_KEY={key}");
    println!("cargo:rerun-if-env-changed=SYNCORD_INTEGRITY_KEY");
}
