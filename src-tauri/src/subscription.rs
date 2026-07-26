//! Proxy URI and subscription parser.
//!
//! Supports the schemes commonly found in subscriptions:
//! - `vless://<uuid>@<host>:<port>?<params>#<label>`
//! - `trojan://<password>@<host>:<port>?<params>#<label>`
//! - `ss://<base64(method:password)>@<host>:<port>#<label>` (and legacy forms)
//! - `vmess://<base64-json>`
//!
//! Subscription body: either plaintext (one URI per line) or base64-encoded
//! plaintext. Whitespace-only lines and comment lines (`#…`) are ignored.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("invalid URI: {0}")]
    InvalidUri(String),
    #[error("unsupported scheme '{0}'")]
    UnsupportedScheme(String),
    #[error("missing credentials")]
    MissingCredentials,
    #[error("missing host")]
    MissingHost,
    #[error("missing port")]
    MissingPort,
    #[error("auto-select / balancer entry — not a connectable server")]
    BalancerEntry,
}

/// Some providers ship an "auto-select"/balancer entry as a sentinel host (e.g.
/// borealisvpn's `balancer.host`) instead of a real server. The plain-vless
/// subscription doesn't carry the balancer's member list, so these aren't
/// connectable — we drop them rather than show a broken server.
fn is_balancer_sentinel(host: &str) -> bool {
    matches!(host.trim().to_ascii_lowercase().as_str(), "balancer.host")
}

fn default_protocol() -> String {
    "vless".to_string()
}

/// Deserialize `protocol`, tolerating a missing key, an explicit `null`, or an
/// empty string from subscriptions persisted before multi-protocol support —
/// all of which mean the legacy default, vless.
fn de_protocol<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<String> = Option::deserialize(d)?;
    Ok(opt
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_protocol))
}

/// A single VPN endpoint parsed from a proxy URI. The struct keeps its
/// historical name; `protocol` distinguishes vless / trojan / shadowsocks /
/// vmess, and credential fields are filled per-protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VlessServer {
    pub id: String,
    /// Protocol: "vless" | "trojan" | "shadowsocks" | "vmess". Tolerant of
    /// missing/null/empty (legacy data) → defaults to "vless".
    #[serde(default = "default_protocol", deserialize_with = "de_protocol")]
    pub protocol: String,
    /// VLESS/VMess UUID, or Trojan password. Empty for Shadowsocks.
    pub uuid: String,
    /// Shadowsocks/Trojan password (Shadowsocks keeps it separate from method).
    #[serde(default)]
    pub password: Option<String>,
    /// Shadowsocks cipher method.
    #[serde(default)]
    pub method: Option<String>,
    pub host: String,
    pub port: u16,
    pub label: String,
    pub transport: String,
    pub security: String,
    #[serde(default)]
    pub sni: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub short_id: Option<String>,
    #[serde(default)]
    pub flow: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub packet_encoding: Option<String>,
    #[serde(default)]
    pub raw_params: HashMap<String, String>,
}

impl VlessServer {
    fn base(protocol: &str, host: String, port: u16, label: String) -> Self {
        VlessServer {
            id: format!("{host}_{port}"),
            protocol: protocol.to_string(),
            uuid: String::new(),
            password: None,
            method: None,
            host,
            port,
            label,
            transport: "tcp".to_string(),
            security: "none".to_string(),
            sni: None,
            fingerprint: None,
            public_key: None,
            short_id: None,
            flow: None,
            path: None,
            mode: None,
            packet_encoding: None,
            raw_params: HashMap::new(),
        }
    }
}

/// Server-side subscription metadata parsed from HTTP response headers.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SubscriptionMeta {
    /// `Profile-Title` header — used as the subscription display name.
    pub title: Option<String>,
    /// `Profile-Update-Interval` (hours).
    pub update_interval_hours: Option<u32>,
    /// `Subscription-Userinfo`: upload bytes used.
    pub upload_bytes: Option<u64>,
    /// `Subscription-Userinfo`: download bytes used.
    pub download_bytes: Option<u64>,
    /// `Subscription-Userinfo`: total quota in bytes. 0/absent means unlimited
    /// (normalized to None).
    pub total_bytes: Option<u64>,
    /// `Subscription-Userinfo`: expiry as unix seconds. 0/absent means never
    /// (normalized to None).
    pub expires_at_unix: Option<i64>,
    /// Whether a `Subscription-Userinfo` header was present at all. When true,
    /// the header is AUTHORITATIVE: an absent key means "no quota / no expiry"
    /// and stored values must be cleared, not kept. When false (panel doesn't
    /// send userinfo), the client keeps what it knew.
    pub has_userinfo: bool,
    /// `Support-Url` — a human support contact (channel / chat).
    pub support_url: Option<String>,
    /// `Profile-Web-Page-Url` — the provider's bot / web page.
    pub web_page_url: Option<String>,
}

/// Bundled result of an import: headers + parsed servers + free-text
/// description extracted from leading `# …` comments in the body.
#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub meta: SubscriptionMeta,
    pub servers: Vec<VlessServer>,
    pub description: Option<String>,
}

/// Metadata keys that panels (Marzban / Happ-style) inline into the body as
/// `#key: value` lines, duplicating the HTTP response headers. These are NOT
/// human-readable description — they carry client settings — so we route them
/// to metadata and keep them out of the shown description.
fn is_meta_key(key: &str) -> bool {
    matches!(
        key,
        "profile-title"
            | "profile-update-interval"
            | "support-url"
            | "profile-web-page-url"
            | "subscription-userinfo"
            | "announce"
            | "hide-settings"
            | "subscriptions-collapse"
            | "subscriptions-expand-now"
            | "encrypted-subscription"
            | "allow-insecure"
            | "subscription-ping-onopen-enabled"
            | "mux-enable"
            | "mux-tcp-connections"
            | "mux-xudp-connections"
            | "mux-quic"
            | "routing"
            | "dns"
    )
}

/// Parse the leading comment block of a subscription body. Panels prepend two
/// very different things there:
///   1. `#key: value` lines duplicating the HTTP headers (profile-title,
///      subscription-userinfo, mux-*, …) — collected into `headers`.
///   2. Free-text lines (a real human note, or a base64 `announce` banner) —
///      joined into `description`.
///
/// Stops at the first non-comment, non-blank line (the first proxy URI).
pub fn parse_body_meta(body: &str) -> (std::collections::HashMap<String, String>, Option<String>) {
    let text = decode_body(body);
    let mut headers = std::collections::HashMap::new();
    let mut desc_lines = Vec::<String>::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            if headers.is_empty() && desc_lines.is_empty() {
                continue; // skip leading blank lines
            }
            break; // blank line ends the comment block
        }
        let Some(rest) = line.strip_prefix('#') else {
            break; // first real (non-comment) line — stop
        };
        let rest = rest.trim();
        // `#key: value` where key looks like a metadata field → header, not desc.
        if let Some((k, v)) = rest.split_once(':') {
            let key = k.trim().to_ascii_lowercase();
            if is_meta_key(&key) {
                headers.insert(key, v.trim().to_string());
                continue;
            }
        }
        desc_lines.push(rest.to_string());
    }
    let description = if desc_lines.is_empty() {
        None
    } else {
        Some(desc_lines.join("\n"))
    };
    (headers, description)
}

/// Schemes we know how to parse.
pub fn is_supported_uri(line: &str) -> bool {
    let l = line.trim();
    l.starts_with("vless://")
        || l.starts_with("trojan://")
        || l.starts_with("ss://")
        || l.starts_with("vmess://")
}

/// Parse any supported proxy URI, dispatching on its scheme.
pub fn parse_proxy_uri(uri: &str) -> Result<VlessServer, ParseError> {
    let uri = uri.trim();
    let server = if uri.starts_with("vless://") {
        parse_vless(uri)?
    } else if uri.starts_with("trojan://") {
        parse_trojan(uri)?
    } else if uri.starts_with("ss://") {
        parse_shadowsocks(uri)?
    } else if uri.starts_with("vmess://") {
        parse_vmess(uri)?
    } else {
        let scheme = uri.split("://").next().unwrap_or(uri);
        return Err(ParseError::UnsupportedScheme(scheme.to_string()));
    };
    // Drop balancer/auto-select sentinels — they aren't real, connectable servers.
    if is_balancer_sentinel(&server.host) {
        return Err(ParseError::BalancerEntry);
    }
    Ok(server)
}

fn label_from(fragment: Option<&str>, host: &str, port: u16) -> String {
    match fragment {
        Some(f) if !f.is_empty() => percent_decode(f),
        _ => format!("{host}:{port}"),
    }
}

/// Parse JSON-form import input into (display name, servers). Accepts an
/// xray/v2ray config (object with an `outbounds` array), a single outbound
/// object, an array of outbound objects and/or share-link strings, or an object
/// embedding those under common keys (servers/links/proxies/configs/list). The
/// name comes from a top-level `remarks`/`name`/`ps`/`title` field.
pub fn parse_json_subscription(body: &str) -> (Option<String>, Vec<VlessServer>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return (None, Vec::new());
    };
    let name = json_str_any(&v, &["remarks", "name", "ps", "title", "Profile-Title"]);
    let mut out = Vec::new();
    collect_json_servers(&v, &mut out, 0);
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.id.clone()));
    // A single-server config has no per-server label worth showing (the outbound
    // tag is usually just "proxy"), so use the config's own name for it.
    if out.len() == 1 {
        if let Some(n) = &name {
            out[0].label = n.clone();
        }
    }
    (name, out)
}

/// First non-empty string value among `keys` on a JSON object.
fn json_str_any(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn is_proxy_protocol(p: &str) -> bool {
    matches!(p, "vless" | "vmess" | "trojan" | "shadowsocks")
}

fn collect_json_servers(v: &serde_json::Value, out: &mut Vec<VlessServer>, depth: u8) {
    if depth > 6 {
        return;
    }
    match v {
        serde_json::Value::Array(arr) => {
            for el in arr {
                collect_json_servers(el, out, depth + 1);
            }
        }
        serde_json::Value::String(s) => {
            let t = s.trim();
            if is_supported_uri(t) {
                if let Ok(srv) = parse_proxy_uri(t) {
                    out.push(srv);
                }
            }
        }
        serde_json::Value::Object(obj) => {
            // A proxy outbound: { "protocol": "vless", "settings": …, "streamSettings": … }.
            if obj
                .get("protocol")
                .and_then(|p| p.as_str())
                .map(is_proxy_protocol)
                .unwrap_or(false)
            {
                if let Some(s) = parse_outbound(v) {
                    out.push(s);
                }
                return;
            }
            // Otherwise recurse into the common container keys.
            for key in [
                "outbounds",
                "servers",
                "links",
                "proxies",
                "configs",
                "list",
            ] {
                if let Some(child) = obj.get(key) {
                    collect_json_servers(child, out, depth + 1);
                }
            }
        }
        _ => {}
    }
}

fn json_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn json_port(v: Option<&serde_json::Value>) -> Option<u16> {
    match v? {
        serde_json::Value::Number(n) => n.as_u64().and_then(|p| u16::try_from(p).ok()),
        serde_json::Value::String(st) => st.parse().ok(),
        _ => None,
    }
}

/// Map an xray streamSettings `network` back to our transport name (the inverse
/// of `xray::xray_network`).
fn normalize_network(net: &str) -> String {
    match net {
        "raw" | "tcp" => "tcp",
        "splithttp" | "xhttp" => "xhttp",
        "h2" => "http",
        other => other,
    }
    .to_string()
}

/// Build a `VlessServer` from one xray outbound object (inverse of
/// `xray::build_proxy_outbound` + `build_stream_settings`).
fn parse_outbound(ob: &serde_json::Value) -> Option<VlessServer> {
    let protocol = ob.get("protocol")?.as_str()?;
    let settings = ob.get("settings");
    let stream = ob.get("streamSettings");
    let tag = ob.get("tag").and_then(|t| t.as_str()).unwrap_or("");
    let label = |host: &str, port: u16| -> String {
        if !tag.is_empty() && !matches!(tag, "proxy" | "direct" | "block" | "dns-out") {
            tag.to_string()
        } else {
            format!("{host}:{port}")
        }
    };

    let mut s = match protocol {
        "vless" | "vmess" => {
            let vnext = settings?.get("vnext")?.as_array()?.first()?;
            let host = json_str(vnext, "address")?;
            let port = json_port(vnext.get("port"))?;
            let user = vnext.get("users")?.as_array()?.first()?;
            let mut s = VlessServer::base(protocol, host.clone(), port, label(&host, port));
            s.uuid = json_str(user, "id")?;
            s.flow = json_str(user, "flow");
            if protocol == "vmess" {
                if let Some(scy) = json_str(user, "security") {
                    s.raw_params.insert("scy".into(), scy);
                }
                if let Some(aid) = user.get("alterId").and_then(|x| x.as_u64()) {
                    s.raw_params.insert("aid".into(), aid.to_string());
                }
            }
            s
        }
        "trojan" => {
            let srv = settings?.get("servers")?.as_array()?.first()?;
            let host = json_str(srv, "address")?;
            let port = json_port(srv.get("port"))?;
            let pw = json_str(srv, "password")?;
            let mut s = VlessServer::base("trojan", host.clone(), port, label(&host, port));
            s.uuid = pw.clone();
            s.password = Some(pw);
            s.flow = json_str(srv, "flow");
            s
        }
        "shadowsocks" => {
            let srv = settings?.get("servers")?.as_array()?.first()?;
            let host = json_str(srv, "address")?;
            let port = json_port(srv.get("port"))?;
            let mut s = VlessServer::base("shadowsocks", host.clone(), port, label(&host, port));
            s.method = json_str(srv, "method");
            s.password = json_str(srv, "password");
            s
        }
        _ => return None,
    };
    apply_stream(&mut s, stream);
    if is_balancer_sentinel(&s.host) {
        return None;
    }
    Some(s)
}

fn apply_stream(s: &mut VlessServer, stream: Option<&serde_json::Value>) {
    let Some(st) = stream else { return };
    if let Some(net) = st.get("network").and_then(|n| n.as_str()) {
        s.transport = normalize_network(net);
    }
    s.security = st
        .get("security")
        .and_then(|x| x.as_str())
        .unwrap_or("none")
        .to_string();

    if let Some(r) = st.get("realitySettings") {
        s.sni = json_str(r, "serverName");
        s.public_key = json_str(r, "publicKey");
        s.short_id = json_str(r, "shortId");
        s.fingerprint = json_str(r, "fingerprint");
        if let Some(spx) = json_str(r, "spiderX") {
            s.raw_params.insert("spx".into(), spx);
        }
    }
    if let Some(tls) = st.get("tlsSettings") {
        if s.sni.is_none() {
            s.sni = json_str(tls, "serverName");
        }
        if s.fingerprint.is_none() {
            s.fingerprint = json_str(tls, "fingerprint");
        }
        if tls
            .get("allowInsecure")
            .and_then(|x| x.as_bool())
            .unwrap_or(false)
        {
            s.raw_params.insert("allowInsecure".into(), "1".into());
        }
        if let Some(alpn) = tls.get("alpn").and_then(|a| a.as_array()) {
            let list: Vec<String> = alpn
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect();
            if !list.is_empty() {
                s.raw_params.insert("alpn".into(), list.join(","));
            }
        }
    }

    match s.transport.as_str() {
        "ws" => {
            if let Some(ws) = st.get("wsSettings") {
                s.path = json_str(ws, "path");
                if let Some(h) = ws
                    .get("headers")
                    .and_then(|h| h.get("Host"))
                    .and_then(|x| x.as_str())
                {
                    s.raw_params.insert("host".into(), h.into());
                }
            }
        }
        "xhttp" => {
            if let Some(x) = st
                .get("xhttpSettings")
                .or_else(|| st.get("splithttpSettings"))
            {
                s.path = json_str(x, "path");
                s.mode = json_str(x, "mode");
                if let Some(h) = json_str(x, "host") {
                    s.raw_params.insert("host".into(), h);
                }
            }
        }
        "httpupgrade" => {
            if let Some(hu) = st.get("httpupgradeSettings") {
                s.path = json_str(hu, "path");
                if let Some(h) = json_str(hu, "host") {
                    s.raw_params.insert("host".into(), h);
                }
            }
        }
        "grpc" => {
            if let Some(g) = st.get("grpcSettings") {
                if let Some(svc) = json_str(g, "serviceName") {
                    s.raw_params.insert("serviceName".into(), svc);
                }
                if g.get("multiMode")
                    .and_then(|m| m.as_bool())
                    .unwrap_or(false)
                {
                    s.mode = Some("multi".into());
                }
                if let Some(auth) = json_str(g, "authority") {
                    s.raw_params.insert("authority".into(), auth);
                }
            }
        }
        _ => {}
    }
}

/// Parse a single `vless://` URI.
pub fn parse_vless(uri: &str) -> Result<VlessServer, ParseError> {
    let url = Url::parse(uri.trim()).map_err(|e| ParseError::InvalidUri(e.to_string()))?;
    if url.scheme() != "vless" {
        return Err(ParseError::UnsupportedScheme(url.scheme().to_string()));
    }

    let uuid = url.username();
    if uuid.is_empty() {
        return Err(ParseError::MissingCredentials);
    }
    let uuid = percent_decode(uuid);

    let host = url.host_str().ok_or(ParseError::MissingHost)?.to_string();
    let port = url.port().ok_or(ParseError::MissingPort)?;

    let params: HashMap<String, String> = url
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

    let mut s = VlessServer::base(
        "vless",
        host.clone(),
        port,
        label_from(url.fragment(), &host, port),
    );
    s.uuid = uuid;
    s.transport = params
        .get("type")
        .cloned()
        .unwrap_or_else(|| "tcp".to_string());
    s.security = params
        .get("security")
        .cloned()
        .unwrap_or_else(|| "none".to_string());
    s.sni = params.get("sni").cloned();
    s.fingerprint = params.get("fp").cloned();
    s.public_key = params.get("pbk").cloned();
    s.short_id = params.get("sid").cloned();
    s.flow = params.get("flow").cloned();
    s.path = params.get("path").cloned();
    s.mode = params.get("mode").cloned();
    s.packet_encoding = params.get("packetEncoding").cloned();
    s.raw_params = params;
    Ok(s)
}

/// Parse a single `trojan://<password>@<host>:<port>?<params>#<label>` URI.
pub fn parse_trojan(uri: &str) -> Result<VlessServer, ParseError> {
    let url = Url::parse(uri.trim()).map_err(|e| ParseError::InvalidUri(e.to_string()))?;
    if url.scheme() != "trojan" {
        return Err(ParseError::UnsupportedScheme(url.scheme().to_string()));
    }
    let password = percent_decode(url.username());
    if password.is_empty() {
        return Err(ParseError::MissingCredentials);
    }
    let host = url.host_str().ok_or(ParseError::MissingHost)?.to_string();
    let port = url.port().ok_or(ParseError::MissingPort)?;
    let params: HashMap<String, String> = url
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

    let mut s = VlessServer::base(
        "trojan",
        host.clone(),
        port,
        label_from(url.fragment(), &host, port),
    );
    s.uuid = password.clone();
    s.password = Some(password);
    s.transport = params
        .get("type")
        .cloned()
        .unwrap_or_else(|| "tcp".to_string());
    s.security = params
        .get("security")
        .cloned()
        .unwrap_or_else(|| "tls".to_string());
    s.sni = params.get("sni").cloned();
    s.fingerprint = params.get("fp").cloned();
    s.path = params.get("path").cloned();
    // Trojan can also run over REALITY/vision — capture those fields too.
    s.public_key = params.get("pbk").cloned();
    s.short_id = params.get("sid").cloned();
    s.flow = params.get("flow").cloned();
    s.mode = params.get("mode").cloned();
    s.raw_params = params;
    Ok(s)
}

/// Parse a Shadowsocks `ss://` URI. Handles SIP002 (base64 userinfo) and the
/// legacy fully-base64 form, with or without a trailing `?plugin=…`.
pub fn parse_shadowsocks(uri: &str) -> Result<VlessServer, ParseError> {
    let rest = uri.trim().strip_prefix("ss://").unwrap_or("");
    // Split off the #fragment label.
    let (main, fragment) = match rest.split_once('#') {
        Some((m, f)) => (m, Some(f)),
        None => (rest, None),
    };
    // Drop any ?plugin=… query.
    let main = main.split('?').next().unwrap_or(main);

    // Two layouts: "userinfo@host:port" or base64("method:password@host:port").
    let (creds, hostport) = if let Some((u, hp)) = main.rsplit_once('@') {
        // userinfo may itself be base64(method:password).
        let decoded = b64_decode_str(u).unwrap_or_else(|| percent_decode(u));
        (decoded, hp.to_string())
    } else {
        // Whole thing is base64.
        let decoded =
            b64_decode_str(main).ok_or_else(|| ParseError::InvalidUri("ss base64".into()))?;
        let (u, hp) = decoded.rsplit_once('@').ok_or(ParseError::MissingHost)?;
        (u.to_string(), hp.to_string())
    };

    let (method, password) = creds
        .split_once(':')
        .ok_or(ParseError::MissingCredentials)?;
    let (host, port_str) = hostport.rsplit_once(':').ok_or(ParseError::MissingPort)?;
    let port: u16 = port_str.parse().map_err(|_| ParseError::MissingPort)?;
    let host = host.trim_matches(['[', ']']).to_string();

    let mut s = VlessServer::base(
        "shadowsocks",
        host.clone(),
        port,
        label_from(fragment, &host, port),
    );
    s.method = Some(method.to_string());
    s.password = Some(password.to_string());
    Ok(s)
}

/// Parse a `vmess://<base64-json>` URI (the common v2rayN JSON form).
pub fn parse_vmess(uri: &str) -> Result<VlessServer, ParseError> {
    let payload = uri.trim().strip_prefix("vmess://").unwrap_or("");
    let json =
        b64_decode_str(payload).ok_or_else(|| ParseError::InvalidUri("vmess base64".into()))?;
    let v: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| ParseError::InvalidUri(e.to_string()))?;

    let host = v
        .get("add")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if host.is_empty() {
        return Err(ParseError::MissingHost);
    }
    // port may be a number or a string — validate the range instead of casting
    // (a bare `as u16` silently wraps 65616 -> 80).
    let port: u16 = match v.get("port") {
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .filter(|p| (1..=65535).contains(p))
            .ok_or(ParseError::MissingPort)? as u16,
        Some(serde_json::Value::String(st)) => st.parse().map_err(|_| ParseError::MissingPort)?,
        _ => return Err(ParseError::MissingPort),
    };
    if port == 0 {
        return Err(ParseError::MissingPort);
    }
    let uuid = v
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if uuid.is_empty() {
        return Err(ParseError::MissingCredentials);
    }
    let ps = v.get("ps").and_then(|x| x.as_str()).map(|s| s.to_string());

    let mut s = VlessServer::base(
        "vmess",
        host.clone(),
        port,
        ps.unwrap_or_else(|| format!("{host}:{port}")),
    );
    s.uuid = uuid;
    let net = v
        .get("net")
        .and_then(|x| x.as_str())
        .unwrap_or("tcp")
        .to_string();
    s.transport = net.clone();
    s.security = match v.get("tls").and_then(|x| x.as_str()) {
        Some("tls") => "tls".to_string(),
        Some("reality") => "reality".to_string(),
        _ => "none".to_string(),
    };
    s.sni = v.get("sni").and_then(|x| x.as_str()).map(|s| s.to_string());
    s.path = v
        .get("path")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    s.fingerprint = v.get("fp").and_then(|x| x.as_str()).map(|s| s.to_string());

    // vmess overloads its keys per transport. Mirror them into raw_params under
    // the names the xray config generator reads, so ws/grpc/httpupgrade/h2 hosts
    // and grpc serviceName aren't silently dropped.
    let str_of = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|s| s.to_string());
    let mut raw: HashMap<String, String> = HashMap::new();
    if let Some(h) = str_of("host").filter(|h| !h.is_empty()) {
        raw.insert("host".into(), h);
    }
    if let Some(a) = str_of("alpn").filter(|a| !a.is_empty()) {
        raw.insert("alpn".into(), a);
    }
    if let Some(scy) = str_of("scy").filter(|x| !x.is_empty()) {
        raw.insert("scy".into(), scy);
    }
    // `aid` may be a number or a string.
    if let Some(aid) = v.get("aid") {
        match aid {
            serde_json::Value::Number(n) => {
                raw.insert("aid".into(), n.to_string());
            }
            serde_json::Value::String(st) if !st.is_empty() => {
                raw.insert("aid".into(), st.clone());
            }
            _ => {}
        }
    }
    // `type` is the header-obfs type for tcp/kcp, and the gRPC mode for grpc.
    let header_type = str_of("type").filter(|t| !t.is_empty() && t != "none");
    if net == "grpc" {
        // grpc encodes serviceName in `path`; `type` carries multi/gun mode.
        if let Some(p) = s.path.take().filter(|p| !p.is_empty()) {
            raw.insert("serviceName".into(), p);
        }
        s.mode = header_type;
    } else if let Some(ht) = header_type {
        raw.insert("headerType".into(), ht);
    }
    s.raw_params = raw;
    Ok(s)
}

/// Parse a subscription body: a list of proxy URIs (plaintext or base64).
/// Lines with unsupported schemes are skipped.
pub fn parse_subscription(body: &str) -> Vec<VlessServer> {
    let text = decode_body(body);
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || !is_supported_uri(trimmed) {
                return None;
            }
            parse_proxy_uri(trimmed).ok()
        })
        .collect()
}

/// Best-effort base64 decode (standard / url-safe, padded or not) to UTF-8.
fn b64_decode_str(s: &str) -> Option<String> {
    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    for engine in [
        &base64::engine::general_purpose::STANDARD,
        &base64::engine::general_purpose::URL_SAFE,
        &base64::engine::general_purpose::STANDARD_NO_PAD,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Ok(bytes) = engine.decode(compact.as_bytes()) {
            if let Ok(text) = String::from_utf8(bytes) {
                return Some(text);
            }
        }
    }
    None
}

fn decode_body(body: &str) -> String {
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    // Already plaintext if it carries any proxy URI scheme.
    if ["vless://", "trojan://", "ss://", "vmess://"]
        .iter()
        .any(|s| compact.contains(s))
    {
        return body.to_string();
    }
    for engine in [
        &base64::engine::general_purpose::STANDARD,
        &base64::engine::general_purpose::URL_SAFE,
        &base64::engine::general_purpose::STANDARD_NO_PAD,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Ok(bytes) = engine.decode(compact.as_bytes()) {
            if let Ok(s) = String::from_utf8(bytes) {
                return s;
            }
        }
    }
    body.to_string()
}

fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s)
        .decode_utf8_lossy()
        .into_owned()
}

/// Decode a header value that some panels base64-encode (e.g. a non-ASCII
/// `Profile-Title` or `announce`). The convention is a `base64:` prefix, but a
/// few panels send raw base64 with no prefix, so fall back to a best-effort
/// decode that only replaces the value when the result is valid UTF-8.
pub fn decode_maybe_b64(value: &str) -> String {
    let trimmed = value.trim();
    let payload = trimmed
        .strip_prefix("base64:")
        .or_else(|| trimmed.strip_prefix("Base64:"))
        .map(str::trim);

    // With an explicit prefix we always try to decode; without one we only
    // attempt it when the string can't already be meaningful text.
    let (candidate, explicit) = match payload {
        Some(p) => (p, true),
        None => (trimmed, false),
    };

    for engine in [
        &base64::engine::general_purpose::STANDARD,
        &base64::engine::general_purpose::URL_SAFE,
        &base64::engine::general_purpose::STANDARD_NO_PAD,
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Ok(bytes) = engine.decode(candidate.as_bytes()) {
            if let Ok(s) = String::from_utf8(bytes) {
                let s = s.trim().to_string();
                // Without a prefix, guard against false positives: only accept a
                // decode that yields printable text different from the input.
                if explicit || (!s.is_empty() && s != trimmed && s.chars().all(|c| !c.is_control()))
                {
                    return s;
                }
            }
        }
    }
    trimmed.to_string()
}

/// Extract subscription metadata from response headers.
///
/// Header names are lowercase ASCII. `Subscription-Userinfo` looks like
/// `upload=0; download=0; total=10737418240; expire=1781461695`.
pub fn parse_headers<F>(get: F) -> SubscriptionMeta
where
    F: Fn(&str) -> Option<String>,
{
    let mut meta = SubscriptionMeta {
        title: get("profile-title")
            .map(|s| decode_maybe_b64(&s))
            .filter(|s| !s.is_empty()),
        update_interval_hours: get("profile-update-interval").and_then(|s| s.trim().parse().ok()),
        support_url: get("support-url")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        web_page_url: get("profile-web-page-url")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        ..Default::default()
    };

    if let Some(info) = get("subscription-userinfo") {
        meta.has_userinfo = true;
        for kv in info.split(';') {
            let kv = kv.trim();
            if let Some((k, v)) = kv.split_once('=') {
                let v = v.trim();
                match k.trim() {
                    "upload" => meta.upload_bytes = v.parse().ok(),
                    "download" => meta.download_bytes = v.parse().ok(),
                    // 0 = unlimited / never expires -> None, so the UI hides
                    // the badge instead of showing "0 B" or 01.01.1970.
                    "total" => meta.total_bytes = v.parse().ok().filter(|&x| x > 0),
                    "expire" => meta.expires_at_unix = v.parse().ok().filter(|&x| x > 0),
                    _ => {}
                }
            }
        }
    }
    meta
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_vless_reality_xhttp() {
        let uri = "vless://3f7e7d8c-1234-5678-9abc-def012345678@89.125.181.236:443?type=xhttp&security=reality&sni=gateway.icloud.com&fp=chrome&pbk=ABC&sid=DEAD&path=/fi-exp-xh-1673aadd&mode=packet-up&packetEncoding=xudp#Finland%20Exp";
        let s = parse_vless(uri).expect("parse");
        assert_eq!(s.uuid, "3f7e7d8c-1234-5678-9abc-def012345678");
        assert_eq!(s.host, "89.125.181.236");
        assert_eq!(s.port, 443);
        assert_eq!(s.label, "Finland Exp");
        assert_eq!(s.transport, "xhttp");
        assert_eq!(s.security, "reality");
        assert_eq!(s.sni.as_deref(), Some("gateway.icloud.com"));
        assert_eq!(s.path.as_deref(), Some("/fi-exp-xh-1673aadd"));
    }

    #[test]
    fn rejects_non_vless() {
        let r = parse_vless("vmess://AAAA@1.2.3.4:443");
        assert!(matches!(r, Err(ParseError::UnsupportedScheme(_))));
    }

    #[test]
    fn drops_balancer_sentinel() {
        // borealisvpn-style auto-select entry: a sentinel host, not a real server.
        let uri = "vless://0eeff936-aa72-4e11-a18a-d3e996f1f37b@balancer.host:443?type=tcp&security=reality&sni=api-maps.yandex.ru&pbk=ABC&sid=DEAD&flow=xtls-rprx-vision#LTE";
        assert!(matches!(
            parse_proxy_uri(uri),
            Err(ParseError::BalancerEntry)
        ));
        // ...and it's silently skipped during a subscription import.
        let body = format!("vless://a@h-a:443?type=tcp&security=reality#Real\n{uri}");
        assert_eq!(parse_subscription(&body).len(), 1);
    }

    #[test]
    fn vmess_rejects_out_of_range_port() {
        use base64::Engine as _;
        // A numeric port above u16 must be rejected, not wrapped (65616 -> 80).
        let json = r#"{"v":"2","add":"1.2.3.4","port":65616,"id":"3f7e7d8c-1234-5678-9abc-def012345678","aid":"0","net":"tcp"}"#;
        let b64 = base64::engine::general_purpose::STANDARD.encode(json);
        assert!(matches!(
            parse_vmess(&format!("vmess://{b64}")),
            Err(ParseError::MissingPort)
        ));
    }

    #[test]
    fn parses_plaintext_subscription() {
        let body = "# c\nvless://a@h-a:443?type=tcp&security=reality#A\nvless://b@h-b:443?type=xhttp&security=reality#B\ngarbage";
        let v = parse_subscription(body);
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn inline_headers_are_meta_not_description() {
        // Marzban / Happ-style: panel inlines #key: value lines at the top.
        // They must go to metadata, NOT be shown as the description.
        let body = concat!(
            "#profile-title: KurtaVPN\n",
            "#profile-update-interval: 3\n",
            "#subscription-userinfo: upload=10; download=20; total=0; expire=1780236569\n",
            "#mux-enable: 1\n",
            "#announce: base64:0J/RgNC40LLQtdGC\n", // "Привет"
            "vless://a@h-a:443?type=tcp&security=reality#A\n",
        );
        let (headers, desc) = parse_body_meta(body);
        assert_eq!(
            headers.get("profile-title").map(String::as_str),
            Some("KurtaVPN")
        );
        assert_eq!(headers.get("mux-enable").map(String::as_str), Some("1"));
        assert!(headers.contains_key("subscription-userinfo"));
        // None of the #key: value lines leak into description.
        assert!(desc.is_none(), "description should be empty, got {desc:?}");

        // And the inline userinfo parses into meta via the same path headers do.
        let m = parse_headers(|name| headers.get(name).cloned());
        assert_eq!(m.total_bytes, None); // total=0 -> unlimited
        assert_eq!(m.upload_bytes, Some(10));
        assert_eq!(m.expires_at_unix, Some(1780236569));
        assert!(m.has_userinfo);
    }

    #[test]
    fn freetext_comment_is_description() {
        let body = "# Обходы внизу списка\nvless://a@h-a:443?type=tcp&security=reality#A";
        let (headers, desc) = parse_body_meta(body);
        assert!(headers.is_empty());
        assert_eq!(desc.as_deref(), Some("Обходы внизу списка"));
    }

    #[test]
    fn parses_base64_subscription() {
        let plain = "vless://a@h-a:443?type=tcp&security=reality#A\nvless://b@h-b:443?type=xhttp&security=reality#B";
        let b64 = base64::engine::general_purpose::STANDARD.encode(plain.as_bytes());
        let v = parse_subscription(&b64);
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn parses_shadowsocks_sip002() {
        // base64("chacha20-ietf-poly1305:secretpass")
        let creds =
            base64::engine::general_purpose::STANDARD.encode("chacha20-ietf-poly1305:secretpass");
        let uri = format!("ss://{creds}@45.144.52.226:2060#%F0%9F%87%AB%F0%9F%87%AE%20FI");
        let s = parse_shadowsocks(&uri).unwrap();
        assert_eq!(s.protocol, "shadowsocks");
        assert_eq!(s.host, "45.144.52.226");
        assert_eq!(s.port, 2060);
        assert_eq!(s.method.as_deref(), Some("chacha20-ietf-poly1305"));
        assert_eq!(s.password.as_deref(), Some("secretpass"));
        assert!(s.label.contains("FI"));
    }

    #[test]
    fn parses_trojan() {
        let s =
            parse_trojan("trojan://pass123@h.example.com:443?sni=h.example.com#Trojan").unwrap();
        assert_eq!(s.protocol, "trojan");
        assert_eq!(s.host, "h.example.com");
        assert_eq!(s.port, 443);
        assert_eq!(s.password.as_deref(), Some("pass123"));
        assert_eq!(s.sni.as_deref(), Some("h.example.com"));
    }

    #[test]
    fn parses_vmess() {
        let json = r#"{"v":"2","ps":"My VMess","add":"1.2.3.4","port":"443","id":"uuid-1234","net":"ws","tls":"tls","path":"/p"}"#;
        let b64 = base64::engine::general_purpose::STANDARD.encode(json);
        let s = parse_vmess(&format!("vmess://{b64}")).unwrap();
        assert_eq!(s.protocol, "vmess");
        assert_eq!(s.host, "1.2.3.4");
        assert_eq!(s.port, 443);
        assert_eq!(s.uuid, "uuid-1234");
        assert_eq!(s.transport, "ws");
        assert_eq!(s.security, "tls");
        assert_eq!(s.label, "My VMess");
    }

    #[test]
    fn subscription_keeps_mixed_protocols() {
        let creds = base64::engine::general_purpose::STANDARD.encode("aes-256-gcm:pw");
        let body = format!(
            "vless://a@h-a:443?type=tcp&security=reality#A\nss://{creds}@h-b:2060#B\ntrojan://p@h-c:443#C\nfoobar://nope"
        );
        let v = parse_subscription(&body);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].protocol, "vless");
        assert_eq!(v[1].protocol, "shadowsocks");
        assert_eq!(v[2].protocol, "trojan");
    }

    #[test]
    fn parses_meta_headers() {
        let m = parse_headers(|name| match name {
            "profile-title" => Some("Varmlen".into()),
            "profile-update-interval" => Some("12".into()),
            "subscription-userinfo" => {
                Some("upload=10; download=200; total=1099511627776; expire=1781461695".into())
            }
            "support-url" => Some("https://t.me/x_bot".into()),
            _ => None,
        });
        assert_eq!(m.title.as_deref(), Some("Varmlen"));
        assert_eq!(m.update_interval_hours, Some(12));
        assert_eq!(m.upload_bytes, Some(10));
        assert_eq!(m.download_bytes, Some(200));
        assert_eq!(m.total_bytes, Some(1_099_511_627_776));
        assert_eq!(m.expires_at_unix, Some(1_781_461_695));
        assert_eq!(m.support_url.as_deref(), Some("https://t.me/x_bot"));
        assert!(m.has_userinfo);
    }

    #[test]
    fn meta_missing_headers_yields_defaults() {
        let m = parse_headers(|_| None);
        assert!(m.title.is_none());
        assert!(m.total_bytes.is_none());
        // No userinfo header at all: the client must KEEP its stored values.
        assert!(!m.has_userinfo);
    }

    #[test]
    fn userinfo_zero_or_absent_expiry_means_never() {
        // expire=0 -> never expires; the UI must not show 01.01.1970.
        let m = parse_headers(|name| match name {
            "subscription-userinfo" => Some("upload=1; download=2; total=0; expire=0".into()),
            _ => None,
        });
        assert!(m.has_userinfo);
        assert_eq!(m.expires_at_unix, None);
        assert_eq!(m.total_bytes, None); // 0 quota = unlimited
                                         // An "infinite" panel plan often just OMITS expire — the header is
                                         // still authoritative, so stored expiry must be cleared by the client.
        let m2 = parse_headers(|name| match name {
            "subscription-userinfo" => Some("upload=1; download=2".into()),
            _ => None,
        });
        assert!(m2.has_userinfo);
        assert_eq!(m2.expires_at_unix, None);
    }

    #[test]
    fn decodes_base64_prefixed_title() {
        let b64 = base64::engine::general_purpose::STANDARD.encode("Borealis VPS".as_bytes());
        let m = parse_headers(|name| match name {
            "profile-title" => Some(format!("base64:{b64}")),
            _ => None,
        });
        assert_eq!(m.title.as_deref(), Some("Borealis VPS"));
    }

    #[test]
    fn plain_title_is_left_untouched() {
        let m = parse_headers(|name| match name {
            "profile-title" => Some("Varmlen".into()),
            _ => None,
        });
        assert_eq!(m.title.as_deref(), Some("Varmlen"));
    }
}
