//! In-app updates. Android downloads, verifies and installs a release APK in
//! the app's plugin (`AppUpdater.kt`); other platforms have no in-app update.

#[cfg(not(target_os = "android"))]
const UNSUPPORTED: &str = "in-app updates are available on Android only";

/// The newest stable release and preview on GitHub, and the installed version.
#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        crate::mobile_vpn::check_app_update(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

/// Start downloading, verifying and installing the release `tag`.
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle, tag: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::mobile_vpn::install_app_update(&app, tag)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, tag);
        Err(UNSUPPORTED.into())
    }
}

/// How the update started by `install_app_update` is going.
#[tauri::command]
pub async fn app_update_progress(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        crate::mobile_vpn::app_update_progress(&app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}
