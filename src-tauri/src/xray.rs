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
//! server-IP route. On desktop, xray's own dials (proxy + direct outbounds)
//! carry `sockopt.mark = XRAY_DIAL_MARK` so they escape the tun instead of
//! looping. Android must not use `SO_MARK` (ordinary apps cannot set it); its
//! VpnService excludes the Xray-owning package from capture instead.
//!
//! On Android the OS VpnService owns the TUN descriptor and per-package split;
//! on desktop Xray creates the interface and matches host process names.

use std::net::IpAddr;

use serde_json::{json, Value};
use url::Url;

use crate::split::SplitInput;
use crate::subscription::VlessServer;

const PROXY_PROTOCOLS: &[&str] = &[
    "http",
    "socks",
    "shadowsocks",
    "vmess",
    "vless",
    "trojan",
    "hysteria",
    "wireguard",
];
const RESERVED_OUTBOUND_TAGS: &[&str] = &["direct", "dns-out", "block"];
const DEFAULT_DOH_URLS: &[&str] = &["https://1.1.1.1/dns-query", "https://9.9.9.9/dns-query"];

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct EditorChoice {
    pub value: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationEditorOptions {
    pub protocols: Vec<EditorChoice>,
    pub transports: Vec<EditorChoice>,
    pub securities: Vec<EditorChoice>,
    pub fingerprints: Vec<EditorChoice>,
    pub flows: Vec<EditorChoice>,
    pub xhttp_modes: Vec<EditorChoice>,
    pub grpc_modes: Vec<EditorChoice>,
    pub packet_encodings: Vec<EditorChoice>,
    pub shadowsocks_methods: Vec<EditorChoice>,
    pub wireguard_domain_strategies: Vec<EditorChoice>,
}

fn choices(values: &[(&'static str, &'static str)]) -> Vec<EditorChoice> {
    values
        .iter()
        .map(|(value, label)| EditorChoice { value, label })
        .collect()
}

/// The field editor exposes only remote proxy protocols that Varmlen can turn
/// into a complete Xray outbound. The frontend obtains this catalogue through
/// a command instead of carrying its own stale list. Xray itself has no schema
/// enumeration API; generated configs are still validated by the bundled core
/// before a desktop connection starts.
#[tauri::command]
pub fn location_editor_options() -> LocationEditorOptions {
    let protocol_label = |protocol| match protocol {
        "http" => "HTTP",
        "socks" => "SOCKS",
        "shadowsocks" => "Shadowsocks",
        "vmess" => "VMess",
        "vless" => "VLESS",
        "trojan" => "Trojan",
        "hysteria" => "Hysteria2",
        "wireguard" => "WireGuard",
        _ => protocol,
    };
    LocationEditorOptions {
        protocols: PROXY_PROTOCOLS
            .iter()
            .map(|value| EditorChoice {
                value,
                label: protocol_label(value),
            })
            .collect(),
        transports: choices(&[
            ("tcp", "RAW / TCP"),
            ("xhttp", "XHTTP"),
            ("grpc", "gRPC"),
            ("ws", "WebSocket"),
            ("httpupgrade", "HTTPUpgrade"),
            ("kcp", "mKCP"),
            ("hysteria", "Hysteria"),
        ]),
        securities: choices(&[("none", "None"), ("tls", "TLS"), ("reality", "REALITY")]),
        fingerprints: choices(&[
            ("chrome", "Chrome"),
            ("firefox", "Firefox"),
            ("safari", "Safari"),
            ("ios", "iOS"),
            ("android", "Android"),
            ("edge", "Edge"),
            ("360", "360"),
            ("qq", "QQ"),
            ("random", "Random browser"),
            ("randomized", "Randomized"),
            ("unsafe", "Native Go TLS"),
        ]),
        flows: choices(&[("", "None"), ("xtls-rprx-vision", "XTLS Vision")]),
        xhttp_modes: choices(&[
            ("auto", "Auto"),
            ("packet-up", "Packet up"),
            ("stream-up", "Stream up"),
            ("stream-one", "Stream one"),
        ]),
        grpc_modes: choices(&[("", "Standard"), ("multi", "Multi")]),
        packet_encodings: choices(&[("", "None"), ("packetaddr", "PacketAddr"), ("xudp", "XUDP")]),
        shadowsocks_methods: choices(&[
            ("2022-blake3-aes-128-gcm", "2022 BLAKE3 AES-128-GCM"),
            ("2022-blake3-aes-256-gcm", "2022 BLAKE3 AES-256-GCM"),
            (
                "2022-blake3-chacha20-poly1305",
                "2022 BLAKE3 ChaCha20-Poly1305",
            ),
            ("aes-128-gcm", "AES-128-GCM"),
            ("aes-256-gcm", "AES-256-GCM"),
            ("chacha20-poly1305", "ChaCha20-Poly1305"),
            ("none", "None"),
        ]),
        wireguard_domain_strategies: choices(&[
            ("ForceIP", "Force IP"),
            ("ForceIPv4", "Force IPv4"),
            ("ForceIPv6", "Force IPv6"),
            ("ForceIPv4v6", "Prefer IPv4"),
            ("ForceIPv6v4", "Prefer IPv6"),
        ]),
    }
}

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

/// The layer that applies the per-application split policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppSplitOwner {
    /// Xray can match host process names on desktop.
    Xray,
    /// Android's VpnService includes/excludes package names before traffic
    /// reaches Xray.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    VpnService,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureInbound {
    NativeTun,
    /// Device-free HTTP inbound used only by `xray run -test`; it is never
    /// started as a user-facing proxy.
    ValidationHttp,
}

impl CaptureInbound {
    fn tag(self) -> &'static str {
        match self {
            Self::NativeTun => "tun-in",
            Self::ValidationHttp => "validation-in",
        }
    }
}

#[derive(Debug, Clone)]
enum ProxyTarget {
    Outbound(String),
    Balancer(String),
}

impl ProxyTarget {
    fn apply(&self, rule: &mut Value) {
        let object = rule.as_object_mut().expect("routing rule object");
        match self {
            Self::Outbound(tag) => {
                object.insert("outboundTag".into(), json!(tag));
            }
            Self::Balancer(tag) => {
                object.insert("balancerTag".into(), json!(tag));
            }
        }
    }
}

#[derive(Debug)]
struct OutboundPlan {
    proxies: Vec<Value>,
    target: ProxyTarget,
    balancers: Option<Value>,
    observatory: Option<Value>,
    burst_observatory: Option<Value>,
    provider_rules: Vec<Value>,
}

#[derive(Debug)]
struct DnsPlan {
    config: Value,
    upstream_ips: Vec<String>,
    probe_urls: Vec<String>,
}

fn is_proxy_protocol(protocol: &str) -> bool {
    PROXY_PROTOCOLS.contains(&protocol)
}

fn sanitize_raw_outbound(outbound: &Value, preserve_tag_and_chains: bool) -> Result<Value, String> {
    if contains_forbidden_provider_file_reference(outbound) {
        return Err("JSON proxy outbound may not reference local files".into());
    }
    let mut object = outbound
        .as_object()
        .cloned()
        .ok_or_else(|| "JSON proxy outbound must be an object".to_string())?;
    let protocol = object
        .get("protocol")
        .and_then(Value::as_str)
        .ok_or_else(|| "JSON proxy outbound has no protocol".to_string())?
        .to_ascii_lowercase();
    if !is_proxy_protocol(&protocol) {
        return Err(format!("unsupported proxy protocol in JSON: {protocol}"));
    }

    object.remove("sendThrough");
    if !preserve_tag_and_chains {
        object.remove("proxySettings");
        object.insert("tag".into(), json!("proxy"));
    }

    // Xray explicitly forbids streamSettings on WireGuard outbounds. Linux
    // bypasses its endpoint through the helper's per-server physical route;
    // Android excludes Varmlen's own package from VpnService capture.
    if protocol == "wireguard" {
        object.remove("streamSettings");
        return Ok(Value::Object(object));
    }

    let stream = object.entry("streamSettings").or_insert_with(|| json!({}));
    if !stream.is_object() {
        *stream = json!({});
    }
    let stream = stream.as_object_mut().expect("object inserted above");
    let sockopt = stream.entry("sockopt").or_insert_with(|| json!({}));
    if !sockopt.is_object() {
        *sockopt = json!({});
    }
    let sockopt = sockopt.as_object_mut().expect("object inserted above");
    if !preserve_tag_and_chains {
        sockopt.remove("dialerProxy");
    }
    sockopt.insert("mark".into(), json!(XRAY_DIAL_MARK));
    Ok(Value::Object(object))
}

fn contains_forbidden_provider_file_reference(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let key = key.to_ascii_lowercase();
            key.ends_with("file")
                || key.ends_with("filepath")
                || key == "masterkeylog"
                || contains_forbidden_provider_file_reference(value)
        }),
        Value::Array(items) => items.iter().any(contains_forbidden_provider_file_reference),
        _ => false,
    }
}

fn provider_proxy_outbounds(profile: &Value) -> Result<Vec<Value>, String> {
    let outbounds = profile
        .get("outbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| "Xray profile has no outbounds array".to_string())?;
    let mut proxies = Vec::new();
    let mut tags = std::collections::HashSet::new();
    for (index, outbound) in outbounds.iter().enumerate() {
        let protocol = outbound
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if !is_proxy_protocol(&protocol) {
            continue;
        }
        let mut outbound = sanitize_raw_outbound(outbound, true)?;
        let object = outbound.as_object_mut().expect("sanitized object");
        let tag = object
            .get("tag")
            .and_then(Value::as_str)
            .filter(|tag| !tag.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if index == 0 {
                    "proxy".into()
                } else {
                    format!("proxy-{}", index + 1)
                }
            });
        if RESERVED_OUTBOUND_TAGS.contains(&tag.as_str()) || !tags.insert(tag.clone()) {
            return Err(format!("unsafe or duplicate proxy outbound tag: {tag}"));
        }
        object.insert("tag".into(), json!(tag));
        proxies.push(outbound);
    }
    if proxies.is_empty() {
        return Err("Xray profile has no supported proxy outbounds".into());
    }
    Ok(proxies)
}

fn safe_provider_route_rules(
    server: &VlessServer,
    proxies: &[Value],
    balancers: Option<&Value>,
) -> Vec<Value> {
    let proxy_tags = proxies
        .iter()
        .filter_map(|outbound| outbound.get("tag").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    let balancer_tags = balancers
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|balancer| balancer.get("tag").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();

    server
        .raw_profile
        .as_ref()
        .and_then(|profile| profile.get("routing"))
        .and_then(|routing| routing.get("rules"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|rule| {
            let object = rule.as_object()?;
            // Provider domain/process policy would fight Varmlen's website and
            // per-app split controls. Provider inbound tags are unusable after
            // replacing its listeners with Varmlen's native TUN. Everything
            // else with a real selector is retained; network-only rules are a
            // provider catch-all and Varmlen owns the final route.
            if ["domain", "process", "inboundTag"]
                .iter()
                .any(|key| object.contains_key(*key))
                || ![
                    "protocol",
                    "ip",
                    "port",
                    "source",
                    "sourcePort",
                    "user",
                    "attrs",
                ]
                .iter()
                .any(|key| object.contains_key(*key))
            {
                return None;
            }
            // Varmlen intentionally ships no geoip.dat/geosite.dat bundle.
            // Carrying an asset-backed selector into the generated config
            // would make Xray reject the entire otherwise valid location.
            if object
                .get("ip")
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(is_external_route_selector))
            {
                return None;
            }
            let outbound_ok = object
                .get("outboundTag")
                .and_then(Value::as_str)
                .is_some_and(|tag| matches!(tag, "direct" | "block") || proxy_tags.contains(tag));
            let balancer_ok = object
                .get("balancerTag")
                .and_then(Value::as_str)
                .is_some_and(|tag| balancer_tags.contains(tag));
            if !outbound_ok && !balancer_ok {
                return None;
            }

            // `allow_lan` remains a client policy. Do not let a subscription
            // silently turn it on with RFC1918/link-local direct routes.
            if object.get("outboundTag").and_then(Value::as_str) == Some("direct")
                && object
                    .get("ip")
                    .and_then(Value::as_array)
                    .is_some_and(|items| items.iter().any(is_local_route_selector))
            {
                return None;
            }
            Some(rule.clone())
        })
        .collect()
}

fn is_external_route_selector(value: &Value) -> bool {
    value.as_str().is_some_and(|raw| {
        let raw = raw.to_ascii_lowercase();
        raw.starts_with("geoip:") || raw.starts_with("ext:") || raw.starts_with("ext-ip:")
    })
}

fn is_local_route_selector(value: &Value) -> bool {
    let Some(raw) = value.as_str() else {
        return true;
    };
    if raw.eq_ignore_ascii_case("geoip:private") {
        return true;
    }
    let address = raw.split('/').next().unwrap_or(raw);
    address
        .parse::<IpAddr>()
        .is_ok_and(|address| !is_safe_remote_dns_ip(address))
}

fn apply_provider_routing_options(server: &VlessServer, routing: &mut Value) {
    let Some(provider) = server
        .raw_profile
        .as_ref()
        .and_then(|profile| profile.get("routing"))
    else {
        return;
    };
    if let Some(strategy) = provider
        .get("domainStrategy")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "AsIs" | "IPIfNonMatch" | "IPOnDemand"))
    {
        routing["domainStrategy"] = json!(strategy);
    }
    if let Some(matcher) = provider
        .get("domainMatcher")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "linear" | "hybrid"))
    {
        routing["domainMatcher"] = json!(matcher);
    }
}

fn profile_plan(server: &VlessServer) -> Result<Option<OutboundPlan>, String> {
    let Some(profile) = server.raw_profile.as_ref() else {
        return Ok(None);
    };
    let proxies = provider_proxy_outbounds(profile)?;
    let routing = profile.get("routing").and_then(Value::as_object);
    let balancers = routing
        .and_then(|routing| routing.get("balancers"))
        .filter(|balancers| balancers.as_array().is_some_and(|items| !items.is_empty()))
        .cloned();
    let composite = proxies.len() > 1
        || balancers.is_some()
        || profile.get("observatory").is_some()
        || profile.get("burstObservatory").is_some();
    if !composite {
        return Ok(None);
    }

    let proxy_tags = proxies
        .iter()
        .filter_map(|outbound| outbound.get("tag").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();
    let balancer_tags = balancers
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|balancer| balancer.get("tag").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();

    if let Some(items) = balancers.as_ref().and_then(Value::as_array) {
        for balancer in items {
            let tag = balancer
                .get("tag")
                .and_then(Value::as_str)
                .ok_or_else(|| "profile balancer has no tag".to_string())?;
            let selectors = balancer
                .get("selector")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("profile balancer {tag} has no selectors"))?;
            if selectors.iter().filter_map(Value::as_str).any(|selector| {
                proxy_tags
                    .iter()
                    .any(|proxy_tag| proxy_tag.starts_with(selector))
            }) {
                continue;
            }
            return Err(format!(
                "profile balancer {tag} does not select a proxy outbound"
            ));
        }
    }

    let provider_rules = routing
        .and_then(|routing| routing.get("rules"))
        .and_then(Value::as_array);
    let target = provider_rules
        .into_iter()
        .flatten()
        .rev()
        .find_map(|rule| {
            rule.get("balancerTag")
                .and_then(Value::as_str)
                .filter(|tag| balancer_tags.contains(*tag))
                .map(|tag| ProxyTarget::Balancer(tag.to_string()))
                .or_else(|| {
                    rule.get("outboundTag")
                        .and_then(Value::as_str)
                        .filter(|tag| proxy_tags.contains(*tag))
                        .map(|tag| ProxyTarget::Outbound(tag.to_string()))
                })
        })
        .or_else(|| {
            balancer_tags
                .iter()
                .next()
                .map(|tag| ProxyTarget::Balancer(tag.clone()))
        })
        .unwrap_or_else(|| {
            ProxyTarget::Outbound(
                proxies[0]["tag"]
                    .as_str()
                    .expect("proxy tag inserted")
                    .to_string(),
            )
        });

    Ok(Some(OutboundPlan {
        provider_rules: safe_provider_route_rules(server, &proxies, balancers.as_ref()),
        proxies,
        target,
        balancers,
        observatory: profile.get("observatory").cloned(),
        burst_observatory: profile.get("burstObservatory").cloned(),
    }))
}

fn outbound_plan(server: &VlessServer) -> Result<OutboundPlan, String> {
    if let Some(plan) = profile_plan(server)? {
        return Ok(plan);
    }
    let proxies = vec![build_proxy_outbound(server)];
    Ok(OutboundPlan {
        provider_rules: safe_provider_route_rules(server, &proxies, None),
        proxies,
        target: ProxyTarget::Outbound("proxy".into()),
        balancers: None,
        observatory: None,
        burst_observatory: None,
    })
}

/// Reject configurations that the normalized model would otherwise silently
/// reinterpret. JSON-backed locations keep their exact outbound, so any real
/// proxy protocol supported by the parser can pass through unchanged.
pub fn validate_server(server: &VlessServer) -> Result<(), String> {
    if server.raw_profile.is_some() {
        outbound_plan(server)?;
        return Ok(());
    }
    if let Some(raw_outbound) = server.raw_outbound.as_ref() {
        let protocol = raw_outbound
            .get("protocol")
            .and_then(Value::as_str)
            .ok_or_else(|| "JSON location has no outbound protocol".to_string())?
            .to_ascii_lowercase();
        if !is_proxy_protocol(&protocol) {
            return Err(format!("unsupported proxy protocol in JSON: {protocol}"));
        }
        return Ok(());
    }

    let protocol = server.protocol.to_ascii_lowercase();
    if !is_proxy_protocol(&protocol) {
        return Err(format!("unsupported protocol: {}", server.protocol));
    }

    if protocol == "wireguard" {
        if server.uuid.trim().is_empty() {
            return Err("WireGuard private key is required".into());
        }
        if server.public_key.as_deref().unwrap_or("").trim().is_empty() {
            return Err("WireGuard peer public key is required".into());
        }
        return Ok(());
    }

    let transport = server.transport.to_ascii_lowercase();
    if !matches!(
        transport.as_str(),
        "" | "raw"
            | "tcp"
            | "xhttp"
            | "splithttp"
            | "ws"
            | "websocket"
            | "grpc"
            | "gun"
            | "httpupgrade"
            | "http"
            | "h2"
            | "h3"
            | "kcp"
            | "mkcp"
            | "hysteria"
    ) {
        return Err(format!("unsupported transport: {}", server.transport));
    }
    if protocol == "hysteria"
        && (!matches!(transport.as_str(), "hysteria")
            || !server.security.eq_ignore_ascii_case("tls"))
    {
        return Err("Hysteria2 requires the Hysteria transport with TLS".into());
    }

    Ok(())
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
        "hysteria" => "hysteria",
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
            let mut xs = s
                .raw_params
                .get("extra")
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            if let Some(explicit_path) = &s.path {
                xs.insert("path".into(), json!(explicit_path));
            } else {
                xs.entry("path").or_insert_with(|| json!(path));
            }
            if let Some(explicit_mode) = &s.mode {
                xs.insert("mode".into(), json!(explicit_mode));
            } else {
                xs.entry("mode").or_insert_with(|| json!("auto"));
            }
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
            let svc = s.raw_params.get("serviceName").cloned().unwrap_or_default();
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
        "hysteria" => {
            stream.insert(
                "hysteriaSettings".into(),
                json!({
                    "version": 2,
                    "auth": s.uuid,
                }),
            );
        }
        "tcp" if s.raw_params.get("headerType").map(String::as_str) == Some("http") => {
            // TCP with HTTP header obfuscation (headerType=http) needs a
            // tcpSettings.header so xray frames requests as fake HTTP.
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
    if let Some(outbound) = s.raw_outbound.as_ref() {
        return sanitize_raw_outbound(outbound, false)
            .expect("raw outbound was validated before config generation");
    }

    if s.protocol == "wireguard" {
        let addresses = s
            .raw_params
            .get("localAddress")
            .map(|value| split_list(value))
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| vec!["10.0.0.1/32".into()]);
        let mut peer = serde_json::Map::new();
        peer.insert("endpoint".into(), json!(format!("{}:{}", s.host, s.port)));
        peer.insert(
            "publicKey".into(),
            json!(s.public_key.clone().unwrap_or_default()),
        );
        if let Some(value) = s
            .raw_params
            .get("preSharedKey")
            .filter(|value| !value.is_empty())
        {
            peer.insert("preSharedKey".into(), json!(value));
        }
        let mut settings = serde_json::Map::new();
        settings.insert("secretKey".into(), json!(s.uuid));
        settings.insert("address".into(), json!(addresses));
        settings.insert("peers".into(), json!([Value::Object(peer)]));
        settings.insert("noKernelTun".into(), json!(true));
        if let Some(mtu) = s
            .raw_params
            .get("mtu")
            .and_then(|value| value.parse::<u32>().ok())
        {
            settings.insert("mtu".into(), json!(mtu));
        }
        if let Some(reserved) = s.raw_params.get("reserved") {
            let bytes = reserved
                .split(',')
                .filter_map(|value| value.trim().parse::<u8>().ok())
                .collect::<Vec<_>>();
            if !bytes.is_empty() {
                settings.insert("reserved".into(), json!(bytes));
            }
        }
        settings.insert(
            "domainStrategy".into(),
            json!(s
                .raw_params
                .get("domainStrategy")
                .cloned()
                .unwrap_or_else(|| "ForceIP".into())),
        );
        return json!({
            "tag": "proxy",
            "protocol": "wireguard",
            "settings": Value::Object(settings),
        });
    }

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
        "hysteria" => json!({
            "tag": "proxy",
            "protocol": "hysteria",
            "settings": {
                "version": 2,
                "address": s.host,
                "port": s.port,
            },
            "streamSettings": stream,
        }),
        "http" | "socks" => {
            let mut settings = serde_json::Map::new();
            settings.insert("address".into(), json!(s.host));
            settings.insert("port".into(), json!(s.port));
            if !s.uuid.is_empty() {
                settings.insert("user".into(), json!(s.uuid));
            }
            if let Some(password) = s.password.as_ref().filter(|value| !value.is_empty()) {
                settings.insert("pass".into(), json!(password));
            }
            json!({
                "tag": "proxy",
                "protocol": s.protocol,
                "settings": Value::Object(settings),
                "streamSettings": stream,
            })
        }
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
fn is_safe_remote_dns_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_multicast()
                && !address.is_unspecified()
                && octets != [255, 255, 255, 255]
                && !(octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(address) => {
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_unique_local()
                && !address.is_unicast_link_local()
        }
    }
}

/// Accept DNS endpoints that can be forced through the selected proxy without
/// consulting the host resolver first. Full JSON profiles commonly use plain
/// public DNS (for example `8.8.8.8`) rather than DoH; dropping those settings
/// changes the profile's behaviour and broke otherwise valid Hysteria2 nodes.
///
/// Hostnames and every `+local` scheme stay rejected because bootstrapping them
/// would use Android/Linux system DNS outside Xray. Local, private and special
/// addresses are rejected for the same anti-leak reason.
fn safe_remote_dns_address(raw: &str) -> Option<(String, String, Option<String>)> {
    if let Ok(address) = raw.parse::<IpAddr>() {
        return is_safe_remote_dns_ip(address)
            .then(|| (raw.to_string(), address.to_string(), None));
    }

    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "https" | "tls" | "tcp" | "quic")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let address = url.host_str()?.parse::<IpAddr>().ok()?;
    if !is_safe_remote_dns_ip(address) {
        return None;
    }
    let normalized = url.to_string();
    let probe_url = (url.scheme() == "https").then(|| normalized.clone());
    Some((normalized, address.to_string(), probe_url))
}

fn safe_provider_dns_servers(server: &VlessServer) -> Vec<(Value, String, Option<String>)> {
    let Some(servers) = server
        .raw_profile
        .as_ref()
        .and_then(|profile| profile.get("dns"))
        .and_then(|dns| dns.get("servers"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    servers
        .iter()
        .filter_map(|server| {
            let raw = match server {
                Value::String(address) => address.as_str(),
                Value::Object(object) => object.get("address")?.as_str()?,
                _ => return None,
            };
            let (address, ip, probe_url) = safe_remote_dns_address(raw)?;
            let sanitized = match server {
                Value::String(_) => Value::String(address.clone()),
                Value::Object(object) => {
                    let mut object = object.clone();
                    object.insert("address".into(), Value::String(address.clone()));
                    Value::Object(object)
                }
                _ => unreachable!(),
            };
            Some((sanitized, ip, probe_url))
        })
        .collect()
}

/// Preserve a full JSON profile's public literal-IP DNS endpoints exactly,
/// including ordinary UDP DNS, and force their destination IPs through the
/// selected proxy. Local/system resolvers and hostname-based bootstrap remain
/// excluded so a subscription cannot silently reintroduce a DNS leak.
fn build_dns_plan(server: &VlessServer) -> DnsPlan {
    let mut servers = safe_provider_dns_servers(server);
    if servers.is_empty() {
        servers = DEFAULT_DOH_URLS
            .iter()
            .filter_map(|url| {
                let (url, ip, probe_url) = safe_remote_dns_address(url)?;
                Some((Value::String(url), ip, probe_url))
            })
            .collect();
    }

    let query_strategy = server
        .raw_profile
        .as_ref()
        .and_then(|profile| profile.get("dns"))
        .and_then(|dns| dns.get("queryStrategy"))
        .and_then(Value::as_str)
        .filter(|strategy| {
            matches!(
                *strategy,
                "UseIP" | "UseIPv4" | "UseIPv6" | "UseIPv4v6" | "UseIPv6v4"
            )
        })
        .unwrap_or("UseIPv4");
    let mut upstream_ips = servers
        .iter()
        .map(|(_, ip, _)| ip.clone())
        .collect::<Vec<_>>();
    upstream_ips.sort();
    upstream_ips.dedup();
    let probe_urls = servers
        .iter()
        .filter_map(|(_, _, url)| url.clone())
        .collect::<Vec<_>>();
    let mut config = server
        .raw_profile
        .as_ref()
        .and_then(|profile| profile.get("dns"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    config.remove("clientIp");
    config.insert(
        "servers".into(),
        json!(servers
            .into_iter()
            .map(|(server, _, _)| server)
            .collect::<Vec<_>>()),
    );
    config.insert("queryStrategy".into(), json!(query_strategy));
    DnsPlan {
        config: Value::Object(config),
        upstream_ips,
        probe_urls,
    }
}

pub fn dns_probe_urls(server: &VlessServer) -> Vec<String> {
    build_dns_plan(server).probe_urls
}

/// Build the single inbound that carries system traffic. Connection startup is
/// structural only: synthetic Internet probes are not allowed to reject a
/// valid tunnel or race a composite profile's still-warming balancer.
fn build_inbounds(inbound: CaptureInbound) -> Vec<Value> {
    // routeOnly: the sniffed domain is used for routing (domain rules) but the
    // connection keeps its original destination. This avoids the destination
    // override that can sever the source->process binding the `process` matcher
    // relies on for per-app routing.
    let sniffing = json!({
        "enabled": true,
        "destOverride": ["http", "tls", "quic"],
        "routeOnly": true
    });
    match inbound {
        CaptureInbound::NativeTun => vec![json!({
            "tag": "tun-in",
            "protocol": "tun",
            // Native tun manages ONLY the device (name + mtu). Addressing,
            // routes, DNS redirect and the bypass rules are the helper's job.
            "settings": { "name": TUN_NAME, "mtu": TUN_MTU },
            "sniffing": sniffing,
        })],
        CaptureInbound::ValidationHttp => vec![json!({
            "tag": "validation-in",
            "listen": "127.0.0.1",
            "port": 2081,
            "protocol": "http",
            "settings": {},
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
///   - Android: the per-app split is the VpnService's job (xray's
///     process matcher can't match Android packages), so the xray default is
///     governed by the SITES mode alone.
///   - Desktop: both are xray rules, so the default tunnels everything unless
///     BOTH categories are whitelists (then default direct).
fn build_route_rules(
    split: &SplitInput,
    allow_lan: bool,
    inbound_tag: &str,
    app_split_owner: AppSplitOwner,
    proxy_target: &ProxyTarget,
    dns_upstream_ips: &[String],
    provider_rules: &[Value],
) -> Vec<Value> {
    let apps_selective = split.apps_selective();
    let sites_selective = split.sites_selective();
    let app_split_in_vpn_service = matches!(app_split_owner, AppSplitOwner::VpnService);
    let apps_use_proxy = apps_selective;
    let sites_use_proxy = sites_selective;
    let default_uses_proxy = if app_split_in_vpn_service {
        !sites_selective
    } else if apps_selective {
        // Selective apps mode = ONLY the listed apps use the VPN; everything else
        // (e.g. a game that isn't in the list) stays DIRECT. The apps choice owns
        // the default. (Previously this defaulted to "proxy" unless the sites mode
        // was ALSO selective, so non-listed apps wrongly went through the VPN.)
        false
    } else {
        true
    };

    let mut rules = Vec::new();

    // 1. Hijack app DNS (:53) into xray's DNS module.
    rules.push(
        json!({ "type": "field", "inboundTag": [inbound_tag], "port": 53, "outboundTag": "dns-out" }),
    );

    // 2. Keep LAN/private traffic direct when allowed.
    if allow_lan {
        rules.push(json!({ "type": "field", "ip": PRIVATE_CIDRS, "outboundTag": "direct" }));
    }

    // 3. Per-app split (desktop only): native process matcher. On Android the
    //    VpnService gates which apps reach xray at all, so package names here
    //    wouldn't match anyway.
    if !app_split_in_vpn_service {
        for app in split.enabled_apps() {
            let mut rule = json!({ "type": "field", "process": [app] });
            if apps_use_proxy {
                proxy_target.apply(&mut rule);
            } else {
                rule["outboundTag"] = json!("direct");
            }
            rules.push(rule);
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
        let mut rule = json!({ "type": "field", "domain": domains });
        if sites_use_proxy {
            proxy_target.apply(&mut rule);
        } else {
            rule["outboundTag"] = json!("direct");
        }
        rules.push(rule);
    }

    // 5. Keep safe non-site policy from a full provider profile. Site and app
    //    matching remains exclusively owned by Varmlen's split controls.
    rules.extend(provider_rules.iter().cloned());

    // 6. Force the DNS module's own encrypted upstreams through the tunnel —
    //    anti-leak even in selective/direct-default mode. BELOW the app/site
    //    rules: the internal resolver connection has no source process, so it
    //    falls through to here, while user traffic that matched an exclusion
    //    above is unaffected.
    let mut doh_rule = json!({ "type": "field", "ip": dns_upstream_ips });
    proxy_target.apply(&mut doh_rule);
    rules.push(doh_rule);

    // 7. Everything else.
    let mut default_rule = json!({ "type": "field", "network": "tcp,udp" });
    if default_uses_proxy {
        proxy_target.apply(&mut default_rule);
    } else {
        default_rule["outboundTag"] = json!("direct");
    }
    rules.push(default_rule);
    rules
}

/// Map the UI log level (debug/warn/error) to xray's vocabulary (xray uses
/// "warning", not "warn").
fn xray_loglevel(level: &str) -> &'static str {
    match level {
        "debug" => "debug",
        "info" => "info",
        "error" => "error",
        "none" => "none",
        _ => "warning",
    }
}

/// Android applications cannot use Xray's Linux `SO_MARK` bypass; attempting
/// it makes every outbound dial fail with EPERM. VpnService excludes this app's
/// UID from capture, so the mark is both invalid and unnecessary there.
fn remove_android_outbound_marks(outbounds: &mut [Value]) {
    for outbound in outbounds {
        let Some(stream) = outbound
            .get_mut("streamSettings")
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        let Some(sockopt) = stream.get_mut("sockopt").and_then(Value::as_object_mut) else {
            continue;
        };
        sockopt.remove("mark");
        if sockopt.is_empty() {
            stream.remove("sockopt");
        }
    }
}

fn build_xray_config_with_inbound(
    server: &VlessServer,
    split: &SplitInput,
    inbound: CaptureInbound,
    app_split_owner: AppSplitOwner,
    allow_lan: bool,
    log_level: &str,
) -> Value {
    let loglevel = xray_loglevel(log_level);
    let OutboundPlan {
        mut proxies,
        target,
        balancers,
        observatory,
        burst_observatory,
        provider_rules,
    } = outbound_plan(server).expect("server was validated before config generation");
    proxies.push(direct_outbound());
    proxies.push(json!({ "tag": "dns-out", "protocol": "dns" }));
    proxies.push(json!({ "tag": "block", "protocol": "blackhole" }));
    if matches!(app_split_owner, AppSplitOwner::VpnService) {
        remove_android_outbound_marks(&mut proxies);
    }

    let dns = build_dns_plan(server);
    let rules = build_route_rules(
        split,
        allow_lan,
        inbound.tag(),
        app_split_owner,
        &target,
        &dns.upstream_ips,
        &provider_rules,
    );
    let mut routing = json!({ "rules": rules });
    apply_provider_routing_options(server, &mut routing);
    if let Some(balancers) = balancers {
        routing["balancers"] = balancers;
    }
    let mut config = json!({
        "log": { "loglevel": loglevel },
        "dns": dns.config,
        "inbounds": build_inbounds(inbound),
        "outbounds": proxies,
        "routing": routing
    });
    if let Some(observatory) = observatory {
        config["observatory"] = observatory;
    }
    if let Some(burst_observatory) = burst_observatory {
        config["burstObservatory"] = burst_observatory;
    }
    config
}

/// Full native-TUN Xray config for a connection.
pub fn build_xray_config(
    server: &VlessServer,
    split: &SplitInput,
    app_split_owner: AppSplitOwner,
    allow_lan: bool,
    log_level: &str,
) -> Value {
    build_xray_config_with_inbound(
        server,
        split,
        CaptureInbound::NativeTun,
        app_split_owner,
        allow_lan,
        log_level,
    )
}

/// Device-free equivalent used to validate transport/routing JSON before
/// touching kernel/OS network state (desktop `xray run -test`, and the
/// Android preflight check run before a candidate config is ever allowed to
/// replace the active tunnel).
pub fn build_xray_validation_config(
    server: &VlessServer,
    split: &SplitInput,
    app_split_owner: AppSplitOwner,
    allow_lan: bool,
    log_level: &str,
) -> Value {
    build_xray_config_with_inbound(
        server,
        split,
        CaptureInbound::ValidationHttp,
        app_split_owner,
        allow_lan,
        log_level,
    )
}

/// Native-TUN config for Android. Xray's structural preflight remains mandatory,
/// but connection startup is not gated on a synthetic destination or on a
/// composite profile's observatory/balancer having warmed up.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn build_android_xray_config(
    server: &VlessServer,
    split: &SplitInput,
    allow_lan: bool,
    log_level: &str,
) -> Value {
    build_xray_config_with_inbound(
        server,
        split,
        CaptureInbound::NativeTun,
        AppSplitOwner::VpnService,
        allow_lan,
        log_level,
    )
}

/// Device-free Android preflight. It differs from the active config only in
/// the system-data inbound and validates transport/routing without dialing.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn build_android_validation_config(
    server: &VlessServer,
    split: &SplitInput,
    allow_lan: bool,
    log_level: &str,
) -> Value {
    build_xray_config_with_inbound(
        server,
        split,
        CaptureInbound::ValidationHttp,
        AppSplitOwner::VpnService,
        allow_lan,
        log_level,
    )
}

/// Number of concrete proxy paths represented by one UI location. Composite
/// JSON profiles can contain several outbounds behind a provider balancer.
pub fn ping_proxy_count(server: &VlessServer) -> Result<usize, String> {
    Ok(outbound_plan(server)?.proxies.len())
}

/// Minimal per-location latency configuration. Each concrete proxy gets its own
/// loopback HTTP inbound, so callers can probe all variants concurrently and
/// report the fastest healthy path. Keeping the provider observatory out avoids
/// waiting for its cold multi-sample schedule on every manual ping.
pub fn build_ping_config(server: &VlessServer, http_ports: &[u16]) -> Result<Value, String> {
    let mut plan = outbound_plan(server)?;
    if http_ports.len() != plan.proxies.len() {
        return Err(format!(
            "ping config needs {} HTTP ports, got {}",
            plan.proxies.len(),
            http_ports.len()
        ));
    }

    let mut inbounds = Vec::with_capacity(http_ports.len());
    let mut rules = Vec::with_capacity(http_ports.len());
    for (index, (proxy, port)) in plan.proxies.iter().zip(http_ports).enumerate() {
        let proxy_tag = proxy
            .get("tag")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("ping proxy {index} has no tag"))?;
        let inbound_tag = format!("http-in-{index}");
        inbounds.push(json!({
            "tag": inbound_tag,
            "listen": "127.0.0.1",
            "port": port,
            "protocol": "http",
            "settings": {}
        }));
        rules.push(json!({
            "type": "field",
            "inboundTag": [inbound_tag],
            "network": "tcp,udp",
            "outboundTag": proxy_tag
        }));
    }

    let mut proxies = std::mem::take(&mut plan.proxies);
    proxies.push(json!({ "tag": "direct", "protocol": "freedom" }));
    Ok(json!({
        "log": { "loglevel": "warning" },
        "inbounds": inbounds,
        "outbounds": proxies,
        "routing": { "rules": rules }
    }))
}

// --- Tauri command ----------------------------------------------------------

/// Build and pretty-print the xray config JSON for inspection / launch.
#[tauri::command]
pub fn generate_xray_config(
    server: VlessServer,
    split: SplitInput,
    allow_lan: bool,
) -> Result<String, String> {
    validate_server(&server)?;
    let cfg = build_xray_config(&server, &split, AppSplitOwner::Xray, allow_lan, "warning");
    serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::{parse_proxy_uri, parse_subscription};
    use base64::Engine;

    fn split() -> SplitInput {
        SplitInput::default()
    }

    fn assert_bundled_xray_accepts(name: &str, config: &Value) {
        let binary = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("cores/xray");
        if !binary.is_file() {
            return;
        }
        let path =
            std::env::temp_dir().join(format!("varmlen-xray-{name}-{}.json", std::process::id()));
        std::fs::write(&path, serde_json::to_vec(config).unwrap()).unwrap();
        let output = std::process::Command::new(binary)
            .args(["run", "-test", "-c"])
            .arg(&path)
            .output()
            .unwrap();
        let _ = std::fs::remove_file(path);
        assert!(
            output.status.success(),
            "bundled Xray rejected {name}:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn editor_catalog_covers_every_remote_proxy_builder() {
        let catalog = location_editor_options();
        let values = catalog
            .protocols
            .iter()
            .map(|choice| choice.value)
            .collect::<Vec<_>>();
        assert_eq!(values, PROXY_PROTOCOLS);
    }

    #[test]
    fn normalized_editor_locations_build_every_catalogued_protocol() {
        for protocol in PROXY_PROTOCOLS {
            let mut server = parse_proxy_uri("vless://user@1.2.3.4:443?security=tls#X").unwrap();
            server.protocol = (*protocol).into();
            server.password = Some("password".into());
            server.method = Some("aes-128-gcm".into());
            if *protocol == "hysteria" {
                server.transport = "hysteria".into();
                server.security = "tls".into();
            }
            if *protocol == "wireguard" {
                server.transport = "wireguard".into();
                server.security = "none".into();
                server.public_key = Some("peer-public-key".into());
                server
                    .raw_params
                    .insert("localAddress".into(), "10.0.0.2/32".into());
            }
            validate_server(&server)
                .unwrap_or_else(|error| panic!("{protocol} editor server was rejected: {error}"));
            assert_eq!(build_proxy_outbound(&server)["protocol"], *protocol);
        }
    }

    #[test]
    fn bundled_xray_accepts_every_normalized_editor_protocol() {
        let binary = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("cores/xray");
        if !binary.is_file() {
            eprintln!("skipping bundled-core validation: {}", binary.display());
            return;
        }
        for (index, protocol) in PROXY_PROTOCOLS.iter().enumerate() {
            let mut server = parse_proxy_uri(
                "vless://00000000-0000-0000-0000-000000000001@1.2.3.4:443?security=tls#X",
            )
            .unwrap();
            server.protocol = (*protocol).into();
            server.password = Some("password".into());
            server.method = Some("aes-128-gcm".into());
            if *protocol == "hysteria" {
                server.transport = "hysteria".into();
                server.security = "tls".into();
            }
            if *protocol == "wireguard" {
                server.transport = "wireguard".into();
                server.security = "none".into();
                server.uuid = "YIcaWkA56gVeK1dnyfRIzNV0k27oiDI9TzO/7xN3eGo=".into();
                server.public_key = Some("bmXOC+F1gL3ngBz8y9NFmO9d2qO/kMaE+YjYQ5kL9jM=".into());
                server
                    .raw_params
                    .insert("localAddress".into(), "10.0.0.2/32".into());
            }
            let config = build_ping_config(&server, &[31_000 + index as u16]).unwrap();
            let path = std::env::temp_dir().join(format!(
                "varmlen-xray-editor-{}-{protocol}.json",
                std::process::id()
            ));
            std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
            let output = std::process::Command::new(&binary)
                .args(["run", "-test", "-c"])
                .arg(&path)
                .output()
                .unwrap();
            let _ = std::fs::remove_file(&path);
            assert!(
                output.status.success(),
                "{protocol} config rejected by bundled Xray:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
        }
    }

    fn rule_for<'a>(cfg: &'a Value, key: &str) -> Option<&'a Value> {
        cfg["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r.get(key).is_some())
    }

    fn estonia_profile_server() -> VlessServer {
        let proxy = |tag: &str, address: &str, port: u16, network: &str| {
            json!({
                "tag": tag,
                "protocol": "vless",
                "settings": {
                    "address": address,
                    "port": port,
                    "id": "00000000-0000-0000-0000-000000000001",
                    "encryption": "none"
                },
                "streamSettings": {
                    "network": network,
                    "security": "reality",
                    "realitySettings": {
                        "serverName": "example.com",
                        "publicKey": "public",
                        "shortId": "01"
                    }
                }
            })
        };
        let profile = json!({
            "remarks": "Estonia",
            "dns": {"servers": ["8.8.8.8"]},
            "inbounds": [{"tag": "provider-in", "protocol": "socks", "port": 1080}],
            "outbounds": [
                proxy("proxy", "edge-a.example", 6436, "raw"),
                proxy("proxy-2", "edge-b.example", 6436, "raw"),
                proxy("proxy-3", "edge-b.example", 6437, "grpc"),
                proxy("proxy-4", "edge-b.example", 443, "xhttp"),
                proxy("proxy-5", "edge-c.example", 6436, "raw"),
                proxy("proxy-6", "edge-c.example", 6437, "grpc"),
                proxy("proxy-7", "edge-c.example", 443, "xhttp"),
                {"tag": "direct", "protocol": "freedom"},
                {"tag": "block", "protocol": "blackhole"}
            ],
            "routing": {
                "balancers": [{
                    "tag": "estonia-balancer",
                    "selector": ["proxy"],
                    "strategy": {"type": "leastPing"},
                    "fallbackTag": "proxy"
                }],
                "rules": [
                    {"type": "field", "protocol": ["bittorrent"], "outboundTag": "direct"},
                    {"type": "field", "network": "tcp,udp", "balancerTag": "estonia-balancer"}
                ]
            },
            "burstObservatory": {
                "subjectSelector": ["proxy"],
                "pingConfig": {
                    "destination": "https://example.com/generate_204",
                    "interval": "1m",
                    "timeout": "5s",
                    "sampling": 3
                }
            }
        });
        parse_subscription(&profile.to_string()).remove(0)
    }

    #[test]
    fn multi_outbound_profile_keeps_balancer_and_varmlen_policy() {
        let server = estonia_profile_server();
        let cfg = build_xray_config(&server, &split(), AppSplitOwner::Xray, false, "warning");

        let proxy_outbounds = cfg["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|outbound| outbound["protocol"] == "vless")
            .collect::<Vec<_>>();
        assert_eq!(proxy_outbounds.len(), 7);
        assert!(proxy_outbounds
            .iter()
            .all(|outbound| outbound["streamSettings"]["sockopt"]["mark"] == XRAY_DIAL_MARK));
        assert_eq!(cfg["routing"]["balancers"][0]["tag"], "estonia-balancer");
        assert_eq!(
            cfg["routing"]["rules"].as_array().unwrap().last().unwrap()["balancerTag"],
            "estonia-balancer"
        );
        let dns_rule = cfg["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| {
                rule["ip"]
                    .as_array()
                    .is_some_and(|ips| ips.iter().any(|ip| ip == "8.8.8.8"))
            })
            .unwrap();
        assert_eq!(dns_rule["balancerTag"], "estonia-balancer");
        assert!(cfg.get("burstObservatory").is_some());
        assert_eq!(cfg["dns"]["servers"][0], "8.8.8.8");
        assert!(cfg["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |rule| rule["protocol"] == json!(["bittorrent"]) && rule["outboundTag"] == "direct"
            ));
        assert!(cfg["inbounds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|inbound| inbound["tag"] != "provider-in"));
    }

    #[test]
    fn wireguard_profile_is_not_given_forbidden_stream_settings() {
        let profile = json!({
            "remarks": "WireGuard",
            "outbounds": [{
                "tag": "proxy",
                "protocol": "wireguard",
                "settings": {
                    "secretKey": "secret",
                    "address": ["10.0.0.2/32"],
                    "peers": [{"publicKey": "public", "endpoint": "wg.example:2408"}]
                }
            }]
        });
        let server = parse_subscription(&profile.to_string()).remove(0);
        let cfg = build_xray_config(&server, &split(), AppSplitOwner::Xray, false, "warning");

        assert_eq!(cfg["outbounds"][0]["protocol"], "wireguard");
        assert!(cfg["outbounds"][0].get("streamSettings").is_none());
    }

    #[test]
    fn vless_reality_xhttp_outbound() {
        let s = parse_proxy_uri(
            "vless://16ddb21e-5342-4a82-a870-1038b01b8dbc@46.29.238.157:443?type=xhttp&security=reality&encryption=none&sni=gateway.icloud.com&fp=firefox&pbk=PUBKEY&sid=SID&spx=%2F&path=%2F&mode=packet-up#NO",
        )
        .expect("parse");
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");

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
    fn json_location_reuses_provider_outbound_but_not_provider_policy() {
        let body = r#"{
          "remarks": "Germany",
          "dns": {"servers": ["https://resolver.invalid/dns-query"]},
          "routing": {"rules": [{"outboundTag": "provider-direct"}]},
          "outbounds": [{
            "tag": "provider-proxy",
            "protocol": "vless",
            "settings": {
              "vnext": [{
                "address": "de.example.com",
                "port": 443,
                "users": [{"id": "uuid"}]
              }]
            },
            "streamSettings": {
              "network": "xhttp",
              "security": "none",
              "xhttpSettings": {
                "path": "/",
                "mode": "packet-up",
                "xmux": {"hKeepAlivePeriod": 15}
              }
            }
          }]
        }"#;
        let server = parse_subscription(body).remove(0);
        let cfg = build_xray_config(&server, &split(), AppSplitOwner::Xray, false, "warning");
        let proxy = &cfg["outbounds"][0];
        assert_eq!(proxy["tag"], "proxy");
        assert_eq!(
            proxy["streamSettings"]["xhttpSettings"]["xmux"]["hKeepAlivePeriod"],
            15
        );
        assert_eq!(proxy["streamSettings"]["sockopt"]["mark"], XRAY_DIAL_MARK);
        assert_eq!(cfg["dns"]["servers"][0], "https://1.1.1.1/dns-query");
        assert!(cfg["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|rule| rule["outboundTag"] != "provider-direct"));
    }

    #[test]
    fn full_hysteria_profile_keeps_safe_dns_and_non_site_policy() {
        let body = json!({
            "remarks": "Hysteria2",
            "dns": {
                "queryStrategy": "UseIPv4",
                "clientIp": "203.0.113.10",
                "servers": [
                    {
                        "address": "localhost",
                        "domains": ["domain:ru"],
                        "skipFallback": true
                    },
                    "https://9.9.9.9/dns-query"
                ]
            },
            "inbounds": [{"tag": "provider-socks", "protocol": "socks", "port": 10808}],
            "outbounds": [
                {
                    "tag": "proxy",
                    "protocol": "hysteria",
                    "settings": {
                        "version": 2,
                        "address": "hy.example",
                        "port": 443
                    },
                    "streamSettings": {
                        "network": "hysteria",
                        "security": "tls",
                        "hysteriaSettings": {"version": 2, "auth": "secret"},
                        "tlsSettings": {"serverName": "hy.example", "alpn": ["h3"]},
                        "finalmask": {"quicParams": {"debug": false, "congestion": "bbr"}}
                    }
                },
                {"tag": "direct", "protocol": "freedom"},
                {"tag": "block", "protocol": "blackhole"}
            ],
            "routing": {
                "domainStrategy": "AsIs",
                "rules": [
                    {"type": "field", "protocol": ["bittorrent"], "outboundTag": "direct"},
                    {"type": "field", "ip": ["8.8.8.8"], "outboundTag": "proxy"},
                    {"type": "field", "ip": ["geoip:ru"], "outboundTag": "direct"},
                    {"type": "field", "port": "25", "outboundTag": "block"},
                    {"type": "field", "ip": ["192.168.0.0/16"], "outboundTag": "direct"},
                    {"type": "field", "domain": ["domain:ru"], "outboundTag": "direct"},
                    {"type": "field", "network": "tcp,udp", "outboundTag": "proxy"}
                ]
            }
        });
        let server = parse_subscription(&body.to_string()).remove(0);
        let cfg = build_android_xray_config(&server, &split(), false, "warning");

        assert_eq!(cfg["dns"]["servers"], json!(["https://9.9.9.9/dns-query"]));
        assert_eq!(cfg["dns"]["queryStrategy"], "UseIPv4");
        assert!(cfg["dns"].get("clientIp").is_none());
        assert_eq!(cfg["routing"]["domainStrategy"], "AsIs");
        assert_eq!(dns_probe_urls(&server), vec!["https://9.9.9.9/dns-query"]);
        assert_eq!(
            cfg["outbounds"][0]["streamSettings"]["finalmask"]["quicParams"]["congestion"],
            "bbr"
        );

        let inbounds = cfg["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["tag"], "tun-in");
        assert_eq!(inbounds[0]["protocol"], "tun");

        let rules = cfg["routing"]["rules"].as_array().unwrap();
        assert!(rules.iter().any(|rule| {
            rule["protocol"] == json!(["bittorrent"]) && rule["outboundTag"] == "direct"
        }));
        assert!(rules.iter().all(|rule| rule.get("domain").is_none()));
        assert!(rules
            .iter()
            .any(|rule| rule["ip"] == json!(["8.8.8.8"]) && rule["outboundTag"] == "proxy"));
        assert!(rules.iter().all(|rule| rule["ip"] != json!(["geoip:ru"])));
        assert!(rules
            .iter()
            .any(|rule| rule["port"] == "25" && rule["outboundTag"] == "block"));
        assert!(rules
            .iter()
            .all(|rule| rule["ip"] != json!(["192.168.0.0/16"])));
        assert!(rules
            .iter()
            .any(|rule| { rule["ip"] == json!(["9.9.9.9"]) && rule["outboundTag"] == "proxy" }));
        assert_eq!(rules.last().unwrap()["outboundTag"], "proxy");
        let validation = build_xray_validation_config(
            &server,
            &split(),
            AppSplitOwner::VpnService,
            false,
            "warning",
        );
        assert_bundled_xray_accepts("hysteria-provider-dns", &validation);
    }

    #[test]
    fn provider_plain_dns_is_preserved_and_forced_through_proxy() {
        let body = json!({
            "remarks": "Unsafe DNS",
            "dns": {
                "clientIp": "198.51.100.4",
                "servers": [
                    "localhost",
                    "8.8.8.8",
                    "8.8.4.4",
                    "https+local://1.1.1.1/dns-query",
                    "https://192.168.1.1/dns-query"
                ]
            },
            "outbounds": [{
                "tag": "proxy",
                "protocol": "vless",
                "settings": {"address": "vpn.example", "port": 443, "id": "uuid"}
            }]
        });
        let server = parse_subscription(&body.to_string()).remove(0);
        let cfg = build_android_xray_config(&server, &split(), false, "warning");

        assert_eq!(
            cfg["dns"]["servers"],
            json!(["8.8.8.8", "8.8.4.4"])
        );
        assert!(cfg["dns"].get("clientIp").is_none());
        assert!(dns_probe_urls(&server).is_empty());
        assert!(cfg["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|rule| {
                rule["ip"] == json!(["8.8.4.4", "8.8.8.8"])
                    && rule["outboundTag"] == "proxy"
            }));
    }

    #[test]
    fn json_location_rejects_local_certificate_and_key_files() {
        let body = r#"{
          "remarks": "Unsafe",
          "outbounds": [{
            "tag": "proxy",
            "protocol": "vless",
            "settings": {"vnext": [{"address": "vpn.example", "port": 443,
              "users": [{"id": "uuid"}]}]},
            "streamSettings": {"security": "tls", "tlsSettings": {
              "certificates": [{"certificateFile": "/sdcard/provider.pem",
                "keyFile": "/sdcard/provider.key"}]
            }}
          }]
        }"#;
        let server = parse_subscription(body).remove(0);
        assert!(validate_server(&server)
            .unwrap_err()
            .contains("may not reference local files"));
    }

    #[test]
    fn tcp_reality_vision_keeps_flow() {
        let s = parse_proxy_uri(
            "vless://uuid-1@1.2.3.4:443?type=tcp&security=reality&flow=xtls-rprx-vision&sni=icloud.com&pbk=K&sid=ab&fp=chrome#X",
        )
        .expect("parse");
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
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
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
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
    fn proxen_xhttp_extra_preserves_mode_and_xmux() {
        let ss = stream_for(concat!(
            "vless://u@1.2.3.4:443?type=xhttp&security=reality&pbk=K",
            "&extra=%7B%22mode%22%3A%22packet-up%22%2C%22xmux%22%3A%7B",
            "%22maxConcurrency%22%3A1%2C%22hKeepAlivePeriod%22%3A30%7D%7D#P"
        ));
        assert_eq!(ss["xhttpSettings"]["mode"], "packet-up");
        assert_eq!(ss["xhttpSettings"]["xmux"]["maxConcurrency"], 1);
        assert_eq!(ss["xhttpSettings"]["xmux"]["hKeepAlivePeriod"], 30);
    }

    #[test]
    fn unsupported_normalized_protocol_and_transport_are_rejected() {
        let mut server =
            parse_proxy_uri("vless://u@1.2.3.4:443?type=tcp&security=reality&pbk=K#X").unwrap();
        server.protocol = "unknown".into();
        assert!(validate_server(&server)
            .unwrap_err()
            .contains("unsupported protocol"));

        server.protocol = "vless".into();
        server.transport = "unknown-transport".into();
        assert!(validate_server(&server)
            .unwrap_err()
            .contains("unsupported transport"));
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
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
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
    fn android_uses_native_tun_with_vpn_service_app_split() {
        let s = parse_proxy_uri("vless://u@1.2.3.4:443?security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::VpnService, true, "warning");
        let inb = &cfg["inbounds"][0];
        assert_eq!(inb["protocol"], "tun");
        assert!(inb.get("port").is_none());
        // Android still routes captured DNS through Xray's native TUN.
        let dns_rule = rule_for(&cfg, "inboundTag").unwrap();
        assert_eq!(dns_rule["inboundTag"][0], "tun-in");
        assert!(rule_for(&cfg, "process").is_none());
        assert!(cfg["outbounds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|outbound| outbound["streamSettings"]["sockopt"].get("mark").is_none()));
    }

    #[test]
    fn android_startup_config_has_only_the_native_tun_inbound() {
        let server = estonia_profile_server();
        let config = build_android_xray_config(&server, &split(), false, "warning");
        let inbounds = config["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 1);
        assert_eq!(inbounds[0]["tag"], "tun-in");
        assert_eq!(inbounds[0]["protocol"], "tun");
        assert!(config["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|rule| rule["inboundTag"]
                .as_array()
                .is_none_or(|tags| tags.iter().all(|tag| tag != "probe-in"))));
    }

    #[test]
    fn proxy_and_direct_outbounds_carry_dial_mark() {
        let s =
            parse_proxy_uri("vless://u@1.2.3.4:443?type=xhttp&security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
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
    fn ping_config_uses_requested_loopback_port_and_marked_proxy() {
        let s =
            parse_proxy_uri("vless://u@1.2.3.4:443?type=xhttp&security=reality&pbk=K#X").unwrap();
        let cfg = build_ping_config(&s, &[32_000]).unwrap();
        assert_eq!(cfg["inbounds"][0]["listen"], "127.0.0.1");
        assert_eq!(cfg["inbounds"][0]["port"], 32_000);
        assert_eq!(cfg["inbounds"][0]["protocol"], "http");
        assert_eq!(cfg["outbounds"].as_array().unwrap().len(), 2);
        assert_eq!(
            cfg["outbounds"][0]["streamSettings"]["sockopt"]["mark"],
            XRAY_DIAL_MARK
        );
        assert_eq!(cfg["routing"]["rules"][0]["outboundTag"], "proxy");
    }

    #[test]
    fn composite_ping_probes_every_proxy_without_starting_health_checks() {
        let server = estonia_profile_server();
        let ports = (32_000..32_007).collect::<Vec<_>>();
        let cfg = build_ping_config(&server, &ports).unwrap();

        assert_eq!(cfg["inbounds"].as_array().unwrap().len(), 7);
        assert_eq!(cfg["routing"]["rules"].as_array().unwrap().len(), 7);
        assert_eq!(cfg["routing"]["rules"][0]["outboundTag"], "proxy");
        assert_eq!(cfg["routing"]["rules"][1]["outboundTag"], "proxy-2");
        assert_eq!(cfg["routing"]["rules"][6]["outboundTag"], "proxy-7");
        assert!(cfg["routing"].get("balancers").is_none());
        assert!(cfg.get("observatory").is_none());
        assert!(cfg.get("burstObservatory").is_none());
    }

    #[test]
    fn composite_ping_requires_one_port_per_proxy() {
        let server = estonia_profile_server();

        assert!(build_ping_config(&server, &[32_000])
            .unwrap_err()
            .contains("7 HTTP ports"));
    }

    #[test]
    fn dns_routes_through_proxy_no_leak() {
        // Anti-leak: resolver is DoH, classic DNS arriving through the data
        // inbound is handled by dns-out, and no extra loopback listener exists.
        let s =
            parse_proxy_uri("vless://u@1.2.3.4:443?type=xhttp&security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
        assert_eq!(cfg["dns"]["servers"][0], "https://1.1.1.1/dns-query");
        let inbounds = cfg["inbounds"].as_array().unwrap();
        assert_eq!(inbounds.len(), 1);
        assert!(inbounds.iter().all(|inbound| {
            inbound["tag"] != "dns-in" && inbound["protocol"] != "dokodemo-door"
        }));
        let serialized = serde_json::to_string(&cfg).unwrap();
        assert!(!serialized.contains("5353"));
        let dns_hijack = cfg["routing"]["rules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["inboundTag"][0] == "tun-in" && rule["port"].as_u64() == Some(53))
            .expect("TUN DNS routing rule");
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
        let cfg = build_xray_config(&s, &sp, AppSplitOwner::Xray, true, "warning");
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
        let cfg = build_xray_config(&s, &sp, AppSplitOwner::Xray, true, "warning");
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
        let cfg = build_xray_config(&s, &sp, AppSplitOwner::Xray, true, "warning");
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
        let cfg = build_xray_config(&s, &sp, AppSplitOwner::Xray, true, "warning");
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
        let cfg = build_xray_config(&s, &sp, AppSplitOwner::Xray, true, "warning");
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
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
        let out = &cfg["outbounds"][0];
        assert_eq!(out["protocol"], "trojan");
        assert_eq!(out["settings"]["servers"][0]["password"], "secretpass");
        assert_eq!(out["settings"]["servers"][0]["address"], "1.2.3.4");
        assert_eq!(out["streamSettings"]["security"], "tls");
    }

    #[test]
    fn shadowsocks_outbound_shape() {
        let s = parse_proxy_uri("ss://YWVzLTI1Ni1nY206c2VjcmV0@1.2.3.4:8388#S").unwrap();
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
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
        let cfg = build_xray_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
        let out = &cfg["outbounds"][0];
        assert_eq!(out["protocol"], "vmess");
        assert_eq!(out["settings"]["vnext"][0]["users"][0]["id"], "uuid-vm");
        assert_eq!(out["settings"]["vnext"][0]["users"][0]["alterId"], 0);
        assert_eq!(out["streamSettings"]["network"], "ws");
    }

    #[test]
    fn validation_config_uses_http_without_a_tun_device() {
        let s =
            parse_proxy_uri("vless://u@1.2.3.4:443?type=xhttp&security=reality&pbk=K#X").unwrap();
        let cfg = build_xray_validation_config(&s, &split(), AppSplitOwner::Xray, true, "warning");
        assert_eq!(cfg["inbounds"][0]["protocol"], "http");
        assert_eq!(cfg["inbounds"][0]["listen"], "127.0.0.1");
        assert!(cfg["inbounds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["protocol"] != "tun"));
    }
}
