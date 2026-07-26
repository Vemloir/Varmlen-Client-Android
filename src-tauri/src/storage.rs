//! One-time migration of localStorage data from a previous (dev) origin to the
//! current one. Tauri's release build uses a different origin than the dev
//! server (`http://localhost` vs `http://127.0.0.1:1420`), so WebKit keeps a
//! separate localStorage and the user's subscriptions / settings would appear
//! lost. The frontend, on first launch in the new origin, asks for the legacy
//! data via this command and seeds its own localStorage from it.

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::Manager;

/// Read every `(key, value)` row from a WebKit localStorage sqlite file. The
/// value is stored as UTF-16LE bytes; decode to UTF-8.
fn dump_storage(path: &PathBuf) -> Result<HashMap<String, String>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM ItemTable")
        .map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let k: String = r.get(0)?;
            let v: Vec<u8> = r.get(1)?;
            Ok((k, v))
        })
        .map_err(|e| format!("query: {e}"))?;
    let mut out = HashMap::new();
    for row in rows {
        let (k, bytes) = row.map_err(|e| format!("row: {e}"))?;
        let utf16: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        if let Ok(s) = String::from_utf16(&utf16) {
            out.insert(k, s);
        }
    }
    Ok(out)
}

/// Merge localStorage from any prior dev origins (newest file wins). Returns
/// an empty map if no legacy files exist — that's a normal first install.
#[tauri::command]
pub fn read_legacy_storage(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let ls_dir = data_dir.join("localstorage");
    let mut paths: Vec<PathBuf> = [
        "http_127.0.0.1_1420.localstorage",
        "http_localhost_1420.localstorage",
    ]
    .iter()
    .map(|n| ls_dir.join(n))
    .filter(|p| p.exists())
    .collect();
    // Read oldest first so the newest file's values overwrite via insert.
    paths.sort_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
    let mut merged = HashMap::new();
    for p in &paths {
        match dump_storage(p) {
            Ok(map) => {
                for (k, v) in map {
                    merged.insert(k, v);
                }
            }
            Err(e) => eprintln!("storage: skipping {}: {e}", p.display()),
        }
    }
    Ok(merged)
}
