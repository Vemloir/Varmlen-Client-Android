//! Client side of connect/disconnect — xray-native, no root daemon.
//!
//! - "tun" mode: full-system TUN. xray (setcap cap_net_admin) owns its native
//!   `tun` inbound and does the per-app/site split + DNS + vless/reality/XHTTP
//!   transport itself. xray's tun manages no routes, so the setcap'd
//!   `varmlen-probe` lays the routing (`route-up`) + killswitch around it. The GUI
//!   owns the single xray child process directly.
//! - "proxy" mode: just xray's SOCKS inbound on 127.0.0.1:XRAY_SOCKS_PORT — no
//!   TUN, no caps. Apps point at it.
//!
//! There is no unix socket / systemd service, and no second core anymore.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};

use crate::core::CoreKind;
use crate::split::SplitInput;
use crate::subscription::VlessServer;
use crate::xray::{build_xray_config, validate_server, TunMode};

/// Returned to the frontend; shape unchanged from the old socket protocol so
/// `api.ts` keeps working.
#[derive(Serialize, Deserialize)]
pub struct HelperResponse {
    pub ok: bool,
    pub state: String,
    pub pid: Option<u32>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<u32>,
}

impl HelperResponse {
    fn connected(pid: u32) -> Self {
        HelperResponse {
            ok: true,
            state: "connected".into(),
            pid: Some(pid),
            error: None,
            rtt_ms: None,
        }
    }
    fn disconnected() -> Self {
        HelperResponse {
            ok: true,
            state: "disconnected".into(),
            pid: None,
            error: None,
            rtt_ms: None,
        }
    }
    /// Tunnel died unexpectedly; the kill switch is holding traffic blocked.
    fn dropped() -> Self {
        HelperResponse {
            ok: true,
            state: "dropped".into(),
            pid: None,
            error: None,
            rtt_ms: None,
        }
    }
}

// --- child processes (owned by the GUI) ------------------------------------

fn xray_child() -> &'static Mutex<Option<Child>> {
    static C: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// Serializes connect/disconnect end-to-end. Without it two overlapping
/// vpn_connect calls can interleave around the brief child-slot lock and orphan
/// an xray process + tunnel; disconnect also takes it so it can't race a connect.
fn vpn_op_lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

// --- connection phase + crash watcher --------------------------------------
//
// The kill switch is a fail-closed feature: if xray dies unexpectedly while the
// user enabled it, traffic stays BLOCKED (the nft drop table + routes-into-a-
// dead-tun keep everything from leaking out the physical NIC). A background
// watcher detects the crash and moves us to a distinct "dropped" phase so the UI
// can say "VPN dropped — traffic blocked" instead of a misleading "disconnected"
// (which implies traffic flows freely). With the kill switch OFF, the watcher
// instead tears the routing down so direct connectivity is restored.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// "disconnected" | "connected" | "dropped". Authoritative for vpn_status.
fn conn_phase() -> &'static Mutex<String> {
    static P: OnceLock<Mutex<String>> = OnceLock::new();
    P.get_or_init(|| Mutex::new("disconnected".into()))
}
fn set_phase(p: &str) {
    *conn_phase().lock().unwrap() = p.to_string();
}

/// Bumped on every connect; a watcher exits once its generation is stale (a
/// newer connect superseded it).
static CONN_GEN: AtomicU64 = AtomicU64::new(0);
/// Set before an intentional stop_all (user disconnect / reconnect) so the
/// watcher never mistakes a deliberate teardown for a crash.
static INTENTIONAL_STOP: AtomicBool = AtomicBool::new(false);

/// React to an unexpected xray exit. Kill switch on → keep blocking (the point),
/// just mark the phase. Off → restore direct connectivity via the helper cleanup.
fn handle_crash(app: &tauri::AppHandle, killswitch: bool) {
    use tauri::Emitter;
    if killswitch {
        set_phase("dropped");
        let _ = app.emit("vpn-dropped", true);
    } else {
        if let Some(probe) = probe_bin(app) {
            let _ = Command::new(&probe).arg("cleanup").status();
        }
        set_phase("disconnected");
        let _ = app.emit("vpn-dropped", false);
    }
}

/// Poll the xray child once a second; on an unexpected exit, run `handle_crash`.
/// Exits quietly when superseded (stale generation) or on an intentional stop.
fn spawn_crash_watcher(app: tauri::AppHandle, killswitch: bool, generation: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        if CONN_GEN.load(Ordering::SeqCst) != generation || INTENTIONAL_STOP.load(Ordering::SeqCst)
        {
            return;
        }
        if pid_of(xray_child()).is_some() {
            continue;
        }
        // xray is gone — re-check it wasn't a deliberate/superseded stop racing us.
        if CONN_GEN.load(Ordering::SeqCst) != generation || INTENTIONAL_STOP.load(Ordering::SeqCst)
        {
            return;
        }
        handle_crash(&app, killswitch);
        return;
    });
}

fn pid_of(slot: &Mutex<Option<Child>>) -> Option<u32> {
    let mut g = slot.lock().unwrap();
    match g.as_mut() {
        Some(c) => match c.try_wait() {
            Ok(None) => Some(c.id()),
            _ => {
                *g = None;
                None
            }
        },
        None => None,
    }
}

/// SIGTERM a child so it can tear down cleanly (xray closes its native tun fd,
/// which removes the device), wait up to ~5s, then SIGKILL. The kernel routing
/// is the helper's (`route-down`), not xray's.
fn terminate_gracefully(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    for _ in 0..50 {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Stop xray + tear down routing/killswitch. Fail-open order: drop the
/// killswitch FIRST so a partial teardown never black-holes the box, then
/// SIGTERM xray (closes the tun fd), then the helper's `cleanup` (route-down +
/// killswitch-down + stray-TUN delete).
/// Fast best-effort teardown for app exit: SIGKILL xray (no graceful wait —
/// we're quitting) + drop the killswitch + cleanup, so the tunnel never
/// outlives the process. Idempotent. Called from the RunEvent::Exit handler.
pub(crate) fn teardown_on_exit(app: &tauri::AppHandle) {
    INTENTIONAL_STOP.store(true, Ordering::SeqCst);
    if let Some(probe) = probe_bin(app) {
        let _ = Command::new(&probe).arg("killswitch-down").status();
    }
    if let Some(mut c) = xray_child().lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    if let Some(probe) = probe_bin(app) {
        let _ = Command::new(&probe).arg("cleanup").status();
    }
}

fn stop_all(app: &tauri::AppHandle) {
    if let Some(probe) = probe_bin(app) {
        let _ = Command::new(&probe).arg("killswitch-down").status();
    }
    // Take the child out of the slot BEFORE terminating so the mutex guard is
    // not held across the (up to ~5s) graceful shutdown — otherwise a concurrent
    // vpn_status()/connect would block on the lock for the whole teardown.
    let child = xray_child().lock().unwrap().take();
    if let Some(mut c) = child {
        terminate_gracefully(&mut c);
    }
    if let Some(probe) = probe_bin(app) {
        let _ = Command::new(&probe).arg("cleanup").status();
    }
}

fn last_error_line(stderr: &str) -> String {
    let strip = |s: &str| s.replace('\u{1b}', "");
    stderr
        .lines()
        .map(|l| strip(l).trim().to_string())
        .filter(|l| !l.is_empty())
        .find(|l| l.contains("FATAL") || l.contains("ERROR") || l.contains("Failed"))
        .or_else(|| {
            stderr
                .lines()
                .map(|l| strip(l).trim().to_string())
                .rfind(|l| !l.is_empty())
        })
        .unwrap_or_else(|| "no output".to_string())
}

// --- resource locations ----------------------------------------------------

/// Locate the bundled `varmlen-probe`. Dev: helper build output. Packaged: the
/// copy placed in app-data/bin (resource → bin on first run; see grant_caps).
fn probe_bin(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    // Installed copy (what we setcap).
    if let Ok(data) = app.path().app_data_dir() {
        let p = data.join("bin").join("varmlen-probe");
        if p.exists() {
            return Some(p);
        }
    }
    // Dev fallback: the freshly-built binary in the helper crate.
    let dev = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../helper/target/release/varmlen-probe"
    ));
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// The varmlen-probe source binary to install/setcap (resource in prod, dev build
/// output otherwise).
fn probe_source(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("varmlen-probe");
        if p.exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../helper/target/release/varmlen-probe"
    ));
    dev.exists().then_some(dev)
}

fn setcap_script(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("varmlen-setcap.sh");
        if p.exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../helper/varmlen-setcap.sh"
    ));
    dev.exists().then_some(dev)
}

fn old_helper_uninstall(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("uninstall.sh");
        if p.exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../helper/uninstall.sh"
    ));
    dev.exists().then_some(dev)
}

// --- DNS / killswitch helpers ----------------------------------------------

/// Resolve a server host to IPs for the killswitch allow-list. Servers are IP
/// literals now, so this is usually a no-op parse.
fn resolve_ips(host: &str) -> Vec<std::net::IpAddr> {
    use std::net::ToSocketAddrs;
    use std::str::FromStr;
    if host.is_empty() {
        return Vec::new();
    }
    if let Ok(ip) = std::net::IpAddr::from_str(host) {
        return vec![ip];
    }
    (host, 443u16)
        .to_socket_addrs()
        .map(|it| it.map(|s| s.ip()).collect())
        .unwrap_or_default()
}

// --- caps -------------------------------------------------------------------

/// Does `bin` carry the given capability (substring match on getcap output)?
fn has_cap(bin: &PathBuf, cap: &str) -> bool {
    Command::new("getcap")
        .arg(bin)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(cap))
        .unwrap_or(false)
}

/// Run the setcap batch via pkexec (one prompt): grant caps to the active xray
/// (its native TUN needs CAP_NET_ADMIN) + varmlen-probe, optionally removing the
/// legacy root helper too. Blocking (pkexec shows a password dialog) — call
/// from spawn_blocking.
pub fn request_setcap_blocking(app: &tauri::AppHandle) -> Result<(), String> {
    let script = setcap_script(app).ok_or("setcap script not found")?;
    let xray =
        crate::core::binary_path(app, CoreKind::Xray).map_err(|e| format!("xray core: {e}"))?;
    // Ensure varmlen-probe is installed in app-data/bin so we can setcap a stable path.
    let probe = ensure_probe_installed(app)?;

    let mut cmd = Command::new("pkexec");
    cmd.arg(&script).arg(&xray).arg(&probe);
    // If the legacy root helper is present, fold its removal into this prompt.
    if std::path::Path::new("/etc/systemd/system/varmlen-helper.service").exists() {
        if let Some(unins) = old_helper_uninstall(app) {
            cmd.arg(unins);
        }
    }
    let status = cmd.status().map_err(|e| format!("pkexec: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "granting permissions failed or was cancelled (exit {:?})",
            status.code()
        ))
    }
}

/// Copy the bundled varmlen-probe into app-data/bin (idempotent) so it has a
/// stable path to setcap (resources get replaced on app update, clearing caps).
fn ensure_probe_installed(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let bin_dir = data.join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("create bin dir: {e}"))?;
    let dest = bin_dir.join("varmlen-probe");
    let src = probe_source(app).ok_or("bundled varmlen-probe not found")?;
    // Only copy if missing or different size (cheap freshness check).
    let need = !dest.exists()
        || std::fs::metadata(&dest).map(|m| m.len()).ok()
            != std::fs::metadata(&src).map(|m| m.len()).ok();
    if need {
        // Install atomically: copy to a temp file, then rename over `dest`. An
        // in-place copy fails with ETXTBSY ("text file busy") whenever a probe
        // is running from `dest` (e.g. a server latency ping); rename swaps the
        // directory entry and leaves any running process on the old inode.
        let tmp = bin_dir.join("varmlen-probe.new");
        std::fs::copy(&src, &tmp).map_err(|e| format!("copy probe: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &dest).map_err(|e| format!("install probe: {e}"))?;
    }
    Ok(dest)
}

// --- connect / disconnect ---------------------------------------------------

fn spawn_core(bin: &PathBuf, cfg_path: &PathBuf) -> Result<Child, String> {
    let mut child = Command::new(bin)
        .arg("run")
        .arg("-c")
        .arg(cfg_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", bin.display()))?;
    // Catch an immediate crash (bad config / missing caps).
    std::thread::sleep(Duration::from_millis(700));
    if let Ok(Some(_)) = child.try_wait() {
        let mut err = String::new();
        if let Some(mut s) = child.stderr.take() {
            use std::io::Read;
            let _ = s.read_to_string(&mut err);
        }
        return Err(last_error_line(&err));
    }
    // Drain stderr to a log file + journal so the pipe never fills.
    let log_path = cfg_path.with_extension("log");
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader, Write};
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("core: {line}");
                if let Some(ref mut file) = f {
                    let _ = writeln!(file, "{line}");
                }
            }
        });
    }
    Ok(child)
}

fn runtime_dir() -> PathBuf {
    let base = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let d = base.join("varmlen");
    let _ = std::fs::create_dir_all(&d);
    // The configs written here embed server credentials (uuid/password/reality
    // keys). Lock the dir to the owner — esp. important on the world-writable
    // /tmp fallback when XDG_RUNTIME_DIR is unset.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
    }
    d
}

/// Write a config file containing credentials with 0600 perms (the runtime dir
/// is already 0700; this is belt-and-suspenders).
fn write_private(path: &PathBuf, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub async fn vpn_connect(
    app: tauri::AppHandle,
    server: VlessServer,
    split: SplitInput,
    mode: String,
    killswitch: bool,
    allow_lan: bool,
    log_level: Option<String>,
) -> Result<HelperResponse, String> {
    // Android: hand the generated config to the VpnService bridge. The native
    // tun + tun2socks + bundled xray live in the Kotlin VpnPlugin; the kill
    // switch / routing are the OS's job there.
    let level = log_level.unwrap_or_else(|| "warn".to_string());
    validate_server(&server)?;
    #[cfg(target_os = "android")]
    {
        let _ = killswitch;
        let xray_cfg = serde_json::to_string(&build_xray_config(
            &server,
            &split,
            &mode,
            TunMode::Tun2socks,
            allow_lan,
            &level,
        ))
        .map_err(|e| e.to_string())?;
        // apps_allow = whitelist apps (only listed apps enter the tun). This is
        // the APPS split mode — independent of the sites mode and of `mode`
        // (which is the tun/proxy selector).
        let apps_allow = split.apps_selective();
        crate::mobile_vpn::connect(
            &app,
            xray_cfg,
            crate::xray::XRAY_SOCKS_PORT,
            split.apps.clone(),
            apps_allow,
            level,
        )?;
        return Ok(HelperResponse::connected(0));
    }

    #[cfg(not(target_os = "android"))]
    {
        // Hold the op lock for the whole connect so it can't interleave with another
        // connect/disconnect and orphan a tunnel.
        let _op = vpn_op_lock().lock().await;
        let xray_cfg = serde_json::to_string(&build_xray_config(
            &server,
            &split,
            &mode,
            TunMode::XrayNative,
            allow_lan,
            &level,
        ))
        .map_err(|e| e.to_string())?;
        // Validation config: a SOCKS-inbound variant with the SAME routing /
        // outbounds / dns. `xray run -test` on a tun inbound needs CAP_NET_ADMIN and
        // actually creates the device, so we instead validate this device-free
        // variant (the tun inbound itself is static {name,mtu} and can't have a
        // per-server config error).
        let validate_cfg = serde_json::to_string(&build_xray_config(
            &server,
            &split,
            &mode,
            TunMode::Tun2socks,
            allow_lan,
            &level,
        ))
        .map_err(|e| e.to_string())?;
        let server_host = server.host.clone();

        tokio::task::spawn_blocking(move || -> Result<HelperResponse, String> {
            // Mark the upcoming teardown intentional so any prior crash-watcher exits
            // without firing; cleared once we're successfully connected again.
            INTENTIONAL_STOP.store(true, Ordering::SeqCst);
            stop_all(&app);
            // stop_all just lifted any kill switch / routes, so we're no longer in a
            // "dropped" (blocked) phase — clear it so a *failed* reconnect can't leave
            // vpn_status falsely reporting blocked.
            set_phase("disconnected");

            let xray_bin = crate::core::binary_path(&app, CoreKind::Xray)
                .map_err(|e| format!("xray core: {e} — install it in Settings → VPN core"))?;
            let rt = runtime_dir();
            let xray_path = rt.join("xray.json");
            write_private(&xray_path, &xray_cfg)?;

            // Validate the device-free variant before touching any kernel state.
            let validate_path = rt.join("xray-validate.json");
            write_private(&validate_path, &validate_cfg)?;
            validate_xray(&xray_bin, &validate_path)?;

            if mode == "proxy" {
                // Local SOCKS only — no TUN, no caps, no routing. No kill switch
                // applies, so a crash just means "disconnected" (no watcher needed).
                let xray = spawn_core(&xray_bin, &xray_path).map_err(|e| format!("xray: {e}"))?;
                *xray_child().lock().unwrap() = Some(xray);
                let pid = pid_of(xray_child()).unwrap_or(0);
                CONN_GEN.fetch_add(1, Ordering::SeqCst);
                INTENTIONAL_STOP.store(false, Ordering::SeqCst);
                set_phase("connected");
                return Ok(HelperResponse::connected(pid));
            }

            // TUN mode: xray owns the native tun and needs CAP_NET_ADMIN. If the
            // permissions aren't granted yet, prompt for them now (pkexec) — on the
            // first connect — instead of nagging at launch.
            if !has_cap(&xray_bin, "cap_net_admin") {
                request_setcap_blocking(&app)
                    .map_err(|e| format!("granting network permissions: {e}"))?;
                if !has_cap(&xray_bin, "cap_net_admin") {
                    return Err("network permissions were not granted".into());
                }
            }
            let server_ips = resolve_ips(&server_host);
            if server_ips.is_empty() {
                return Err(format!("could not resolve server address '{server_host}'"));
            }

            // 1) xray first: it creates varmlen0 and starts reading. No routes point
            //    into the tun yet, so traffic still uses the physical default.
            let xray = match spawn_core(&xray_bin, &xray_path) {
                Ok(c) => c,
                Err(e) => {
                    stop_all(&app);
                    return Err(format!("xray: {e}"));
                }
            };
            let pid = xray.id();
            *xray_child().lock().unwrap() = Some(xray);

            // 2) route-up: lay the routing the native tun needs (anti-loop server
            //    route first, then the default into the tun) via the setcap'd probe.
            let Some(probe) = probe_bin(&app) else {
                stop_all(&app);
                return Err("varmlen-probe helper not found".into());
            };
            let mut up = Command::new(&probe);
            up.arg("route-up");
            for ip in &server_ips {
                up.arg("--server").arg(ip.to_string());
            }
            match up.output() {
                Ok(o) if o.status.success() => {}
                Ok(o) => {
                    stop_all(&app);
                    return Err(format!(
                        "routing setup failed: {}",
                        last_error_line(&String::from_utf8_lossy(&o.stderr))
                    ));
                }
                Err(e) => {
                    stop_all(&app);
                    return Err(format!("routing setup failed: {e}"));
                }
            }

            // 3) killswitch (optional), last. The user explicitly enabled it, so
            //    fail CLOSED if it can't be applied — never report "connected" with
            //    a silently-absent kill switch.
            if killswitch {
                let mut ks = Command::new(&probe);
                ks.arg("killswitch-up");
                if allow_lan {
                    ks.arg("--allow-lan");
                }
                for ip in &server_ips {
                    ks.arg(ip.to_string());
                }
                let applied = ks.status().map(|s| s.success()).unwrap_or(false);
                if !applied {
                    stop_all(&app);
                    return Err(
                        "kill switch could not be applied — check network permissions in Settings"
                            .into(),
                    );
                }
            }

            // Connected. Arm the crash watcher: a fresh generation (supersedes any
            // prior watcher) and clear the intentional-stop flag.
            let generation = CONN_GEN.fetch_add(1, Ordering::SeqCst) + 1;
            INTENTIONAL_STOP.store(false, Ordering::SeqCst);
            set_phase("connected");
            spawn_crash_watcher(app.clone(), killswitch, generation);

            Ok(HelperResponse::connected(pid))
        })
        .await
        .map_err(|e| format!("join: {e}"))?
    }
}

/// Validate an xray config with `xray run -test -c <file>` before launch.
fn validate_xray(bin: &PathBuf, cfg: &PathBuf) -> Result<(), String> {
    let out = Command::new(bin)
        .arg("run")
        .arg("-test")
        .arg("-c")
        .arg(cfg)
        .output()
        .map_err(|e| format!("xray validate: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // xray writes config errors to stderr (and sometimes stdout).
    let mut msg = last_error_line(&String::from_utf8_lossy(&out.stderr));
    if msg == "no output" {
        msg = last_error_line(&String::from_utf8_lossy(&out.stdout));
    }
    Err(format!("xray config invalid: {msg}"))
}

#[tauri::command]
pub async fn vpn_disconnect(app: tauri::AppHandle) -> Result<HelperResponse, String> {
    #[cfg(target_os = "android")]
    {
        crate::mobile_vpn::disconnect(&app)?;
        return Ok(HelperResponse::disconnected());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _op = vpn_op_lock().lock().await;
        // A user-initiated stop: silence the crash watcher and drop to
        // disconnected (also lifts a "dropped" kill switch, restoring traffic).
        INTENTIONAL_STOP.store(true, Ordering::SeqCst);
        let _ = tokio::task::spawn_blocking(move || stop_all(&app)).await;
        set_phase("disconnected");
        Ok(HelperResponse::disconnected())
    }
}

#[tauri::command]
pub async fn vpn_status(app: tauri::AppHandle) -> Result<HelperResponse, String> {
    #[cfg(target_os = "android")]
    {
        return Ok(if crate::mobile_vpn::is_running(&app) {
            HelperResponse::connected(0)
        } else {
            HelperResponse::disconnected()
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        // The crash watcher owns the "dropped" phase (tunnel died, kill switch
        // holding) — report it distinctly so the UI doesn't claim "disconnected".
        if conn_phase().lock().unwrap().as_str() == "dropped" {
            return Ok(HelperResponse::dropped());
        }
        // The single xray process alive → connected (tun or proxy mode).
        if let Some(pid) = pid_of(xray_child()) {
            return Ok(HelperResponse::connected(pid));
        }
        Ok(HelperResponse::disconnected())
    }
}

/// The VPN log shown in the in-app log viewer. On Android the VpnService writes
/// every step + xray/tun2socks output to a file; on desktop it's xray's stderr.
#[tauri::command]
pub async fn vpn_log(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::read_log(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(std::fs::read_to_string(runtime_dir().join("xray.log")).unwrap_or_default())
    }
}

#[tauri::command]
pub async fn clear_vpn_log(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::clear_log(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        let _ = std::fs::write(runtime_dir().join("xray.log"), "");
        Ok(())
    }
}

/// Read the system clipboard. Android only — desktop uses navigator.clipboard.
#[tauri::command]
pub async fn read_clipboard(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::read_clipboard(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Err("use navigator.clipboard on desktop".to_string())
    }
}

/// Write the system clipboard. Android uses the native plugin; desktop uses
/// navigator.clipboard directly from the user gesture.
#[tauri::command]
pub async fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::write_clipboard(&app, text);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, text);
        Err("use navigator.clipboard on desktop".to_string())
    }
}

/// Match the Android system-bar icon colour to the app theme (light → dark icons).
#[tauri::command]
pub async fn set_status_bar(app: tauri::AppHandle, light: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::set_bar_style(&app, light);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, light);
        Ok(())
    }
}

/// Whether the app may post notifications (Android). Always true on desktop.
#[tauri::command]
pub async fn notifications_enabled(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::notifications_enabled(&app).unwrap_or(false);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        true
    }
}

/// Open the system notification settings for this app (Android). No-op on desktop.
#[tauri::command]
pub async fn open_notification_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::open_notification_settings(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(())
    }
}

/// Open Android's system VPN settings. No-op on desktop.
#[tauri::command]
pub async fn open_vpn_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return crate::mobile_vpn::open_vpn_settings(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(())
    }
}

/// Whether the cores have the capabilities they need (replaces the old
/// "helper installed" check).
#[tauri::command]
pub async fn caps_granted(app: tauri::AppHandle) -> bool {
    tokio::task::spawn_blocking(move || {
        crate::core::binary_path(&app, CoreKind::Xray)
            .map(|b| has_cap(&b, "cap_net_admin"))
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Grant network permissions (setcap via pkexec). Replaces install_helper.
#[tauri::command]
pub async fn grant_caps(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || request_setcap_blocking(&app))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// --- location ping ----------------------------------------------------------

/// Local source-bound TCP connect — fallback when varmlen-probe is unavailable.
/// Can't escape the tun's default route while connected (no caps), so the RTT
/// is only accurate when disconnected.
fn tcp_ping_local(host: &str, port: u16, timeout: Duration) -> Result<u32, String> {
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    use std::net::{SocketAddr, ToSocketAddrs};

    let dst: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("resolve: {e}"))?
        .find(|a| a.is_ipv4())
        .ok_or_else(|| "no ipv4 addr".to_string())?;
    let sock = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| format!("socket: {e}"))?;
    let started = Instant::now();
    sock.connect_timeout(&SockAddr::from(dst), timeout)
        .map_err(|e| format!("connect: {e}"))?;
    Ok(started.elapsed().as_millis().min(u32::MAX as u128) as u32)
}

/// TCP-connect RTT — Happ-style latency probe. Uses the setcap'd varmlen-probe
/// (SO_MARK + SO_BINDTODEVICE) so it bypasses the active tunnel; falls back to
/// a plain local connect if the probe is missing/uncapped.
#[tauri::command]
pub async fn tcp_ping_host(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    timeout_ms: Option<u32>,
) -> Result<u32, String> {
    let ms = timeout_ms.unwrap_or(2500);
    tokio::task::spawn_blocking(move || {
        if let Some(probe) = probe_bin(&app) {
            let out = Command::new(&probe)
                .arg("tcp")
                .arg(&host)
                .arg(port.to_string())
                .arg(ms.to_string())
                .output();
            if let Ok(o) = out {
                if o.status.success() {
                    if let Ok(rtt) = String::from_utf8_lossy(&o.stdout).trim().parse::<u32>() {
                        return Ok(rtt);
                    }
                }
            }
        }
        tcp_ping_local(&host, port, Duration::from_millis(ms as u64))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// A free ephemeral local TCP port (bind to :0, read the assigned port, release).
/// There is an unavoidable TOCTOU window before xray re-binds it; a foreign
/// listener that wins the race is caught later by the socks handshake failing.
fn free_local_port() -> Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("alloc port: {e}"))
}

fn free_local_ports(count: usize) -> Result<Vec<u16>, String> {
    let mut ports = Vec::with_capacity(count);
    while ports.len() < count {
        let port = free_local_port()?;
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    Ok(ports)
}

const PROXY_PING_URL: &str = "http://www.gstatic.com/generate_204";

fn build_proxy_ping_request(client: &reqwest::Client) -> reqwest::RequestBuilder {
    client.head(PROXY_PING_URL)
}

async fn probe_proxy_port(port: u16, timeout: Duration) -> Result<u32, String> {
    let client = reqwest::Client::builder()
        .proxy(
            reqwest::Proxy::all(format!("socks5h://127.0.0.1:{port}"))
                .map_err(|e| format!("proxy: {e}"))?,
        )
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let started = Instant::now();
    let resp = build_proxy_ping_request(&client)
        .send()
        .await
        .map_err(|e| format!("HEAD: {e}"))?;
    if resp.status().as_u16() != 204 {
        return Err(format!("unexpected status {}", resp.status()));
    }
    Ok(started.elapsed().as_millis().min(u32::MAX as u128) as u32)
}

/// Per-location via-proxy latency: spin one throwaway xray and time an HTTP HEAD
/// through every concrete outbound represented by the location. Composite JSON
/// locations (such as Proxen Estonia) are provider balancers; measuring only
/// their fallback produced multi-second values even when another variant was
/// healthy. The displayed value is the fastest successful path, matching what
/// the location's least-load/least-ping balancer can actually select.
#[tauri::command]
pub async fn proxy_get_ping(
    app: tauri::AppHandle,
    server: VlessServer,
    timeout_ms: Option<u32>,
) -> Result<u32, String> {
    validate_server(&server)?;
    let ms = timeout_ms.unwrap_or(5000) as u64;
    let proxy_count = crate::xray::ping_proxy_count(&server)?;
    let ports = free_local_ports(proxy_count)?;
    let cfg = serde_json::to_string(&crate::xray::build_ping_config(&server, &ports)?)
        .map_err(|e| e.to_string())?;

    // Android: exec the bundled xray from nativeLibraryDir, config in filesDir.
    #[cfg(target_os = "android")]
    let (xray_bin, cfg_path) = {
        let (bin, dir) = crate::mobile_vpn::xray_paths(&app)?;
        (
            std::path::PathBuf::from(bin),
            std::path::PathBuf::from(dir).join(format!("ping-{}.json", ports[0])),
        )
    };
    #[cfg(not(target_os = "android"))]
    let (xray_bin, cfg_path) = {
        let bin = crate::core::binary_path(&app, CoreKind::Xray)
            .map_err(|e| format!("xray core: {e}"))?;
        (bin, runtime_dir().join(format!("ping-{}.json", ports[0])))
    };

    if let Err(e) = write_private(&cfg_path, &cfg) {
        let _ = std::fs::remove_file(&cfg_path);
        return Err(e);
    }

    let mut child = Command::new(&xray_bin)
        .arg("run")
        .arg("-c")
        .arg(&cfg_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn xray: {e}"))?;

    // The whole op is bounded by `ms`; always clean up the child + temp config.
    let deadline = Instant::now() + Duration::from_millis(ms);
    let result = async {
        // Wait for every SOCKS inbound, but bail the instant xray dies (e.g. an
        // unsupported/malformed server) instead of burning the whole budget.
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                return Err("xray exited before the proxy was ready".to_string());
            }
            let checks = ports.iter().copied().map(|port| {
                tokio::task::spawn_blocking(move || {
                    std::net::TcpStream::connect_timeout(
                        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                        Duration::from_millis(100),
                    )
                    .is_ok()
                })
            });
            let ready = join_all(checks)
                .await
                .into_iter()
                .all(|result| result.unwrap_or(false));
            if ready {
                break;
            }
            if Instant::now() >= deadline {
                return Err("proxy did not start".to_string());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("proxy ping timed out before probing".to_string());
        }
        let results = join_all(
            ports
                .iter()
                .copied()
                .map(|port| probe_proxy_port(port, remaining)),
        )
        .await;
        results
            .into_iter()
            .filter_map(Result::ok)
            .min()
            .ok_or_else(|| "all proxy variants failed the latency probe".to_string())
    }
    .await;

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&cfg_path);
    result
}

#[cfg(test)]
mod ping_tests {
    use super::{build_proxy_ping_request, PROXY_PING_URL};

    #[test]
    fn proxy_ping_matches_xray_health_check_request() {
        let client = reqwest::Client::new();
        let request = build_proxy_ping_request(&client).build().unwrap();

        assert_eq!(request.method(), reqwest::Method::HEAD);
        assert_eq!(request.url().as_str(), PROXY_PING_URL);
        assert_eq!(
            request.url().as_str(),
            "http://www.gstatic.com/generate_204"
        );
    }
}
