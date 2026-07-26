//! Generate an xray-core client config — the sole data plane.
//!
//! xray now owns the whole tunnel: a native `tun` inbound captures system
//! traffic, xray's routing does the site-level split + DNS anti-leak, and the
//! per-protocol outbound (vless / vmess / trojan / shadowsocks) does the
//! upstream transport. The per-*app* split uses xray's native `process` routing
//! matcher (Linux): the native tun inbound preserves each app's real local
//! socket, so xray resolves the owning process via /proc and routes by process
//! name — exactly like sing-box's `process_name`. The helper only lays the OS
//! routing the native tun needs (xray manages no routes/DNS itself).
//! Requires xray >= v26.1.23 (empty-source-IP routing panic fixed there).
//!
//! The native tun inbound deliberately manages NO addresses/routes/DNS/iptables
//! ("the OS should manage it"), so the helper lays the device address, the
//! default route into the tun, the fwmark bypass rules, and the anti-loop
//! server-IP route. xray's own dials (proxy + direct outbounds) carry
//! `sockopt.mark = XRAY_DIAL_MARK` so they escape the tun instead of looping.
//!
//! `TunMode` keeps the data plane swappable: `XrayNative` uses the native tun
//! inbound; `Tun2socks` keeps a local SOCKS inbound that an external tun2socks
//! forwards into (a drop-in fallback if the native tun proves flaky).

use serde_json::{json, Value};

use crate::split::SplitInput;
use crate::subscription::VlessServer;

/// Local SOCKS port xray listens on in `Tun2socks`/proxy mode.
pub const XRAY_SOCKS_PORT: u16 = 2081;

/// fwmark stamped on xray's own outgoing sockets (proxy + direct dials) so the
/// helper's `ip rule` routes them out the physical NIC instead of back into the
/// tun. Matches the helper killswitch's accepted dial mark (`0x2024`).
pub const XRAY_DIAL_MARK: u32 = 0x2024;

/// TUN interface name. Must match the helper's `TUN_IFACE`.
pub const TUN_NAME: &str = "varmlen0";
const TUN_MTU: u32 = 1500;

/// Private / LAN ranges kept direct when "allow LAN" is on. Explicit CIDRs
/// rather than `geoip:private` so xray needs no `geoip.dat` asset — we ship only
/// the xray binary, not the geo data files.
const PRIVATE_CIDRS: &[&str] = &[
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "100.64.0.0/10",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
];

/// How system traffic reaches xray.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TunMode {
    /// xray's native experimental `tun` inbound (single binary).
    #[default]
    XrayNative,
    /// Local SOCKS inbound fed by an external tun2socks (fallback path).
    Tun2socks,
}

impl TunMode {
    /// Kept for the swappable-backend path (a future external tun2socks); the
    /// connect flow currently hardcodes `XrayNative`.
    #[allow(dead_code)]
    pub fn parse(s: &str) -> Self {
        match s {
            "tun2socks" => TunMode::Tun2socks,
            _ => TunMode::XrayNative,
        }
    }
    /// Tag of the inbound that carries system traffic (for routing rules).
    fn inbound_tag(self) -> &'static str {
        match self {
            TunMode::XrayNative => "tun-in",
            TunMode::Tun2socks => "socks-in",
        }
    }
}

/// Map our `transport` field to xray's `streamSettings.network`, normalising the
/// various aliases subscriptions use. `splithttp` is the old name for `xhttp`;
/// `raw` is the new name for `tcp`; `h2` is `http`. Unknown → tcp.
fn xray_network(transport: &str) -> &str {
    match transport.to_ascii_lowercase().as_str() {
        "xhttp" | "splithttp" => "xhttp",
        "ws" | "websocket" => "ws",
        "grpc" | "gun" => "grpc",
        "httpupgrade" => "httpupgrade",
        "http" | "h2" | "h3" => "http",
        "kcp" | "mkcp" => "kcp",
        "raw" | "tcp" | "" => "tcp",
        _ => "tcp",
    }
}

/// Split a comma/whitespace list param (e.g. `alpn=h2,http/1.1`) into a JSON array.
fn split_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Build the `streamSettings` object: security (reality/tls/none) + the
/// transport-specific block + `sockopt.mark` (anti-loop).
fn build_stream_settings(s: &VlessServer) -> Value {
    let network = xray_network(&s.transport);
    let server_name = s
        .sni
        .clone()
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| s.host.clone());
    let fp = s
        .fingerprint
        .clone()
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| "chrome".to_string());

    let mut stream = serde_json::Map::new();
    stream.insert("network".into(), json!(network));

    // Security layer.
    match s.security.as_str() {
        "reality" => {
            stream.insert("security".into(), json!("reality"));
            stream.insert(
                "realitySettings".into(),
                json!({
                    "show": false,
                    "serverName": server_name,
                    "fingerprint": fp,
                    "publicKey": s.public_key.clone().unwrap_or_default(),
                    "shortId": s.short_id.clone().unwrap_or_default(),
                    // spiderX (spx) is carried in the subscription's raw params.
                    "spiderX": s.raw_params.get("spx").cloned().unwrap_or_else(|| "/".into()),
                }),
            );
        }
        "tls" => {
            stream.insert("security".into(), json!("tls"));
            let mut tls = serde_json::Map::new();
            tls.insert("serverName".into(), json!(server_name));
            tls.insert("fingerprint".into(), json!(fp));
            // `allowInsecure=1` disables cert validation (test servers only).
            let insecure = matches!(
                s.raw_params.get("allowInsecure").map(String::as_str),
                Some("1") | Some("true")
            );
            tls.insert("allowInsecure".into(), json!(insecure));
            if let Some(alpn) = s.raw_params.get("alpn").filter(|a| !a.is_empty()) {
                tls.insert("alpn".into(), json!(split_list(alpn)));
            }
            stream.insert("tlsSettings".into(), Value::Object(tls));
        }
        _ => {
            stream.insert("security".into(), json!("none"));
        }
    }

    // Transport-specific settings.
    let host_hdr = s.raw_params.get("host").filter(|h| !h.is_empty()).cloned();
    let path = s.path.clone().unwrap_or_else(|| "/".into());
    match network {
        "xhttp" => {
            let mut xs = serde_json::Map::new();
            xs.insert("path".into(), json!(path));
            xs.insert("mode".into(), json!(s.mode.clone().unwrap_or_else(|| "auto".into())));
            if let Some(host) = host_hdr {
                xs.insert("host".into(), json!(host));
            }
            stream.insert("xhttpSettings".into(), Value::Object(xs));
        }
        "ws" => {
            let mut ws = serde_json::Map::new();
            ws.insert("path".into(), json!(path));
            if let Some(host) = host_hdr {
                ws.insert("headers".into(), json!({ "Host": host }));
            }
            stream.insert("wsSettings".into(), Value::Object(ws));
        }
        "httpupgrade" => {
            let mut hu = serde_json::Map::new();
            hu.insert("path".into(), json!(path));
            if let Some(host) = host_hdr {
                hu.insert("host".into(), json!(host));
            }
            stream.insert("httpupgradeSettings".into(), Value::Object(hu));
        }
        "grpc" => {
            let svc = s
                .raw_params
                .get("serviceName")
                .cloned()
                .unwrap_or_default();
            let multi = matches!(s.mode.as_deref(), Some("multi") | Some("gun"));
            let mut g = serde_json::Map::new();
            g.insert("serviceName".into(), json!(svc));
            g.insert("multiMode".into(), json!(multi));
            if let Some(auth) = s.raw_params.get("authority").filter(|a| !a.is_empty()) {
                g.insert("authority".into(), json!(auth));
            }
            stream.insert("grpcSettings".into(), Value::Object(g));
        }
        "http" => {
            let mut h = serde_json::Map::new();
            h.insert("path".into(), json!(path));
            if let Some(host) = host_hdr {
                h.insert("host".into(), json!(split_list(&host)));
            }
            stream.insert("httpSettings".into(), Value::Object(h));
        }
        "kcp" => {
            let mut k = serde_json::Map::new();
            // header obfuscation type (e.g. none / srtp / wechat-video).
            let header_ty = s
                .raw_params
                .get("headerType")
                .cloned()
                .unwrap_or_else(|| "none".into());
            k.insert("header".into(), json!({ "type": header_ty }));
            if let Some(seed) = s.raw_params.get("seed").filter(|x| !x.is_empty()) {
                k.insert("seed".into(), json!(seed));
            }
            stream.insert("kcpSettings".into(), Value::Object(k));
        }
        "tcp"
            // TCP with HTTP header obfuscation (headerType=http) needs a
            // tcpSettings.header so xray frames requests as fake HTTP.
            if s.raw_params.get("headerType").map(String::as_str) == Some("http") => {
                let mut req = serde_json::Map::new();
                if let Some(host) = host_hdr {
                    req.insert("headers".into(), json!({ "Host": split_list(&host) }));
                }
                if s.path.is_some() {
                    req.insert("path".into(), json!(split_list(&path)));
                }
                stream.insert(
                    "tcpSettings".into(),
                    json!({ "header": { "type": "http", "request": Value::Object(req) } }),
                );
            }
        _ => {}
    }

    // Anti-loop: xray's dial to the remote server must escape the tun.
    stream.insert("sockopt".into(), json!({ "mark": XRAY_DIAL_MARK }));

    Value::Object(stream)
}

/// Build the `proxy` outbound for the selected server, branching on protocol.
/// The parsed model (`VlessServer`) carries every field; only the JSON shape
/// differs (vnext for vless/vmess, servers for trojan/shadowsocks).
fn build_proxy_outbound(s: &VlessServer) -> Value {
    let stream = build_stream_settings(s);
    match s.protocol.as_str() {
        "vmess" => json!({
            "tag": "proxy",
            "protocol": "vmess",
            "settings": {
                "vnext": [{
                    "address": s.host,
                    "port": s.port,
                    "users": [{
                        "id": s.uuid,
                        // vmess:// rarely carries cipher/alterId; modern servers
                        // are AEAD (alterId 0) with negotiated security "auto".
                        "security": s.raw_params.get("scy").cloned().unwrap_or_else(|| "auto".into()),
                        "alterId": s.raw_params.get("aid").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0),
                    }]
                }]
            },
            "streamSettings": stream,
        }),
        "trojan" => json!({
            "tag": "proxy",
            "protocol": "trojan",
            "settings": {
                "servers": [{
                    "address": s.host,
                    "port": s.port,
                    // Trojan password is stored in `password` (mirrored into uuid).
                    "password": s.password.clone().unwrap_or_else(|| s.uuid.clone()),
                    "flow": s.flow.clone().unwrap_or_default(),
                }]
            },
            "streamSettings": stream,
        }),
        "shadowsocks" => json!({
            "tag": "proxy",
            "protocol": "shadowsocks",
            "settings": {
                "servers": [{
                    "address": s.host,
                    "port": s.port,
                    "method": s.method.clone().unwrap_or_default(),
                    "password": s.password.clone().unwrap_or_default(),
                    "uot": true,
                }]
            },
            "streamSettings": stream,
        }),
        // vless (default).
        _ => json!({
            "tag": "proxy",
            "protocol": "vless",
            "settings": {
                "vnext": [{
                    "address": s.host,
                    "port": s.port,
                    "users": [{
                        "id": s.uuid,
                        "encryption": "none",
                        // xhttp uses no flow; vision (tcp) would set it.
                        "flow": s.flow.clone().unwrap_or_default(),
                    }]
                }]
            },
            "streamSettings": stream,
        }),
    }
}

/// Direct egress. `domainStrategy: UseIP` resolves bypassed domains via xray's
/// DNS module (DoH through the proxy), so direct connections never leak a
/// plaintext lookup to the ISP resolver. `sockopt.mark` keeps the direct dial
/// out of the tun.
fn direct_outbound() -> Value {
    json!({
        "tag": "direct",
        "protocol": "freedom",
        "settings": { "domainStrategy": "UseIP" },
        "streamSettings": { "sockopt": { "mark": XRAY_DIAL_MARK } }
    })
}

/// xray's built-in DNS module: a single DoH resolver. All queries are detoured
/// through the `proxy` outbound by a routing rule, so DNS egresses from the VPN
/// node, never the local resolver — the anti-leak invariant.
fn build_dns() -> Value {
    json!({
        "servers": ["https://1.1.1.1/dns-query"],
        "queryStrategy": "UseIPv4"
    })
}

/// The inbound that carries system traffic.
fn build_inbounds(tun: TunMode) -> Vec<Value> {
    // routeOnly: the sniffed domain is used for routing (domain rules) but the
    // connection keeps its original destination. This avoids the destination
    // override that can sever the source->process binding the `process` matcher
    // relies on for per-app routing.
    let sniffing = json!({
        "enabled": true,
        "destOverride": ["http", "tls", "quic"],
        "routeOnly": true
    });
    match tun {
        TunMode::XrayNative => vec![json!({
            "tag": "tun-in",
            "protocol": "tun",
            // Native tun manages ONLY the device (name + mtu). Addressing,
            // routes, DNS redirect and the bypass rules are the helper's job.
            "settings": { "name": TUN_NAME, "mtu": TUN_MTU },
            "sniffing": sniffing,
        })],
        TunMode::Tun2socks => vec![json!({
            "tag": "socks-in",
            "listen": "127.0.0.1",
            "port": XRAY_SOCKS_PORT,
            "protocol": "socks",
            "settings": { "udp": true, "auth": "noauth" },
            "sniffing": sniffing,
        })],
    }
}

/// Routing rules. Per-app (`process`) and per-site (`domain`) split are BOTH
/// enforced here — xray's native tun preserves each app's local socket, so the
/// `process` matcher resolves the owning process (Linux), exactly like sing-box
/// `process_name`. Every rule needs `"type":"field"` for cross-version safety.
///
/// Mode semantics (apps and sites are INDEPENDENT):
///   - selective (whitelist): listed entries -> proxy.
///   - general   (blacklist): listed entries -> direct.
///
/// Default outbound:
///   - Android (tun2socks): the per-app split is the VpnService's job (xray's
///     process matcher can't match Android packages), so the xray default is
///     governed by the SITES mode alone.
///   - Desktop: both are xray rules, so the default tunnels everything unless
///     BOTH categories are whitelists (then default direct).
fn build_route_rules(
    split: &SplitInput,
    allow_lan: bool,
    inbound_tag: &str,
    tun: TunMode,
) -> Vec<Value> {
    let apps_selective = split.apps_selective();
    let sites_selective = split.sites_selective();
    let android = matches!(tun, TunMode::Tun2socks);
    let apps_out = if apps_selective { "proxy" } else { "direct" };
    let sites_out = if sites_selective { "proxy" } else { "direct" };
    let default_out = if android {
        if sites_selective {
            "direct"
        } else {
            "proxy"
        }
    } else if apps_selective && sites_selective {
        "direct"
    } else {
        "proxy"
    };

    let mut rules = vec![
        // 1. Hijack app DNS (:53) into xray's DNS module.
        json!({ "type": "field", "inboundTag": [inbound_tag], "port": 53, "outboundTag": "dns-out" }),
    ];

    // 2. Keep LAN/private traffic direct when allowed.
    if allow_lan {
        rules.push(json!({ "type": "field", "ip": PRIVATE_CIDRS, "outboundTag": "direct" }));
    }

    // 3. Per-app split (desktop only): native process matcher. On Android the
    //    VpnService gates which apps reach xray at all, so package names here
    //    wouldn't match anyway.
    if !android {
        for app in split.enabled_apps() {
            rules.push(json!({ "type": "field", "process": [app], "outboundTag": apps_out }));
        }
    }

    // 4. Per-site split. "*.example.com" -> suffix (domain:), "example.com" -> exact (full:).
    let domains: Vec<String> = split
        .sites
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|site| match site.strip_prefix("*.") {
            Some(suffix) => format!("domain:{suffix}"),
            None => format!("full:{site}"),
        })
        .collect();
    if !domains.is_empty() {
        rules.push(json!({ "type": "field", "domain": domains, "outboundTag": sites_out }));
    }

    // 5. Force the DNS module's own DoH upstream (1.1.1.1) through the tunnel —
    //    anti-leak even in selective/direct-default mode. BELOW the app/site
    //    rules: the internal resolver connection has no source process, so it
    //    falls through to here, while user traffic that matched an exclusion
    //    above is unaffected.
    rules.push(json!({ "type": "field", "ip": ["1.1.1.1"], "outboundTag": "proxy" }));

    // 6. Everything else.
    rules.push(json!({ "type": "field", "network": "tcp,udp", "outboundTag": default_out }));
    rules
}

/// Full xray config for a connection.
/// Map the UI log level (debug/warn/error) to xray's vocabulary (xray uses
/// "warning", not "warn"; hev uses "warn").
fn xray_loglevel(level: &str) -> &'static str {
    match level {
        "debug" => "debug",
        "info" => "info",
        "error" => "error",
        "none" => "none",
        _ => "warning",
    }
}

/// `mode` is the connection mode: "tun" (system-wide) or "proxy" (local SOCKS
/// only). `tun` selects how the tun is provided when `mode == "tun"`.
pub fn build_xray_config(
    server: &VlessServer,
    split: &SplitInput,
    mode: &str,
    tun: TunMode,
    allow_lan: bool,
    log_level: &str,
) -> Value {
    let loglevel = xray_loglevel(log_level);
    if mode == "proxy" {
        // Local SOCKS only — apps opt in by pointing at it. No tun, no split.
        return json!({
            "log": { "loglevel": loglevel },
            "dns": build_dns(),
            "inbounds": build_inbounds(TunMode::Tun2socks),
            "outbounds": [
                build_proxy_outbound(server),
                direct_outbound(),
                { "tag": "dns-out", "protocol": "dns" },
                { "tag": "block", "protocol": "blackhole" }
            ],
            "routing": { "rules": [
                { "type": "field", "ip": ["1.1.1.1"], "outboundTag": "proxy" },
                { "type": "field", "network": "tcp,udp", "outboundTag": "proxy" }
            ] }
        });
    }

    json!({
        "log": { "loglevel": loglevel },
        "dns": build_dns(),
        "inbounds": build_inbounds(tun),
        "outbounds": [
            build_proxy_outbound(server),
            direct_outbound(),
            { "tag": "dns-out", "protocol": "dns" },
            { "tag": "block", "protocol": "blackhole" }
        ],
        "routing": { "rules": build_route_rules(split, allow_lan, tun.inbound_tag(), tun) }
    })
}

/// Minimal config for a per-server via-proxy latency probe: a local SOCKS
/// inbound on `socks_port` whose only outbound is the server. No tun, no split,
/// no DNS. The proxy outbound still carries `sockopt.mark` (via
/// `build_stream_settings`), so the probe's dial escapes the tun even while the
/// main tunnel is up — giving a clean measurement either way.
pub fn build_ping_config(server: &VlessServer, socks_port: u16) -> Value {
    json!({
        "log": { "loglevel": "warning" },
        "inbounds": [{
            "tag": "socks-in",
            "listen": "127.0.0.1",
            "port": socks_port,
            "protocol": "socks",
            "settings": { "udp": false, "auth": "noauth" }
        }],
        "outbounds": [
            build_proxy_outbound(server),
            { "tag": "direct", "protocol": "freedom" }
        ],
        "routing": { "rules": [
            { "type": "field", "network": "tcp,udp", "outboundTag": "proxy" }
        ] }
    })
}

// --- Tauri command ----------------------------------------------------------

/// Build and pretty-print the xray config JSON for inspection / launch.
#[tauri::command]
pub fn generate_xray_config(
    server: VlessServer,
    split: SplitInput,
    mode: String,
    allow_lan: bool,
) -> Result<String, String> {
    let cfg = build_xray_config(
        &server,
        &split,
        &mode,
        TunMode::default(),
        allow_lan,
        "warning",
    );
    serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::parse_proxy_uri;
    use base64::Engine;

    fn split() -> SplitInput {
        SplitInput::default()
    }

    fn rule_for<'a>(cfg: &'a Value, key: &str) -> Option<&'a Value> {
        cfg["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r.get(key).is_some())
    }

    #[test]
    fn vless_reality_xhttp_outbound() {
        let s = parse_proxy_uri(
            "vless://16ddb21e-5342-4a82-a870-1038b01b8dbc@46.29.238.157:443?type=xhttp&security=reality&encryption=none&sni=gateway.icloud.com&fp=firefox&pbk=PUBKEY&sid=SID&spx=%2F&path=%2F&mode=packet-up#NO",
        )
        .expect("parse");
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");

        let out = &cfg["outbounds"][0];
        assert_eq!(out["protocol"], "vless");
        let user = &out["settings"]["vnext"][0]["users"][0];
        assert_eq!(user["id"], "16ddb21e-5342-4a82-a870-1038b01b8dbc");
        assert_eq!(user["encryption"], "none");
        assert_eq!(user["flow"], "");

        let ss = &out["streamSettings"];
        assert_eq!(ss["network"], "xhttp");
        assert_eq!(ss["security"], "reality");
        assert_eq!(ss["realitySettings"]["fingerprint"], "firefox");
        assert_eq!(ss["realitySettings"]["publicKey"], "PUBKEY");
        assert_eq!(ss["realitySettings"]["shortId"], "SID");
        assert_eq!(ss["realitySettings"]["serverName"], "gateway.icloud.com");
        assert_eq!(ss["xhttpSettings"]["path"], "/");
        assert_eq!(ss["xhttpSettings"]["mode"], "packet-up");
    }

    #[test]
    fn tcp_reality_vision_keeps_flow() {
        let s = parse_proxy_uri(
            "vless://uuid-1@1.2.3.4:443?type=tcp&security=reality&flow=xtls-rprx-vision&sni=icloud.com&pbk=K&sid=ab&fp=chrome#X",
        )
        .expect("parse");
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");
        let out = &cfg["outbounds"][0];
        assert_eq!(
            out["settings"]["vnext"][0]["users"][0]["flow"],
            "xtls-rprx-vision"
        );
        assert_eq!(out["streamSettings"]["network"], "tcp");
        assert!(out["streamSettings"].get("xhttpSettings").is_none());
    }

    fn stream_for(uri: &str) -> Value {
        let s = parse_proxy_uri(uri).expect("parse");
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");
        cfg["outbounds"][0]["streamSettings"].clone()
    }

    #[test]
    fn httpupgrade_transport_builds_its_block() {
        let ss = stream_for("vless://u@1.2.3.4:443?type=httpupgrade&security=tls&sni=ex.com&host=cdn.ex.com&path=%2Fup#H");
        assert_eq!(ss["network"], "httpupgrade");
        assert_eq!(ss["httpupgradeSettings"]["path"], "/up");
        assert_eq!(ss["httpupgradeSettings"]["host"], "cdn.ex.com");
        assert!(ss.get("tcpSettings").is_none());
    }

    #[test]
    fn splithttp_aliases_to_xhttp() {
        let ss =
            stream_for("vless://u@1.2.3.4:443?type=splithttp&security=reality&pbk=K&path=%2Fx#S");
        assert_eq!(ss["network"], "xhttp");
        assert_eq!(ss["xhttpSettings"]["path"], "/x");
    }

    #[test]
    fn grpc_multi_mode_and_service_name() {
        let ss = stream_for("vless://u@1.2.3.4:443?type=grpc&security=tls&sni=ex.com&serviceName=mygrpc&mode=multi#G");
        assert_eq!(ss["network"], "grpc");
        assert_eq!(ss["grpcSettings"]["serviceName"], "mygrpc");
        assert_eq!(ss["grpcSettings"]["multiMode"], true);
    }

    #[test]
    fn ws_carries_host_header_and_alpn() {
        let ss = stream_for("vless://u@1.2.3.4:443?type=ws&security=tls&sni=ex.com&host=cdn.ex.com&path=%2Fws&alpn=h2%2Chttp%2F1.1#W");
        assert_eq!(ss["network"], "ws");
        assert_eq!(ss["wsSettings"]["headers"]["Host"], "cdn.ex.com");
        assert_eq!(ss["wsSettings"]["path"], "/ws");
        assert_eq!(ss["tlsSettings"]["alpn"][0], "h2");
        assert_eq!(ss["tlsSettings"]["alpn"][1], "http/1.1");
    }

    #[test]
    fn tcp_http_header_obfuscation() {
        let ss = stream_for("vless://u@1.2.3.4:80?type=tcp&security=none&headerType=http&host=fake.com&path=%2Fobf#O");
        assert_eq!(ss["network"], "tcp");
        assert_eq!(ss["tcpSettings"]["header"]["type"], "http");
        assert_eq!(
            ss["tcpSettings"]["header"]["request"]["headers"]["Host"][0],
            "fake.com"
        );
    }

    #[test]
    fn vmess_ws_host_header_survives() {
        let json = r#"{"v":"2","ps":"M","add":"1.2.3.4","port":"443","id":"3f7e7d8c-1234-5678-9abc-def012345678","aid":"0","net":"ws","tls":"tls","host":"cdn.ex.com","path":"/p","sni":"ex.com"}"#;
        let b64 = base64::engine::general_purpose::STANDARD.encode(json);
        let ss = stream_for(&format!("vmess://{b64}"));
        assert_eq!(ss["network"], "ws");
        assert_eq!(ss["wsSettings"]["headers"]["Host"], "cdn.ex.com");
        assert_eq!(ss["wsSettings"]["path"], "/p");
    }

    #[test]
    fn native_tun_inbound_only_has_name_and_mtu() {
        // Guard: the native tun inbound must NOT carry gateway/dns/iptables
        // fields — those are unverified upstream and the helper owns routing.
        let s = parse_proxy_uri("vless://u@1.2.3.4:443?security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");
        let inb = &cfg["inbounds"][0];
        assert_eq!(inb["protocol"], "tun");
        assert_eq!(inb["settings"]["name"], TUN_NAME);
        assert_eq!(inb["settings"]["mtu"], 1500);
        let keys: Vec<&String> = inb["settings"].as_object().unwrap().keys().collect();
        assert_eq!(
            keys.len(),
            2,
            "tun settings must be exactly {{name, mtu}}, got {keys:?}"
        );
        assert!(inb["sniffing"]["enabled"].as_bool().unwrap());
    }

    #[test]
    fn tun2socks_mode_uses_socks_inbound() {
        let s = parse_proxy_uri("vless://u@1.2.3.4:443?security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::Tun2socks, true, "warning");
        let inb = &cfg["inbounds"][0];
        assert_eq!(inb["protocol"], "socks");
        assert_eq!(inb["port"], XRAY_SOCKS_PORT);
        // routing DNS-hijack must target the socks inbound in this mode.
        let dns_rule = rule_for(&cfg, "inboundTag").unwrap();
        assert_eq!(dns_rule["inboundTag"][0], "socks-in");
    }

    #[test]
    fn proxy_and_direct_outbounds_carry_dial_mark() {
        let s =
            parse_proxy_uri("vless://u@1.2.3.4:443?type=xhttp&security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");
        assert_eq!(
            cfg["outbounds"][0]["streamSettings"]["sockopt"]["mark"],
            XRAY_DIAL_MARK
        );
        assert_eq!(
            cfg["outbounds"][1]["streamSettings"]["sockopt"]["mark"],
            XRAY_DIAL_MARK
        );
        assert_eq!(cfg["outbounds"][1]["protocol"], "freedom");
    }

    #[test]
    fn dns_routes_through_proxy_no_leak() {
        // Anti-leak: resolver is DoH (not a plaintext/localhost server), :53 is
        // hijacked into the DNS module, and the DoH upstream is forced to proxy.
        let s =
            parse_proxy_uri("vless://u@1.2.3.4:443?type=xhttp&security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");
        assert_eq!(cfg["dns"]["servers"][0], "https://1.1.1.1/dns-query");
        let serialized = serde_json::to_string(&cfg).unwrap();
        assert!(!serialized.contains("localhost") && !serialized.contains("\"local\""));
        let dns_hijack = rule_for(&cfg, "inboundTag").unwrap();
        assert_eq!(dns_hijack["port"], 53);
        assert_eq!(dns_hijack["outboundTag"], "dns-out");
        // DoH upstream pinned to proxy.
        let doh_rule = cfg["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| {
                r.get("ip")
                    .and_then(|v| v.as_array())
                    .map(|a| a[0] == "1.1.1.1")
                    .unwrap_or(false)
            })
            .unwrap();
        assert_eq!(doh_rule["outboundTag"], "proxy");
    }

    #[test]
    fn general_mode_apps_and_sites_to_direct_default_proxy() {
        let s = parse_proxy_uri("vless://u@1.2.3.4:443?security=reality&pbk=K#X").unwrap();
        let sp = SplitInput {
            apps_mode: "general".into(),
            sites_mode: "general".into(),
            apps: vec!["thunderbird".into()],
            sites: vec!["*.ru".into(), "example.com".into()],
        };
        let cfg = build_xray_config(&s, &sp, "tun", TunMode::XrayNative, true, "warning");
        let rules = cfg["routing"]["rules"].as_array().unwrap();
        // Every rule must carry type:field for cross-version safety.
        assert!(
            rules.iter().all(|r| r["type"] == "field"),
            "all rules need type:field"
        );
        assert_eq!(rules.last().unwrap()["outboundTag"], "proxy"); // default
        let proc_rule = rule_for(&cfg, "process").unwrap();
        assert_eq!(proc_rule["process"][0], "thunderbird");
        assert_eq!(proc_rule["outboundTag"], "direct"); // listed app bypasses
        let site_rule = rule_for(&cfg, "domain").unwrap();
        assert_eq!(site_rule["outboundTag"], "direct");
        let domains = site_rule["domain"].as_array().unwrap();
        assert!(domains.contains(&json!("domain:ru")));
        assert!(domains.contains(&json!("full:example.com")));
    }

    #[test]
    fn selective_apps_and_sites_full_fidelity() {
        // Native process matching gives full fidelity: both a process whitelist
        // AND a domain whitelist, with default direct (no one-TUN narrowing).
        let s = parse_proxy_uri("vless://u@1.2.3.4:443?security=reality&pbk=K#X").unwrap();
        let sp = SplitInput {
            apps_mode: "selective".into(),
            sites_mode: "selective".into(),
            apps: vec!["firefox".into()],
            sites: vec!["example.com".into()],
        };
        let cfg = build_xray_config(&s, &sp, "tun", TunMode::XrayNative, true, "warning");
        assert_eq!(
            cfg["routing"]["rules"].as_array().unwrap().last().unwrap()["outboundTag"],
            "direct"
        );
        let proc_rule = rule_for(&cfg, "process").unwrap();
        assert_eq!(proc_rule["process"][0], "firefox");
        assert_eq!(proc_rule["outboundTag"], "proxy"); // whitelisted app tunnels
        assert_eq!(rule_for(&cfg, "domain").unwrap()["outboundTag"], "proxy");
    }

    #[test]
    fn selective_sites_only_default_direct() {
        let s = parse_proxy_uri("vless://u@1.2.3.4:443?security=reality&pbk=K#X").unwrap();
        let sp = SplitInput {
            apps_mode: "selective".into(),
            sites_mode: "selective".into(),
            sites: vec!["example.com".into()],
            ..Default::default()
        };
        let cfg = build_xray_config(&s, &sp, "tun", TunMode::XrayNative, true, "warning");
        assert_eq!(
            cfg["routing"]["rules"].as_array().unwrap().last().unwrap()["outboundTag"],
            "direct"
        );
        assert_eq!(rule_for(&cfg, "domain").unwrap()["outboundTag"], "proxy");
        assert!(rule_for(&cfg, "process").is_none()); // no apps -> no process rule
    }

    #[test]
    fn dump_sample_config() {
        // Gated: only runs when DUMP_XRAY_CFG is set, to validate the generated
        // JSON against the real `xray run -test -c`. Writes a representative
        // tun-mode config (process rule + domain rule + allow_lan).
        if std::env::var("DUMP_XRAY_CFG").is_err() {
            return;
        }
        let s = parse_proxy_uri(
            "vless://16ddb21e-5342-4a82-a870-1038b01b8dbc@1.2.3.4:443?type=xhttp&security=reality&encryption=none&sni=example.com&fp=chrome&pbk=PUBKEY&sid=ab&spx=%2F&path=%2F&mode=auto#T",
        )
        .unwrap();
        let sp = SplitInput {
            apps_mode: "general".into(),
            sites_mode: "general".into(),
            apps: vec!["firefox".into(), "telegram-desktop".into()],
            sites: vec!["*.ru".into(), "example.com".into()],
        };
        let cfg = build_xray_config(&s, &sp, "tun", TunMode::XrayNative, true, "warning");
        std::fs::write(
            "/tmp/varmlen_xray_sample.json",
            serde_json::to_string_pretty(&cfg).unwrap(),
        )
        .unwrap();
        eprintln!("wrote /tmp/varmlen_xray_sample.json");
    }

    #[test]
    fn process_rules_precede_doh_pin() {
        // An excluded app's own traffic to 1.1.1.1 must hit its process rule
        // before the DoH pin (ip:1.1.1.1 -> proxy), so the exclusion is honoured.
        let s = parse_proxy_uri("vless://u@1.2.3.4:443?security=reality&pbk=K#X").unwrap();
        let sp = SplitInput {
            apps_mode: "general".into(),
            sites_mode: "general".into(),
            apps: vec!["firefox".into()],
            ..Default::default()
        };
        let cfg = build_xray_config(&s, &sp, "tun", TunMode::XrayNative, true, "warning");
        let rules = cfg["routing"]["rules"].as_array().unwrap();
        let proc_idx = rules
            .iter()
            .position(|r| r.get("process").is_some())
            .unwrap();
        let doh_idx = rules
            .iter()
            .position(|r| {
                r.get("ip")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().any(|x| x == "1.1.1.1"))
                    .unwrap_or(false)
            })
            .unwrap();
        assert!(proc_idx < doh_idx, "process rule must precede the DoH pin");
    }

    #[test]
    fn trojan_outbound_shape() {
        let s =
            parse_proxy_uri("trojan://secretpass@1.2.3.4:443?security=tls&sni=a.com#T").unwrap();
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");
        let out = &cfg["outbounds"][0];
        assert_eq!(out["protocol"], "trojan");
        assert_eq!(out["settings"]["servers"][0]["password"], "secretpass");
        assert_eq!(out["settings"]["servers"][0]["address"], "1.2.3.4");
        assert_eq!(out["streamSettings"]["security"], "tls");
    }

    #[test]
    fn shadowsocks_outbound_shape() {
        let s = parse_proxy_uri("ss://YWVzLTI1Ni1nY206c2VjcmV0@1.2.3.4:8388#S").unwrap();
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");
        let out = &cfg["outbounds"][0];
        assert_eq!(out["protocol"], "shadowsocks");
        assert_eq!(out["settings"]["servers"][0]["method"], "aes-256-gcm");
        assert_eq!(out["settings"]["servers"][0]["password"], "secret");
        assert_eq!(out["settings"]["servers"][0]["uot"], true);
    }

    #[test]
    fn vmess_outbound_shape() {
        // vmess base64 JSON: {v,ps,add,port,id,net,tls,...}
        let payload = serde_json::json!({
            "v":"2","ps":"M","add":"1.2.3.4","port":"443","id":"uuid-vm","net":"ws","tls":"tls","path":"/p"
        });
        let b64 = base64::engine::general_purpose::STANDARD.encode(payload.to_string());
        let s = parse_proxy_uri(&format!("vmess://{b64}")).unwrap();
        let cfg = build_xray_config(&s, &split(), "tun", TunMode::XrayNative, true, "warning");
        let out = &cfg["outbounds"][0];
        assert_eq!(out["protocol"], "vmess");
        assert_eq!(out["settings"]["vnext"][0]["users"][0]["id"], "uuid-vm");
        assert_eq!(out["settings"]["vnext"][0]["users"][0]["alterId"], 0);
        assert_eq!(out["streamSettings"]["network"], "ws");
    }

    #[test]
    fn proxy_mode_is_socks_only_no_tun() {
        let s =
            parse_proxy_uri("vless://u@1.2.3.4:443?type=xhttp&security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_config(&s, &split(), "proxy", TunMode::XrayNative, true, "warning");
        assert_eq!(cfg["inbounds"][0]["protocol"], "socks");
        assert!(cfg["inbounds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["protocol"] != "tun"));
    }
}
