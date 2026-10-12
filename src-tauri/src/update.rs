//! Updates of the application itself: the installed copy reads `latest.json`
//! from the latest GitHub release, downloads the installer signed for it
//! (the signature is checked against the public key of `tauri.conf.json`),
//! installs it and starts again.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;
use tauri_specta::Event;

use crate::error::{AppError, Result};

/// How much of the update is downloaded; the installation follows.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// `None` when the server did not say how large the download is.
    pub percent: Option<u8>,
}

/// The version of the latest release when it is newer than the running one.
#[tauri::command]
#[specta::specta]
pub async fn update_check(app: AppHandle) -> Result<Option<String>> {
    let update = app.updater()?.check().await?;
    Ok(update.map(|update| update.version))
}

/// Downloads the latest release, installs it and restarts the application.
/// Only returns when that failed.
#[tauri::command]
#[specta::specta]
pub async fn update_install(app: AppHandle) -> Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Err(AppError::Update(
            "the application is already up to date".to_owned(),
        ));
    };

    let mut downloaded = 0u64;
    let mut reported = None;
    let _ = UpdateProgress { percent: None }.emit(&app);
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let percent = total
                    .filter(|total| *total > 0)
                    .map(|total| (downloaded.saturating_mul(100) / total).min(100) as u8);
                // One event per percent, not one per chunk.
                if percent != reported {
                    reported = percent;
                    let _ = UpdateProgress { percent }.emit(&app);
                }
            },
            || {},
        )
        .await?;

    // On Windows the installer has already closed the application and starts
    // it again itself; elsewhere the new version replaces this process.
    app.restart()
}
