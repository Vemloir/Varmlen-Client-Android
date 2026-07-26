//! Enumerate installed desktop applications (Linux) by parsing the standard
//! `.desktop` entries, so the split-tunnel UI can offer a real app list like
//! AdGuard VPN does. Apps not found here can still be added by file path.
//!
//! Each app's icon is resolved from the icon theme dirs and returned inline as
//! a data URI, so the webview can render it without extra asset permissions.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct InstalledApp {
    /// Process / binary name used to match the running app (e.g. "firefox").
    pub id: String,
    /// Human-readable name from the desktop entry (e.g. "Firefox").
    pub name: String,
    /// Icon as a data URI (`data:image/...`), or null when none was found.
    pub icon: Option<String>,
}

fn desktop_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/share/applications"));
        dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_DIRS") {
        for part in xdg.to_string_lossy().split(':') {
            if !part.is_empty() {
                dirs.push(Path::new(part).join("applications"));
            }
        }
    }
    dirs
}

fn icon_theme_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/usr/share/icons"),
        PathBuf::from("/usr/local/share/icons"),
        PathBuf::from("/var/lib/flatpak/exports/share/icons"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.push(home.join(".local/share/icons"));
        roots.push(home.join(".icons"));
        roots.push(home.join(".local/share/flatpak/exports/share/icons"));
    }
    roots
}

/// Strip a desktop `Exec=` value down to the binary name: drop field codes
/// (%U, %f, …), arguments, env wrappers, and any directory path.
fn binary_from_exec(exec: &str) -> Option<String> {
    for token in exec.split_whitespace() {
        if token.starts_with('%') {
            continue;
        }
        if token == "env" || token.contains('=') {
            continue;
        }
        let name = Path::new(token).file_name()?.to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        return Some(name);
    }
    None
}

/// Launchers that front many different apps — their binary name is useless as
/// an identifier because every entry would collapse to the same value.
const LAUNCHERS: &[&str] = &[
    "steam",
    "flatpak",
    "snap",
    "wine",
    "lutris",
    "gamescope",
    "heroic",
    "env",
    "sh",
    "bash",
    "python",
    "python3",
    "java",
    "mono",
    "dotnet",
];

/// A stable, unique identifier for an app — ideally the real process name that
/// xray's `process` routing matcher matches. Normally the binary; for
/// launcher-fronted entries (Steam → "steam", Flatpak → "flatpak") we resolve
/// the actual process: Flatpak via its install metadata / launch wrapper, else
/// fall back to a unique id.
fn derive_app_id(exec: &str, desktop_stem: &str) -> String {
    let bin = binary_from_exec(exec).unwrap_or_else(|| desktop_stem.to_string());
    if !LAUNCHERS.contains(&bin.as_str()) {
        return bin;
    }
    if bin == "flatpak" {
        if let Some(appid) = exec
            .split_whitespace()
            .find(|t| !t.starts_with('-') && !t.starts_with('%') && t.matches('.').count() >= 2)
        {
            // The real process (e.g. "zen") — what xray's process matcher
            // matches — not the reverse-DNS app id.
            return flatpak_process_name(appid).unwrap_or_else(|| appid.to_string());
        }
    }
    // Steam games etc. have no statically-knowable process name → unique stem
    // (the user can refine via "Choose from file" → the game binary).
    desktop_stem.to_string()
}

fn flatpak_app_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/var/lib/flatpak/app")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/flatpak/app"));
    }
    dirs
}

/// Resolve a Flatpak app-id to the real process name. Reads `command` from the
/// install metadata; when that's a wrapper script, parses its `exec …` line for
/// the actual binary (e.g. zen's `launch-script.sh` → `/app/zen/zen` → "zen").
fn flatpak_process_name(app_id: &str) -> Option<String> {
    let basename = |s: &str| {
        Path::new(s)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
    };
    for base in flatpak_app_dirs() {
        let active = base.join(app_id).join("current/active");
        let Ok(meta) = fs::read_to_string(active.join("metadata")) else {
            continue;
        };
        let Some(command) = meta
            .lines()
            .find_map(|l| l.strip_prefix("command="))
            .map(|c| c.trim().to_string())
        else {
            continue;
        };
        // A wrapper script (#!…) usually `exec`s the real binary.
        if let Ok(script) = fs::read_to_string(active.join("files/bin").join(&command)) {
            if script.starts_with("#!") {
                if let Some(real) = script
                    .lines()
                    .find(|l| l.trim_start().starts_with("exec "))
                    .and_then(|l| l.split_whitespace().skip(1).find(|t| t.starts_with('/')))
                    .and_then(basename)
                {
                    return Some(real);
                }
            }
        }
        return basename(&command);
    }
    None
}

fn read_icon_data_uri(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => return None,
    };
    let bytes = fs::read(path).ok()?;
    // Guard against pathological icons bloating the payload.
    if bytes.len() > 512 * 1024 {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// Score an icon file path so the index keeps the best variant per name:
/// scalable SVG wins, then PNGs by pixel size, then anything else.
fn icon_score(path: &Path) -> i32 {
    let s = path.to_string_lossy();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "svg" {
        return 100_000; // vector scales to any size
    }
    if ext == "png" {
        // Pull a size like "128x128" out of the path; cap so 512 > 1024 isn't
        // pursued (huge icons get rejected on read anyway). Default mid-size.
        if let Some(sz) = s
            .split(['/', '-'])
            .filter_map(|seg| seg.split_once('x'))
            .filter_map(|(a, b)| {
                let a: i32 = a.parse().ok()?;
                let b: i32 = b.parse().ok()?;
                (a == b).then_some(a)
            })
            .max()
        {
            return sz.min(512);
        }
        return 64;
    }
    if ext == "xpm" {
        return 1;
    }
    0
}

/// Walk all icon directories once and index every PNG/SVG by file stem,
/// keeping the highest-scoring variant. Far more reliable than probing a
/// fixed set of theme/size paths, which misses non-standard layouts.
fn build_icon_index() -> HashMap<String, PathBuf> {
    let mut index: HashMap<String, (PathBuf, i32)> = HashMap::new();
    let mut stack: Vec<PathBuf> = icon_theme_roots();
    stack.push(PathBuf::from("/usr/share/pixmaps"));

    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        visited += 1;
        if visited > 6000 {
            break; // safety bound against pathological trees
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ext != "png" && ext != "svg" && ext != "xpm" {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let score = icon_score(&path);
            match index.get(stem) {
                Some((_, best)) if *best >= score => {}
                _ => {
                    index.insert(stem.to_string(), (path, score));
                }
            }
        }
    }
    index.into_iter().map(|(k, (p, _))| (k, p)).collect()
}

/// Resolve a desktop `Icon=` value to an icon data URI using the prebuilt
/// index. Handles absolute paths and theme icon names (with or without a
/// trailing extension).
fn resolve_icon(icon: &str, index: &HashMap<String, PathBuf>) -> Option<String> {
    let direct = Path::new(icon);
    if direct.is_absolute() && direct.is_file() {
        return read_icon_data_uri(direct);
    }
    // Icon= is usually a bare name, but may include an extension.
    let stem = Path::new(icon)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(icon);
    let path = index.get(stem).or_else(|| index.get(icon))?;
    read_icon_data_uri(path)
}

fn parse_desktop_entry(path: &Path, icon_index: &HashMap<String, PathBuf>) -> Option<InstalledApp> {
    let text = fs::read_to_string(path).ok()?;
    let mut in_entry = false;
    let mut name: Option<String> = None;
    let mut exec: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut no_display = false;
    let mut is_app = true;

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            name.get_or_insert_with(|| v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Exec=") {
            exec.get_or_insert_with(|| v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Icon=") {
            icon.get_or_insert_with(|| v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("NoDisplay=") {
            no_display = v.trim().eq_ignore_ascii_case("true");
        } else if let Some(v) = line.strip_prefix("Type=") {
            is_app = v.trim().eq_ignore_ascii_case("application");
        }
    }

    if no_display || !is_app {
        return None;
    }
    let exec = exec?;
    // Skip Steam game shortcuts: they launch via `steam://rungameid/<id>`, so
    // there's no derivable process name and the entry would never match. Such
    // games are added via "Choose from file" → the game binary instead.
    if exec.contains("steam://rungameid/") {
        return None;
    }
    let name = name?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let id = derive_app_id(&exec, stem);
    let icon = icon.and_then(|i| resolve_icon(&i, icon_index));
    Some(InstalledApp { id, name, icon })
}

/// Turn a user-picked file into an app entry. A `.desktop` file is parsed for
/// its name / exec / icon (leniently — no NoDisplay/Type filtering, since the
/// user chose it explicitly); any other file is treated as the binary itself.
#[tauri::command]
pub fn app_from_file(path: String) -> Option<InstalledApp> {
    let p = Path::new(&path);
    let is_desktop = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("desktop"))
        .unwrap_or(false);

    if is_desktop {
        let text = fs::read_to_string(p).ok()?;
        let mut in_entry = false;
        let (mut name, mut exec, mut icon) = (None, None, None);
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
                continue;
            }
            if !in_entry {
                continue;
            }
            if let Some(v) = line.strip_prefix("Name=") {
                name.get_or_insert_with(|| v.trim().to_string());
            } else if let Some(v) = line.strip_prefix("Exec=") {
                exec.get_or_insert_with(|| v.trim().to_string());
            } else if let Some(v) = line.strip_prefix("Icon=") {
                icon.get_or_insert_with(|| v.trim().to_string());
            }
        }
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let id = match &exec {
            Some(e) => derive_app_id(e, &stem),
            None => stem.clone(),
        };
        let display = name.unwrap_or_else(|| id.clone());
        let index = build_icon_index();
        let icon = icon.and_then(|i| resolve_icon(&i, &index));
        return Some(InstalledApp {
            id,
            name: display,
            icon,
        });
    }

    let base = p.file_name()?.to_string_lossy().to_string();
    Some(InstalledApp {
        id: base.clone(),
        name: base,
        icon: None,
    })
}

/// Open the system file picker (via the XDG desktop portal → the DE's native
/// file manager dialog, with search) and return the chosen path, or null.
#[tauri::command]
pub async fn pick_file() -> Option<String> {
    // Desktop: the XDG-portal file picker. Android picks apps a different way
    // (system package list), so this is a no-op there.
    #[cfg(desktop)]
    {
        let mut dialog = rfd::AsyncFileDialog::new().set_title("Select an application");
        if let Some(home) = std::env::var_os("HOME") {
            dialog = dialog.set_directory(home);
        }
        dialog
            .pick_file()
            .await
            .map(|f| f.path().to_string_lossy().to_string())
    }
    #[cfg(not(desktop))]
    None
}

/// Installed apps for the split-tunnel picker. Desktop: parsed `.desktop`
/// entries (id = binary name). Android: the launchable packages from
/// PackageManager (id = package name).
#[tauri::command]
pub async fn list_installed_apps(app: tauri::AppHandle) -> Vec<InstalledApp> {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::list_apps(&app).unwrap_or_default();
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        list_desktop_apps()
    }
}

#[cfg(not(target_os = "android"))]
fn list_desktop_apps() -> Vec<InstalledApp> {
    let icon_index = build_icon_index();
    let mut by_id: BTreeMap<String, InstalledApp> = BTreeMap::new();
    for dir in desktop_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            if let Some(app) = parse_desktop_entry(&path, &icon_index) {
                by_id.entry(app.id.clone()).or_insert(app);
            }
        }
    }
    let mut apps: Vec<InstalledApp> = by_id.into_values().collect();
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps
}
