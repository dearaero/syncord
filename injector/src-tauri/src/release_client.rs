//! Native-only update transport (api.syncord.pro). No URL, header or key comes from the webview.
use reqwest::{blocking::Client, redirect::Policy, Url};
use std::io::Read;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;
use syncord_core::{
    archive::{extract_payload, ExtractionLimits},
    release::{self, VerifiedRelease},
    verify::{read_version_stamp, sha256_bytes, Verifier},
};

pub(crate) fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_multicast()
                && o[0] != 0
                && o[0] < 224
                && !(o[0] == 100 && (64..=127).contains(&o[1]))
                && !(o[0] == 192 && o[1] == 0)
                && !(o[0] == 192 && o[1] == 2)
                && !(o[0] == 198 && (o[1] == 18 || o[1] == 19 || o[1] == 51))
                && !(o[0] == 203 && o[1] == 0 && o[2] == 113)
        }
        IpAddr::V6(v) => v
            .to_ipv4_mapped()
            .map(public_address_v4)
            .unwrap_or_else(|| {
                let s = v.segments();
                s[0] & 0xe000 == 0x2000 && !(s[0] == 0x2001 && (s[1] == 0xdb8 || s[1] <= 0x1ff))
            }),
    }
}
fn public_address_v4(v: std::net::Ipv4Addr) -> bool {
    public_address(IpAddr::V4(v))
}

pub(crate) fn allowed_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.host_str() == Some(release::FEED_HOST)
}

fn get(url: &str, limit: u64, asset: bool) -> Result<Vec<u8>, String> {
    let mut current = Url::parse(url).map_err(|_| "The release address is invalid.")?;
    for _ in 0..=3 {
        if !allowed_url(&current) {
            return Err("The update server redirected the request to a forbidden address.".into());
        }
        let host = current.host_str().ok_or("The release host is absent.")?;
        let addresses: Vec<_> = (host, 443)
            .to_socket_addrs()
            .map_err(|_| "The update server could not be resolved.")?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_address(a.ip())) {
            return Err("The update server resolved to a private or reserved address.".into());
        }
        let client = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(Policy::none())
            .referer(false)
            .user_agent("Syncord-Injector/1")
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| "HTTPS could not be initialized.")?;
        let response = client
            .get(current.clone())
            .header(
                "Accept",
                if asset {
                    "application/octet-stream"
                } else {
                    "application/json"
                },
            )
            .send()
            .map_err(|_| {
                "The update server could not be reached. Check your connection and try again."
            })?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("The update server returned a redirect with no address.")?;
            current = current
                .join(location)
                .map_err(|_| "The update server returned an invalid redirect.")?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "The update server returned HTTP {}. Try again later.",
                response.status().as_u16()
            ));
        }
        if response.content_length().is_some_and(|n| n > limit) {
            return Err("The update server response exceeds its size limit.".into());
        }
        let mut bytes = Vec::new();
        response
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "The download was interrupted.")?;
        if bytes.len() as u64 > limit {
            return Err("The update server response exceeds its size limit.".into());
        }
        return Ok(bytes);
    }
    Err("The update server redirected too many times.".into())
}

pub(crate) fn latest(verifier: &Verifier) -> Result<VerifiedRelease, String> {
    let bytes = get(&release::feed_url(), release::MAX_DESCRIPTOR_BYTES, false)?;
    release::verify_release(&bytes, verifier, &release::current_platform())
}

#[derive(Debug)]
pub(crate) struct PreparedPayload(pub PathBuf);
impl PreparedPayload {
    pub(crate) fn new() -> Result<Self, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "The system clock is invalid.")?
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("syncord-payload-{}-{nanos}", std::process::id()));
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = builder;
            builder.mode(0o700);
            builder
        };
        builder
            .create(&dir)
            .map_err(|_| "Could not create a private staging directory.")?;
        Ok(Self(dir))
    }
}
impl Drop for PreparedPayload {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn prepare(
    bytes: &[u8],
    release: &VerifiedRelease,
    verifier: &Verifier,
    dir: &Path,
) -> Result<(), String> {
    if bytes.len() as u64 != release.asset.size || sha256_bytes(bytes) != release.asset.sha256 {
        return Err("The downloaded archive does not match its signed checksum.".into());
    }
    extract_payload(bytes, dir, &ExtractionLimits::default())
        .map_err(|e| format!("The update archive was rejected: {e}"))?;
    verifier
        .verify_install(dir)
        .map_err(|e| format!("The update payload was rejected: {e}"))?;
    if read_version_stamp(dir).as_deref() != Some(&release.version) {
        return Err("The payload version does not match its signed release.".into());
    }
    Ok(())
}

pub(crate) fn download(
    release: &VerifiedRelease,
    verifier: &Verifier,
) -> Result<PreparedPayload, String> {
    let payload = PreparedPayload::new()?;
    let bytes = get(&release.download_url(), release.asset.size, true)?;
    prepare(&bytes, release, verifier, &payload.0)?;
    Ok(payload)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    #[test]
    fn update_transport_does_not_accept_local_or_unrelated_destinations() {
        for url in [
            "http://api.syncord.pro/a",
            "https://api.syncord.pro:444/a",
            "https://user:pass@api.syncord.pro/a",
            "https://api.syncord.pro.evil.test/a",
            "https://127.0.0.1/a",
            "https://api.github.com/a",
            "https://github.com/a",
            "https://objects.githubusercontent.com/a",
        ] {
            assert!(
                !super::allowed_url(&reqwest::Url::parse(url).unwrap()),
                "{url}"
            );
        }
        assert!(super::allowed_url(
            &reqwest::Url::parse("https://api.syncord.pro/v1/update/stable").unwrap()
        ));
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "192.0.2.1",
            "::1",
            "::ffff:127.0.0.1",
            "fd00::1",
            "2001:db8::1",
        ] {
            assert!(!super::public_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["140.82.113.5", "2606:50c0:8000::154"] {
            assert!(super::public_address(ip.parse().unwrap()), "{ip}");
        }
    }
}
