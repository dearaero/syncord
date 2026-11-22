//! Build the application manifest and Windows icon with one resource compiler.
//!
//! Tauri reads Cargo's target triple, so this also embeds the icon when Windows
//! is compiled on Linux or macOS. A separate embed-resource invocation would
//! link the same icon IDs twice and make lld-link reject the executable.

use std::env;
use std::path::PathBuf;

fn main() {
    embed_payload();
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| panic!("CARGO_MANIFEST_DIR is not set")),
    );
    let icon = manifest_dir.join("icons").join("icon.ico");
    if !icon.is_file() {
        panic!(
            "the Windows icon is missing: {}. Regenerate it with node injector/scripts/make-icons.mjs",
            icon.display(),
        );
    }
    println!("cargo:rerun-if-changed={}", icon.display());
    println!("cargo:rerun-if-changed=build.rs");

    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new().window_icon_path(&icon));
    tauri_build::try_build(attributes)
        .unwrap_or_else(|err| panic!("could not build the application resources: {err}"));
}

fn embed_payload() {
    println!("cargo:rerun-if-env-changed=SYNCORD_BUNDLED_PAYLOAD_ARCHIVE");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap_or_else(|| panic!("OUT_DIR is not set")));
    let source = match env::var_os("SYNCORD_BUNDLED_PAYLOAD_ARCHIVE") {
        Some(path) => {
            let path = std::fs::canonicalize(path)
                .unwrap_or_else(|err| panic!("cannot locate bundled payload: {err}"));
            println!("cargo:rerun-if-changed={}", path.display());
            let metadata = std::fs::symlink_metadata(&path)
                .unwrap_or_else(|err| panic!("cannot inspect bundled payload: {err}"));
            if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 {
                panic!("bundled payload must be a regular archive smaller than 32 MiB");
            }
            std::fs::copy(&path, out.join("syncord-payload.tar.gz"))
                .unwrap_or_else(|err| panic!("cannot embed bundled payload: {err}"));
            "pub const ARCHIVE: Option<&[u8]> = Some(include_bytes!(concat!(env!(\"OUT_DIR\"), \"/syncord-payload.tar.gz\")));"
        }
        None => "pub const ARCHIVE: Option<&[u8]> = None;",
    };
    std::fs::write(out.join("embedded_payload.rs"), source)
        .unwrap_or_else(|err| panic!("cannot write bundled payload configuration: {err}"));
}
