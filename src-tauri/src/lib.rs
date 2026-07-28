mod apps;
mod core;
#[cfg(target_os = "android")]
mod mobile_vpn;
mod split;
mod storage;
mod subscription;
mod tray;
mod vpn;
mod xray;

use std::collections::HashMap;
use std::time::Duration;

use subscription::{
    is_supported_uri, parse_json_subscription, parse_proxy_uri, parse_subscription, ImportResult,
    SubscriptionMeta, VlessServer,
};

#[tauri::command]
fn parse_vless_uri(uri: String) -> Result<VlessServer, String> {
    parse_proxy_uri(&uri).map_err(|e| e.to_string())
}

#[tauri::command]
fn parse_subscription_body(body: String) -> Vec<VlessServer> {
    parse_subscription(&body)
}

#[tauri::command]
fn parse_subscription_response(
    body: String,
    headers: HashMap<String, String>,
) -> Result<ImportResult, String> {
    const MAX_SUB_BYTES: usize = 8 * 1024 * 1024;
    if body.len() > MAX_SUB_BYTES {
        return Err("subscription exceeded size limit".to_string());
    }
    Ok(subscription::parse_subscription_response(&body, &headers))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionRefreshScheduleInput {
    id: String,
    url: String,
    user_agent: String,
    interval_hours: u32,
    last_success_at: i64,
    next_update_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagedSubscriptionResponse {
    id: String,
    body: String,
    headers: HashMap<String, String>,
    refreshed_at: i64,
}

#[tauri::command]
fn sync_subscription_refresh(
    app: tauri::AppHandle,
    schedules: Vec<SubscriptionRefreshScheduleInput>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return mobile_vpn::sync_subscription_refresh(&app, schedules);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, schedules);
        Err("subscription background refresh is Android-only".to_string())
    }
}

#[tauri::command]
fn cancel_subscription_refresh(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        return mobile_vpn::cancel_subscription_refresh(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("subscription background refresh is Android-only".to_string())
    }
}

#[tauri::command]
fn drain_subscription_refreshes(
    app: tauri::AppHandle,
) -> Result<Vec<StagedSubscriptionResponse>, String> {
    #[cfg(target_os = "android")]
    {
        return mobile_vpn::drain_subscription_refreshes(&app);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

/// Fetch and parse a subscription. Returns servers + server-side metadata
/// (title, update interval, traffic counters, expiry, support URL).
///
/// If `url` is a raw `vless://` link, returns a single-server result with
/// an empty meta block.
/// True for hosts we refuse to fetch (SSRF guard): localhost and literal
/// loopback / private / link-local / CGNAT addresses. A domain that *resolves*
/// to a private IP isn't caught here — an accepted residual for now.
fn is_blocked_host(host: &str) -> bool {
    let h = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    match h.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.octets()[0] & 0xfe) == 0xfc
                || (v6.octets()[0] == 0xfe && (v6.octets()[1] & 0xc0) == 0x80)
        }
        Err(_) => false,
    }
}

fn target_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "Android"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        std::env::consts::OS
    }
}

fn target_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

fn subscription_headers(choice: Option<&str>) -> Result<(String, String), String> {
    let brand = match choice.unwrap_or("varmlen") {
        "varmlen" => "Varmlen",
        "happ" => "Happ",
        "incy" => "INCY",
        "v2raytun" => "v2rayTun",
        _ => return Err("unsupported subscription User-Agent".into()),
    };
    Ok((
        format!("{brand}/{}/{}", target_platform(), target_arch()),
        target_platform().to_ascii_lowercase(),
    ))
}

#[tauri::command]
async fn fetch_subscription(
    url: String,
    subscription_user_agent: Option<String>,
) -> Result<ImportResult, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("empty URL".to_string());
    }

    // Pasted JSON: an xray/v2ray config, a single outbound, or an array. The
    // config's `remarks` names the LOCATION (it's applied to the server label
    // inside parse_json_subscription), not the subscription — a pasted config
    // has no subscription title, so the UI labels it "Configuration N".
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let (_name, servers) = parse_json_subscription(trimmed);
        if servers.is_empty() {
            return Err("no servers found in the JSON".to_string());
        }
        return Ok(ImportResult {
            meta: SubscriptionMeta::default(),
            servers,
            description: None,
            source_json: Some(trimmed.to_string()),
        });
    }

    if is_supported_uri(trimmed) {
        // One pasted share-link, or several newline/whitespace-separated.
        if trimmed
            .lines()
            .filter(|l| is_supported_uri(l.trim()))
            .count()
            > 1
        {
            let servers = parse_subscription(trimmed);
            if servers.is_empty() {
                return Err("no servers found".to_string());
            }
            return Ok(ImportResult {
                meta: Default::default(),
                servers,
                description: None,
                source_json: None,
            });
        }
        return parse_proxy_uri(trimmed)
            .map(|s| ImportResult {
                meta: Default::default(),
                servers: vec![s],
                description: None,
                source_json: None,
            })
            .map_err(|e| e.to_string());
    }

    // SSRF guard: web schemes only, and reject loopback/private/link-local
    // targets (a benign-looking URL could otherwise 30x into LAN/metadata).
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("bad URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported URL scheme: {}", parsed.scheme()));
    }
    if parsed.host_str().map(is_blocked_host).unwrap_or(true) {
        return Err("refusing to fetch a loopback/private address".to_string());
    }

    let (user_agent, device_os) = subscription_headers(subscription_user_agent.as_deref())?;
    let client = reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(Duration::from_secs(15))
        // Validate every redirect hop too, so a 30x can't escape the guard.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if attempt
                .url()
                .host_str()
                .map(is_blocked_host)
                .unwrap_or(true)
            {
                attempt.error("redirect to a loopback/private address")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .get(trimmed)
        .header("X-Device-OS", device_os)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    // Cap the body: subscriptions are KB-scale; bail past the limit so a
    // malicious endpoint can't OOM us with an unbounded response.
    const MAX_SUB_BYTES: usize = 8 * 1024 * 1024;
    if resp
        .content_length()
        .map(|l| l > MAX_SUB_BYTES as u64)
        .unwrap_or(false)
    {
        return Err("subscription too large".to_string());
    }
    let headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let mut buf: Vec<u8> = Vec::new();
    {
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("read body: {e}"))?;
            buf.extend_from_slice(&chunk);
            if buf.len() > MAX_SUB_BYTES {
                return Err("subscription exceeded size limit".to_string());
            }
        }
    }
    let body = String::from_utf8_lossy(&buf).into_owned();
    Ok(subscription::parse_subscription_response(&body, &headers))
}

// (Ping/latency probes are intentionally absent — pending a design pass.
// vpn::vpn_icmp_ping and the helper's PingHost request are kept so we can
// wire up either TCP, ICMP, TLS or a combination once the approach is set.)

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK on Linux (especially under Wayland) has long-standing DMABUF /
    // compositing rendering bugs that show up as a blank window or an outright
    // failure to launch. Disable the DMABUF renderer + compositing (cheap and
    // safe) and fall back to XWayland under a Wayland session, so the app starts
    // out of the box with no `.desktop` env hacks. Everything stays overridable
    // — we only set a variable the user hasn't already set themselves.
    #[cfg(target_os = "linux")]
    {
        fn set_default(key: &str, val: &str) {
            if std::env::var_os(key).is_none() {
                std::env::set_var(key, val);
            }
        }
        set_default("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        set_default("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE")
                .map(|s| s == "wayland")
                .unwrap_or(false);
        if wayland {
            set_default("GDK_BACKEND", "x11");
        }
    }

    let mut builder = tauri::Builder::default();

    // Single-instance MUST be the first plugin (desktop only): a second launch
    // just focuses the running window instead of spawning a duplicate process.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main(app);
        }));
    }

    // Android VPN bridge (registers the Kotlin VpnPlugin → VpnService).
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(mobile_vpn::init());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            parse_vless_uri,
            parse_subscription_body,
            parse_subscription_response,
            fetch_subscription,
            sync_subscription_refresh,
            cancel_subscription_refresh,
            drain_subscription_refreshes,
            apps::list_installed_apps,
            apps::pick_file,
            apps::app_from_file,
            core::core_info,
            core::core_install,
            core::core_activate,
            core::core_uninstall,
            core::list_core_releases,
            xray::location_editor_options,
            xray::generate_xray_config,
            vpn::vpn_connect,
            vpn::vpn_disconnect,
            vpn::vpn_status,
            vpn::caps_granted,
            vpn::grant_caps,
            vpn::tcp_ping_host,
            vpn::proxy_get_ping,
            vpn::vpn_log,
            vpn::clear_vpn_log,
            vpn::read_clipboard,
            vpn::write_clipboard,
            vpn::set_status_bar,
            vpn::notifications_enabled,
            vpn::open_notification_settings,
            vpn::open_vpn_settings,
            tray::set_tray_status,
            tray::set_close_to_tray,
            tray::set_autostart,
            tray::autostart_status,
            storage::read_legacy_storage
        ])
        .on_window_event(|_window, _event| {
            // Desktop: closing the window hides it to the tray (VPN keeps
            // running) or fully quits, per the user's setting. Android manages
            // its own activity lifecycle, so this is desktop-only.
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                use tauri::Manager;
                api.prevent_close();
                if tray::close_to_tray() {
                    let _ = _window.hide();
                } else {
                    tray::quit_app(_window.app_handle());
                }
            }
        })
        .setup(|app| {
            use tauri::Manager;
            // Seed the bundled xray into the core dir if nothing is installed,
            // so the app has a working core on first launch even when GitHub is
            // unreachable (censored networks). No-op once a core exists.
            core::seed_bundled_core(app.handle());
            // System tray + start-minimized are desktop-only.
            #[cfg(desktop)]
            {
                tray::build_tray(app.handle())?;
                if tray::launched_minimized() {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // Desktop: drop the tunnel so xray never outlives the process.
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = _event {
                vpn::teardown_on_exit(_app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_ua_choices_are_bounded_and_platform_specific() {
        for (choice, brand) in [
            ("varmlen", "Varmlen"),
            ("happ", "Happ"),
            ("incy", "INCY"),
            ("v2raytun", "v2rayTun"),
        ] {
            let (ua, os) = subscription_headers(Some(choice)).expect("known UA");
            assert_eq!(
                ua,
                format!("{brand}/{}/{}", target_platform(), target_arch())
            );
            assert_eq!(os, target_platform().to_ascii_lowercase());
            assert!(!ua.contains(env!("CARGO_PKG_VERSION")));
        }

        assert_eq!(
            subscription_headers(None).expect("default").0,
            format!("Varmlen/{}/{}", target_platform(), target_arch())
        );
        assert!(subscription_headers(Some("header\r\ninjection")).is_err());
    }

    #[test]
    fn import_result_serializes_json_source() {
        let result = ImportResult {
            meta: SubscriptionMeta::default(),
            servers: Vec::new(),
            description: None,
            source_json: Some("{\"outbounds\":[]}".into()),
        };
        let value = serde_json::to_value(result).expect("serialize import result");
        assert_eq!(value["source_json"], "{\"outbounds\":[]}");
    }
}
