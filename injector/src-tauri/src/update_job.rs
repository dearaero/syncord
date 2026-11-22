//! Verified update worker that survives Discord's exit. No resident service.
use fs2::FileExt;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};
use syncord_core::{
    discovery::Install,
    inject::{update, InjectOutcome},
    release::compare_versions,
    verify::{read_version_stamp, Verifier},
};

const WAIT_LIMIT: Duration = Duration::from_secs(15 * 60);

fn receipt(stage: &str, version: &str, phase: &str, detail: &str) {
    let Some(parent) = Path::new(stage).parent() else {
        return;
    };
    let data = serde_json::json!({"version": version, "phase": phase, "detail": detail});
    if let Ok(bytes) = serde_json::to_vec(&data) {
        let temp = parent.join(format!("update-result-{}.part", std::process::id()));
        if std::fs::write(&temp, bytes).is_ok() {
            let destination = parent.join("update-result.json");
            let _ = std::fs::remove_file(&destination);
            let _ = std::fs::rename(temp, destination);
        }
    }
}

fn restart_command(target: &Install) -> Result<std::process::Command, String> {
    if cfg!(target_os = "macos") {
        let app = target
            .resources
            .ancestors()
            .find(|p| p.extension().is_some_and(|v| v == "app"))
            .ok_or("Could not locate this Discord application's bundle.")?;
        let mut cmd = std::process::Command::new("/usr/bin/open");
        cmd.arg("-a").arg(app);
        return Ok(cmd);
    }
    let names: &[&str] = if cfg!(target_os = "windows") {
        &[
            "Discord.exe",
            "DiscordCanary.exe",
            "DiscordPTB.exe",
            "DiscordDevelopment.exe",
        ]
    } else {
        &["Discord", "DiscordCanary", "DiscordPTB", "discord"]
    };
    let directory = target
        .resources
        .parent()
        .ok_or("This Discord install has no application directory.")?;
    for name in names {
        let path = directory.join(name);
        if path.is_file()
            && std::fs::symlink_metadata(&path).is_ok_and(|m| !m.file_type().is_symlink())
        {
            return Ok(std::process::Command::new(path));
        }
    }
    Err(
        "The update was installed. Open Discord manually; its executable could not be located."
            .into(),
    )
}

// The OS releases this advisory lock even if a worker crashes. Never unlink it:
// another process could otherwise acquire a different inode for the same job.
fn lock_file(path: &Path) -> Result<std::fs::File, String> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Could not lock the Discord update. Check write permissions.")?;
    FileExt::try_lock_exclusive(&file).map_err(|_| {
        "Another update is already waiting for Discord to close or applying this install."
    })?;
    Ok(file)
}
fn lock_job(parent: &Path) -> Result<std::fs::File, String> {
    lock_file(&parent.join("update.lock"))
}
/// Serialize native workers and GUI writes even across different release folders.
pub(crate) fn lock_install(resources: &Path) -> Result<std::fs::File, String> {
    lock_file(&resources.join(".syncord-update.lock"))
}

pub(crate) fn wait_and_apply(stage: &str, branch: Option<&str>, restart: bool) -> i32 {
    let result = run(stage, branch, restart);
    match result {
        Ok(()) => 0,
        Err((version, message)) => {
            receipt(stage, &version, "failed", &message);
            let _ = writeln!(std::io::stdout(), "SYNCORD_UPDATE_ERROR:{message}");
            crate::EXIT_UPDATE_FAILED
        }
    }
}

fn run(stage: &str, branch: Option<&str>, restart: bool) -> Result<(), (String, String)> {
    let mut version = String::new();
    let work = (|| -> Result<(), String> {
        let target = crate::staged_target(branch)?;
        if !target.app_dir().is_dir() {
            return Err("Syncord is not installed. Open the Injector to install it first.".into());
        }
        let access = syncord_core::access::probe(
            &target.resources,
            syncord_core::discovery::Platform::current(),
        );
        if access.is_blocked() {
            return Err(syncord_core::access::remedy(
                access,
                syncord_core::discovery::Platform::current(),
            ));
        }
        let verifier = Verifier::embedded().map_err(|e| e.to_string())?;
        let parent = Path::new(stage)
            .parent()
            .ok_or("The staged release has no directory.")?;
        let _lock = lock_job(parent)?;
        let _install_lock = lock_install(&target.resources)?;
        let payload = crate::release_client::PreparedPayload::new()?;
        crate::extract_staged(stage, &payload.0, &verifier)?;
        version = read_version_stamp(&payload.0).ok_or("The verified payload has no version.")?;
        if syncord_core::inject::installed_version(&target.resources)
            .is_some_and(|current| compare_versions(&version, &current) == std::cmp::Ordering::Less)
        {
            return Err(
                "This update is older than the installed client. Downgrades are refused.".into(),
            );
        }
        // The acknowledgment promises only preparation, never installation.
        receipt(
            stage,
            &version,
            "waiting",
            "Close Discord completely to apply this verified update.",
        );
        let _ = writeln!(std::io::stdout(), "SYNCORD_UPDATE_READY:{version}");
        let _ = std::io::stdout().flush();
        let start = Instant::now();
        while crate::running_for(&target.root).is_some() {
            if start.elapsed() >= WAIT_LIMIT {
                return Err(
                    "Discord did not close within 15 minutes. Nothing was installed. Try again."
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        let outcome = if syncord_core::inject::launch_ready(&target.resources) {
            update(&target, &payload.0, &verifier)
        } else {
            syncord_core::inject::inject(&target, &payload.0, &verifier)
        }
        .map_err(|e| e.to_string())?;
        if !matches!(outcome, InjectOutcome::Updated | InjectOutcome::Replaced) {
            return Err("The update returned an unexpected result.".into());
        }
        verifier
            .verify_install(&target.app_dir())
            .map_err(|e| e.to_string())?;
        if !syncord_core::inject::launch_ready(&target.resources)
            || read_version_stamp(&target.app_dir()).as_deref() != Some(&version)
        {
            return Err("The installed version did not match the requested release.".into());
        }
        receipt(
            stage,
            &version,
            "installed",
            "The update was applied and verified.",
        );
        if restart {
            match restart_command(&target).and_then(|mut cmd| {
                cmd.stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map(|_| ())
                    .map_err(|_| "Open Discord manually; it could not be restarted.".into())
            }) {
                Ok(()) => {}
                Err(message) => receipt(stage, &version, "installed", &message),
            }
        }
        Ok(())
    })();
    work.map_err(|error| (version, error))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    #[test]
    fn different_releases_cannot_write_one_discord_at_the_same_time() {
        let install = crate::release_client::PreparedPayload::new().unwrap();
        let first = super::lock_install(&install.0).unwrap();
        assert!(super::lock_install(&install.0).is_err());
        drop(first);
        assert!(super::lock_install(&install.0).is_ok());
    }
    #[test]
    fn crashed_or_completed_jobs_do_not_leave_a_stale_lock() {
        let parent = crate::release_client::PreparedPayload::new().unwrap();
        let first = super::lock_job(&parent.0).unwrap();
        assert!(super::lock_job(&parent.0).is_err());
        drop(first);
        assert!(super::lock_job(&parent.0).is_ok());
        assert!(parent.0.join("update.lock").exists());
    }
}
