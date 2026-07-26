//! System tray + native Linux autostart (desktop), with cross-platform command
//! stubs so the shared frontend can call the same commands on Android.
//!
//! The tray keeps Varmlen running with no window: closing the window hides it
//! here (the VPN stays up), and Quit — the only path that tears the tunnel
//! down — lives in the tray menu. Autostart is a `~/.config/autostart` entry we
//! write/remove ourselves. None of this applies on Android, where the OS owns
//! the activity lifecycle and the VPN runs as a foreground service.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::AppHandle;

#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::time::Duration;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::{Emitter, Manager};

// --- system tray (desktop only) --------------------------------------------

/// Build the tray icon + menu. Left-click shows the window; the menu has the
/// connect/disconnect toggle, Open, and Quit.
#[cfg(desktop)]
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Connect / Disconnect", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Open Varmlen", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &sep, &show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Varmlen")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                let _ = app.emit("tray://toggle", ());
            }
            "show" => show_main(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Show + focus the main window (from the tray).
#[cfg(desktop)]
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Tear the tunnel down, then exit. The only clean way out of the app.
#[cfg(desktop)]
pub(crate) fn quit_app(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::vpn::vpn_disconnect(app.clone()).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        app.exit(0);
    });
}

/// True when launched from the autostart entry's `--minimized` exec.
#[cfg(desktop)]
pub fn launched_minimized() -> bool {
    std::env::args().any(|a| a == "--minimized")
}

// --- close-to-tray preference (shared) -------------------------------------

/// Whether closing the window hides to the tray (true) or fully quits (false).
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

#[cfg(desktop)]
pub fn close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

/// Reflect the connection status in the tray tooltip (desktop); no-op on mobile.
#[tauri::command]
pub fn set_tray_status(app: AppHandle, status_label: String) {
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Varmlen — {status_label}")));
    }
    #[cfg(not(desktop))]
    let _ = (app, status_label);
}

// --- native Linux autostart (desktop) / mobile stubs -----------------------

#[derive(Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
    pub minimized: bool,
}

#[cfg(desktop)]
fn autostart_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("autostart").join("varmlen.desktop"))
}

#[tauri::command]
pub fn autostart_status() -> AutostartStatus {
    #[cfg(desktop)]
    {
        match autostart_path().and_then(|p| std::fs::read_to_string(p).ok()) {
            Some(c) => AutostartStatus {
                enabled: true,
                minimized: c.contains("--minimized"),
            },
            None => AutostartStatus {
                enabled: false,
                minimized: false,
            },
        }
    }
    #[cfg(not(desktop))]
    AutostartStatus {
        enabled: false,
        minimized: false,
    }
}

#[tauri::command]
pub fn set_autostart(enabled: bool, minimized: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let path = autostart_path().ok_or("no config dir")?;
        if !enabled {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
        let exec = if minimized {
            format!("{} --minimized", exe.display())
        } else {
            exe.display().to_string()
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("autostart dir: {e}"))?;
        }
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=Varmlen\nGenericName=VPN Client\nIcon=varmlen\nExec={exec}\nTerminal=false\nCategories=Network;Security;\nX-GNOME-Autostart-enabled=true\n"
        );
        std::fs::write(&path, entry).map_err(|e| format!("write autostart: {e}"))?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (enabled, minimized);
        Ok(())
    }
}
