//! VPN core management for the xray core (native TUN + routing + transport).
//!
//! Versions are cached per-kind under
//! `app_data/core/versions/<kind>/<tag>/<bin>` and `core/active-<kind>.txt`
//! records which one is active for that kind. The user keeps as many versions
//! as they want and activates one with a single click.
//!
//! Downloads stream chunks + emit `core://progress` events so the UI can render
//! a real progress bar. xray assets are `.zip`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Which core a request targets. xray is now the sole core: its native tun does
/// TUN capture, its routing does the per-app/site split + DNS, and its outbound
/// does the vless/reality/xhttp transport. The enum is kept (single variant) so
/// another downloadable core can be added later
/// without reworking the download/activate plumbing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreKind {
    Xray,
}

impl CoreKind {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "xray" => Ok(CoreKind::Xray),
            other => Err(format!("unknown core kind: {other}")),
        }
    }
    /// Stable slug used in paths / active-file names.
    fn slug(self) -> &'static str {
        "xray"
    }
    fn repo(self) -> &'static str {
        "XTLS/Xray-core"
    }
    /// Binary file name inside the per-version dir.
    pub fn bin_name(self) -> &'static str {
        if cfg!(windows) {
            "xray.exe"
        } else {
            "xray"
        }
    }
    fn active_file(self) -> String {
        format!("active-{}.txt", self.slug())
    }
}

#[derive(Serialize, Clone)]
pub struct InstalledVersion {
    pub tag: String,
    pub active: bool,
}

#[derive(Serialize)]
pub struct CoreInfo {
    pub installed: Vec<InstalledVersion>,
    pub active: Option<String>,
    pub latest: Option<String>,
    pub has_update: bool,
}

#[derive(Serialize, Clone)]
pub struct CoreProgress {
    pub tag: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
}

// --- paths -----------------------------------------------------------------

fn core_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("core");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create core dir: {e}"))?;
    Ok(dir)
}

fn versions_dir(app: &AppHandle, kind: CoreKind) -> Result<PathBuf, String> {
    let d = core_dir(app)?.join("versions").join(kind.slug());
    std::fs::create_dir_all(&d).map_err(|e| format!("create versions dir: {e}"))?;
    Ok(d)
}

/// Where the binary for a specific tag lives (may not exist yet).
fn version_binary(app: &AppHandle, kind: CoreKind, tag: &str) -> Result<PathBuf, String> {
    if !valid_tag(tag) {
        return Err(format!("invalid version tag: {tag}"));
    }
    Ok(versions_dir(app, kind)?
        .join(strip_v(tag))
        .join(kind.bin_name()))
}

fn strip_v(tag: &str) -> &str {
    tag.strip_prefix('v').unwrap_or(tag)
}

/// A tag is only ever used as a path component (`versions/<tag>/…`), so reject
/// anything that could escape that dir: version-ish chars only — no `/`, `\`,
/// no `.`/`..` component, not absolute, bounded length. Untrusted (it comes
/// from the GitHub API / the frontend), so validate before any path use.
fn valid_tag(tag: &str) -> bool {
    let t = strip_v(tag);
    !t.is_empty()
        && t.len() <= 64
        && t != "."
        && t != ".."
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+' | b'_'))
}

/// The active version's binary path for a kind; errors if none active/missing.
/// The xray binary shipped as a Tauri resource (None if absent, e.g. in some
/// dev runs). Bundled so the app has a working core on first launch without
/// reaching GitHub — vital in censored networks where the download is blocked.
fn bundled_core_path(app: &AppHandle, kind: CoreKind) -> Option<PathBuf> {
    if kind != CoreKind::Xray {
        return None;
    }
    let p = app.path().resource_dir().ok()?.join("xray");
    p.exists().then_some(p)
}

/// Read a core binary's own version (`xray version` → "26.6.27"), so the seeded
/// version dir is named correctly without a hardcoded tag to keep in sync.
fn core_version_of(bin: &PathBuf) -> Option<String> {
    let out = std::process::Command::new(bin)
        .arg("version")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // First line: "Xray 26.6.27 (Xray, Penetrates Everything.) <hash> ..."
    text.lines()
        .next()?
        .split_whitespace()
        .nth(1)
        .map(|s| s.to_string())
}

/// Seed the bundled core into the versions dir if NOTHING is installed yet, so
/// the app works offline on first launch. Idempotent + best-effort: a no-op
/// when a usable core already exists or no bundled binary is present. The
/// seeded binary still gets its caps via the normal grant flow.
pub fn seed_bundled_core(app: &AppHandle) {
    let kind = CoreKind::Xray;
    if binary_path(app, kind).is_ok() {
        return; // already have a usable, active core
    }
    let Some(src) = bundled_core_path(app, kind) else {
        return;
    };
    let Some(tag) = core_version_of(&src).filter(|t| valid_tag(t)) else {
        return;
    };
    let Ok(dest) = version_binary(app, kind, &tag) else {
        return;
    };
    if let Some(parent) = dest.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if std::fs::copy(&src, &dest).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }
    let _ = write_active(app, kind, &tag);
}

pub fn binary_path(app: &AppHandle, kind: CoreKind) -> Result<PathBuf, String> {
    let active = active_tag(app, kind)
        .ok_or_else(|| format!("no {} core installed (Settings → VPN core)", kind.slug()))?;
    let bin = version_binary(app, kind, &active)?;
    if !bin.exists() {
        return Err(format!(
            "active {} version {active} is missing on disk — pick another in Settings",
            kind.slug()
        ));
    }
    Ok(bin)
}

/// Tag currently selected as active for a kind.
pub fn active_tag(app: &AppHandle, kind: CoreKind) -> Option<String> {
    let dir = core_dir(app).ok()?;
    let v = std::fs::read_to_string(dir.join(kind.active_file())).ok()?;
    let v = v.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn write_active(app: &AppHandle, kind: CoreKind, tag: &str) -> Result<(), String> {
    let dir = core_dir(app)?;
    std::fs::write(dir.join(kind.active_file()), strip_v(tag))
        .map_err(|e| format!("write active file: {e}"))
}

fn clear_active(app: &AppHandle, kind: CoreKind) -> Result<(), String> {
    let dir = core_dir(app)?;
    let p = dir.join(kind.active_file());
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| format!("remove active file: {e}"))?;
    }
    Ok(())
}

/// One-time cleanup of stale sing-box artifacts from the dual-core era. xray is
/// now the sole core, so any cached sing-box binary/active-file is dead weight.
/// Idempotent: a no-op once cleaned.
fn migrate_legacy_layout(app: &AppHandle) {
    let Ok(dir) = core_dir(app) else { return };
    for f in [
        "sing-box",
        "version.txt",
        "active.txt",
        "active-singbox.txt",
    ] {
        let _ = std::fs::remove_file(dir.join(f));
    }
    let _ = std::fs::remove_dir_all(dir.join("versions").join("singbox"));
}

/// All tags with a binary on disk for a kind, newest-first.
fn installed_tags(app: &AppHandle, kind: CoreKind) -> Vec<String> {
    migrate_legacy_layout(app);
    let Ok(dir) = versions_dir(app, kind) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut tags: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().join(kind.bin_name()).exists() {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    tags.sort_by(|a, b| version_cmp(b, a));
    tags
}

fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |s: &str| -> Vec<u32> {
        strip_v(s)
            .split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .filter_map(|p| p.parse::<u32>().ok())
            .collect()
    };
    parts(a).cmp(&parts(b))
}

// --- GitHub API ------------------------------------------------------------

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Varmlen/0.1 (core-updater)")
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

async fn fetch_latest_release(kind: CoreKind) -> Result<serde_json::Value, String> {
    let client = http_client()?;
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        kind.repo()
    );
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("release request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API HTTP {}", resp.status()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("release body: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("release json: {e}"))
}

async fn fetch_release_by_tag(kind: CoreKind, tag: &str) -> Result<serde_json::Value, String> {
    let client = http_client()?;
    let tag = if tag.starts_with('v') {
        tag.to_string()
    } else {
        format!("v{tag}")
    };
    let url = format!(
        "https://api.github.com/repos/{}/releases/tags/{tag}",
        kind.repo()
    );
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("release request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API HTTP {}", resp.status()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("release body: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("release json: {e}"))
}

fn version_from_tag(release: &serde_json::Value) -> Option<String> {
    release
        .get("tag_name")
        .and_then(|t| t.as_str())
        .filter(|t| valid_tag(t))
        .map(|t| strip_v(t).to_string())
}

async fn latest_version(kind: CoreKind) -> Result<String, String> {
    let release = fetch_latest_release(kind).await?;
    version_from_tag(&release).ok_or_else(|| "no tag_name in release".to_string())
}

#[derive(Serialize)]
pub struct CoreRelease {
    pub tag: String,
    pub name: String,
    pub date: Option<String>,
    pub prerelease: bool,
}

#[tauri::command]
pub async fn list_core_releases(kind: String) -> Result<Vec<CoreRelease>, String> {
    let kind = CoreKind::parse(&kind)?;
    let client = http_client()?;
    let url = format!(
        "https://api.github.com/repos/{}/releases?per_page=30",
        kind.repo()
    );
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("releases request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API HTTP {}", resp.status()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| format!("releases body: {e}"))?;
    let arr: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("releases json: {e}"))?;
    Ok(arr
        .as_array()
        .ok_or("releases not an array")?
        .iter()
        .filter_map(|r| {
            let tag = r.get("tag_name")?.as_str()?.to_string();
            let name = r
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| tag.clone());
            let date = r
                .get("published_at")
                .and_then(|d| d.as_str())
                .map(|s| s.to_string());
            let prerelease = r
                .get("prerelease")
                .and_then(|p| p.as_bool())
                .unwrap_or(false);
            Some(CoreRelease {
                tag,
                name,
                date,
                prerelease,
            })
        })
        .collect())
}

// --- download + install ----------------------------------------------------

/// Does the asset name match the OS/arch build we want for this kind?
/// xray: `Xray-linux-64.zip` (amd64) / `Xray-linux-arm64-v8a.zip`.
fn asset_matches(kind: CoreKind, name: &str) -> bool {
    match kind {
        CoreKind::Xray => {
            // The native-TUN host is Linux only.
            match std::env::consts::ARCH {
                "x86_64" => name == "Xray-linux-64.zip",
                "aarch64" => name == "Xray-linux-arm64-v8a.zip",
                _ => false,
            }
        }
    }
}

async fn download_and_install(
    app: &AppHandle,
    kind: CoreKind,
    tag: &str,
    release: &serde_json::Value,
) -> Result<(), String> {
    let asset = release
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or("release has no assets")?
        .iter()
        .find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .map(|name| asset_matches(kind, name))
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("no matching {} asset for this platform", kind.slug()))?;

    let url = asset
        .get("browser_download_url")
        .and_then(|u| u.as_str())
        .ok_or("asset has no download url")?
        .to_string();
    // Cap the asset size taken from the (untrusted) release JSON: a huge / u64::MAX
    // `size` would otherwise panic Vec::with_capacity (capacity overflow) or OOM
    // the eagerly-buffered body. A core is tens of MB; 256 MB is generous.
    const MAX_CORE_BYTES: u64 = 256 * 1024 * 1024;
    let total: u64 = asset.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
    if total > MAX_CORE_BYTES {
        return Err(format!("core asset too large: {total} bytes"));
    }
    let digest = asset
        .get("digest")
        .and_then(|d| d.as_str())
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(|h| h.to_lowercase());

    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }

    let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    let mut last_emit = Instant::now();
    let mut window_start = Instant::now();
    let mut window_bytes: u64 = 0;
    let mut speed_bps: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download chunk: {e}"))?;
        buf.extend_from_slice(&chunk);
        // Hard ceiling in case the body exceeds the declared size.
        if buf.len() as u64 > MAX_CORE_BYTES {
            return Err("core download exceeded size limit".into());
        }
        window_bytes += chunk.len() as u64;

        let now = Instant::now();
        if now.duration_since(window_start) >= Duration::from_millis(250) {
            let elapsed = now.duration_since(window_start).as_secs_f64();
            if elapsed > 0.0 {
                speed_bps = (window_bytes as f64 / elapsed) as u64;
            }
            window_start = now;
            window_bytes = 0;
        }

        if now.duration_since(last_emit) >= Duration::from_millis(100) {
            let _ = app.emit(
                "core://progress",
                CoreProgress {
                    tag: tag.to_string(),
                    downloaded: buf.len() as u64,
                    total,
                    speed_bps,
                },
            );
            last_emit = now;
        }
    }

    let _ = app.emit(
        "core://progress",
        CoreProgress {
            tag: tag.to_string(),
            downloaded: buf.len() as u64,
            total: buf.len() as u64,
            speed_bps,
        },
    );

    if let Some(expected) = digest {
        let actual = sha256_hex(&buf);
        if actual != expected {
            return Err(format!(
                "core checksum mismatch (expected {expected}, got {actual}) — refusing to install"
            ));
        }
    }

    let dest = version_binary(app, kind, tag)?;
    std::fs::create_dir_all(dest.parent().unwrap())
        .map_err(|e| format!("create version dir: {e}"))?;
    extract_binary_zip(&buf, &dest, kind.bin_name())?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn set_exec(dest: &PathBuf) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    {
        let _ = dest;
    }
}

/// Pull `member` out of a .tar.gz and write it to `dest`. Currently unused
/// (xray ships `.zip`); kept for a future tar.gz-distributed fallback core.
#[allow(dead_code)]
fn extract_binary_targz(tar_gz: &[u8], dest: &PathBuf, member: &str) -> Result<(), String> {
    use flate2::read::GzDecoder;
    let mut archive = tar::Archive::new(GzDecoder::new(tar_gz));
    let entries = archive.entries().map_err(|e| format!("tar: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;
        let path = entry.path().map_err(|e| format!("tar path: {e}"))?;
        let is_bin = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == member)
            .unwrap_or(false);
        if is_bin {
            entry.unpack(dest).map_err(|e| format!("unpack: {e}"))?;
            set_exec(dest);
            return Ok(());
        }
    }
    Err(format!("{member} not found in archive"))
}

/// Pull `member` out of a .zip and write it to `dest`.
fn extract_binary_zip(zip_bytes: &[u8], dest: &PathBuf, member: &str) -> Result<(), String> {
    use std::io::{Cursor, Read, Write};
    let mut archive =
        zip::ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("zip open: {e}"))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        let name = file.name().rsplit('/').next().unwrap_or("").to_string();
        if name == member {
            let mut out = std::fs::File::create(dest).map_err(|e| format!("create binary: {e}"))?;
            let mut chunk = [0u8; 65536];
            loop {
                let n = file
                    .read(&mut chunk)
                    .map_err(|e| format!("zip read: {e}"))?;
                if n == 0 {
                    break;
                }
                out.write_all(&chunk[..n])
                    .map_err(|e| format!("write binary: {e}"))?;
            }
            drop(out);
            set_exec(dest);
            return Ok(());
        }
    }
    Err(format!("{member} not found in archive"))
}

// --- public API ------------------------------------------------------------

#[tauri::command]
pub async fn core_info(app: AppHandle, kind: String) -> Result<CoreInfo, String> {
    let kind = CoreKind::parse(&kind)?;
    let active = active_tag(&app, kind);
    let installed: Vec<InstalledVersion> = installed_tags(&app, kind)
        .into_iter()
        .map(|tag| InstalledVersion {
            active: active.as_deref() == Some(tag.as_str()),
            tag,
        })
        .collect();
    let latest = latest_version(kind).await.ok();
    let has_update = match (&active, &latest) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(a), Some(l)) => version_cmp(l, a) == std::cmp::Ordering::Greater,
    };
    Ok(CoreInfo {
        installed,
        active,
        latest,
        has_update,
    })
}

/// Download `version` (or latest when null) for `kind`. First install for a
/// kind auto-activates it. xray installs trigger a setcap prompt: its native TUN
/// needs CAP_NET_ADMIN (file caps are cleared whenever the binary is rewritten).
#[tauri::command]
pub async fn core_install(
    app: AppHandle,
    kind: String,
    version: Option<String>,
) -> Result<String, String> {
    let kind = CoreKind::parse(&kind)?;
    let release = match version {
        Some(t) => fetch_release_by_tag(kind, &t).await?,
        None => fetch_latest_release(kind).await?,
    };
    let tag = version_from_tag(&release).ok_or("no version in release")?;

    download_and_install(&app, kind, &tag, &release).await?;

    let became_active = if active_tag(&app, kind).is_none() {
        write_active(&app, kind, &tag)?;
        true
    } else {
        active_tag(&app, kind).as_deref() == Some(tag.as_str())
    };
    // File capabilities are cleared whenever the binary is (re)written, so the
    // active xray must be re-capped after any download of the active tag.
    if became_active && kind == CoreKind::Xray {
        let app2 = app.clone();
        let _ =
            tokio::task::spawn_blocking(move || crate::vpn::request_setcap_blocking(&app2)).await;
    }
    Ok(tag)
}

/// Switch the active version for `kind`. Re-cap xray afterwards (its native TUN
/// needs CAP_NET_ADMIN and caps are bound to the specific binary).
#[tauri::command]
pub async fn core_activate(app: AppHandle, kind: String, tag: String) -> Result<(), String> {
    let kind = CoreKind::parse(&kind)?;
    let bin = version_binary(&app, kind, &tag)?;
    if !bin.exists() {
        return Err(format!("version {tag} isn't downloaded"));
    }
    write_active(&app, kind, &tag)?;
    if kind == CoreKind::Xray {
        let app2 = app.clone();
        let _ =
            tokio::task::spawn_blocking(move || crate::vpn::request_setcap_blocking(&app2)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn core_uninstall(app: AppHandle, kind: String, tag: String) -> Result<(), String> {
    let kind = CoreKind::parse(&kind)?;
    if !valid_tag(&tag) {
        return Err(format!("invalid version tag: {tag}"));
    }
    let was_active = active_tag(&app, kind).as_deref() == Some(strip_v(&tag));
    let dir = versions_dir(&app, kind)?.join(strip_v(&tag));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove version dir: {e}"))?;
    }
    if was_active {
        let _ = clear_active(&app, kind);
    }
    if installed_tags(&app, kind).is_empty() {
        let _ = clear_active(&app, kind);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_tag_accepts_versions_and_rejects_traversal() {
        for ok in ["v1.2.3", "26.3.27", "v2024.1.0-beta.1", "1.8.4+build_2"] {
            assert!(valid_tag(ok), "{ok} should be valid");
        }
        for bad in [
            "",
            "v",
            "..",
            ".",
            "a/b",
            "../../etc",
            "/home/daniil/.config/autostart/x",
            "v../../x",
            "a\\b",
        ] {
            assert!(!valid_tag(bad), "{bad:?} should be rejected");
        }
    }
}
