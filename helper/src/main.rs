//! varmlen-probe — a tiny setcap'd helper for the Varmlen desktop client.
//!
//! Replaces the old root systemd daemon. It is NOT a daemon: the GUI invokes it
//! per-action and it exits. It carries file capabilities
//! `cap_net_admin,cap_net_raw,cap_dac_override+ep` (set once via pkexec at
//! install/update):
//!   - cap_net_admin: SO_MARK, nftables, ip routes/rules, net sysctls
//!   - cap_net_raw:   SO_BINDTODEVICE for the bypass probes
//!   - cap_dac_override: write the root-owned rp_filter sysctl + /run state
//!
//! Privileged operations:
//!   - `tcp`/`icmp`     latency probes that bypass the active tunnel
//!   - `killswitch-up`  apply the nftables drop table
//!   - `killswitch-down`remove it
//!   - `route-up`       lay the routing xray's native tun needs: default route
//!     into the tun, a physical bypass table + ip rule for xray's own marked
//!     dials, the anti-loop server route, and loose rp_filter
//!   - `route-down`     tear that routing down (idempotent)
//!   - `cleanup`        crash-recovery superset (killswitch + routing + stray TUN)
//!
//! The GUI owns the xray process directly; xray's native tun is the data plane.
//! Per-app + per-site split live in xray's routing (native `process`/`domain`
//! matchers); the helper only sets up the kernel routing the tun requires, since
//! xray's tun inbound manages no routes/DNS itself.
//!
//! Usage:
//!   varmlen-probe tcp  <host> <port> <timeout_ms>      -> prints RTT ms
//!   varmlen-probe icmp <host> <timeout_ms>             -> prints RTT ms
//!   varmlen-probe killswitch-up [--allow-lan] <ip>...  -> applies nft table
//!   varmlen-probe killswitch-down
//!   varmlen-probe route-up [--server <ip>]...
//!   varmlen-probe route-down
//!   varmlen-probe cleanup

use std::process::{Command, Stdio};
use std::io::Write;

const KS_TABLE: &str = "varmlen_ks";
const TUN_IFACE: &str = "varmlen0";
const TUN_ADDR: &str = "172.19.0.1/30";

/// xray's own dials (proxy + direct outbounds) carry this mark via SO_MARK /
/// `sockopt.mark` so they bypass the tun (anti-loop). Accepted by the killswitch.
const XRAY_DIAL_MARK: u32 = 0x2024;

/// Custom routing table that egresses via the physical gateway — the bypass for
/// xray's own marked dials.
const PHYS_TABLE: &str = "100";

/// Teardown state (rp_filter / state writes need cap_dac_override).
const RP_STATE: &str = "/run/varmlen/rp_filter_all.orig";
const SERVERS_STATE: &str = "/run/varmlen/servers";
const SERVERS6_STATE: &str = "/run/varmlen/servers6";

fn main() {
    // Harden the environment BEFORE any privileged child spawn. This binary
    // carries file caps and raises CAP_NET_ADMIN into the ambient set, which is
    // inherited across execve — so it must never resolve ip/nft/ping via an
    // attacker-controlled $PATH (e.g. `PATH=/tmp/evil varmlen-probe ...` would run
    // /tmp/evil/nft with CAP_NET_ADMIN). Pin PATH to root-owned dirs. (LD_* is
    // already neutralised by the loader's secure-execution mode for fcaps.)
    std::env::set_var("PATH", "/usr/sbin:/usr/bin:/sbin:/bin");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rc = run(&args);
    std::process::exit(rc);
}

/// Raise CAP_NET_ADMIN into the AMBIENT set so the `ip`/`nft` child processes we
/// spawn inherit it. File capabilities do NOT cross execve to children; the
/// ambient set is the mechanism that does. Best-effort: under root (sudo) the
/// children already inherit privilege, and a failure here surfaces later as an
/// `ip`/`nft` permission error rather than a silent wrong state.
fn raise_ambient_net_admin() {
    use caps::{CapSet, Capability};
    // Ambient requires the cap in BOTH Permitted (granted by file caps) and
    // Inheritable, so add it to Inheritable first.
    let _ = caps::raise(None, CapSet::Inheritable, Capability::CAP_NET_ADMIN);
    let _ = caps::raise(None, CapSet::Ambient, Capability::CAP_NET_ADMIN);
}

fn run(args: &[String]) -> i32 {
    // ip/nft children must inherit CAP_NET_ADMIN (file caps don't cross exec).
    raise_ambient_net_admin();
    match args.first().map(String::as_str) {
        Some("tcp") => {
            // tcp <host> <port> <timeout_ms>
            let (Some(host), Some(port), Some(tmo)) = (args.get(1), args.get(2), args.get(3)) else {
                eprintln!("usage: varmlen-probe tcp <host> <port> <timeout_ms>");
                return 2;
            };
            let port: u16 = match port.parse() { Ok(p) => p, Err(_) => { eprintln!("bad port"); return 2; } };
            let tmo: u32 = tmo.parse().unwrap_or(2500);
            match tcp_ping_bypass(host, port, tmo) {
                Ok(ms) => { println!("{ms}"); 0 }
                Err(e) => { eprintln!("{e}"); 1 }
            }
        }
        Some("icmp") => {
            let (Some(host), Some(tmo)) = (args.get(1), args.get(2)) else {
                eprintln!("usage: varmlen-probe icmp <host> <timeout_ms>");
                return 2;
            };
            let tmo: u32 = tmo.parse().unwrap_or(2000);
            match icmp_ping(host, tmo) {
                Ok(ms) => { println!("{ms}"); 0 }
                Err(e) => { eprintln!("{e}"); 1 }
            }
        }
        Some("killswitch-up") => {
            let mut allow_lan = false;
            let mut ips = Vec::new();
            for a in &args[1..] {
                if a == "--allow-lan" { allow_lan = true; }
                else if let Ok(ip) = a.parse::<std::net::IpAddr>() { ips.push(ip); }
            }
            match apply_killswitch(&ips, allow_lan) {
                Ok(()) => 0,
                Err(e) => { eprintln!("{e}"); 1 }
            }
        }
        Some("killswitch-down") => { remove_killswitch(); 0 }
        Some("route-up") => {
            // route-up [--server <ip>]...
            let mut servers = Vec::new();
            let mut i = 1;
            while i < args.len() {
                if args[i] == "--server" {
                    if let Some(ip) = args.get(i + 1).and_then(|s| s.parse::<std::net::IpAddr>().ok()) {
                        servers.push(ip);
                    }
                    i += 1;
                }
                i += 1;
            }
            match route_up(&servers) {
                Ok(()) => 0,
                Err(e) => { eprintln!("{e}"); 1 }
            }
        }
        Some("route-down") => { route_down(); 0 }
        Some("cleanup") => { remove_killswitch(); route_down(); delete_tun(); 0 }
        _ => {
            eprintln!("usage: varmlen-probe <tcp|icmp|killswitch-up|killswitch-down|route-up|route-down|cleanup> ...");
            2
        }
    }
}

// --- latency probes --------------------------------------------------------

/// First non-virtual interface with an IPv4 address. SO_BINDTODEVICE to this
/// makes probes bypass the tun's default route (which catches by destination,
/// not source — a plain bind to a phys-iface IP isn't enough).
fn pick_physical_iface() -> Option<String> {
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) != 0 {
            return None;
        }
        let mut found = None;
        let mut cur = ifap;
        while !cur.is_null() {
            let ifa = &*cur;
            if !ifa.ifa_name.is_null() && !ifa.ifa_addr.is_null() {
                let name = std::ffi::CStr::from_ptr(ifa.ifa_name).to_string_lossy().into_owned();
                let virt = name.starts_with("lo")
                    || name.starts_with("tun")
                    || name.starts_with("tap")
                    || name.starts_with("wg")
                    || name.starts_with("docker")
                    || name.starts_with("br-")
                    || name.starts_with("veth")
                    || name.starts_with("vmnet")
                    || name.starts_with("varmlen");
                let sa = &*ifa.ifa_addr;
                if !virt && sa.sa_family as i32 == libc::AF_INET {
                    let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    let ip = std::net::Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                    if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() {
                        found = Some(name);
                        break;
                    }
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(ifap);
        found
    }
}

/// TCP-connect RTT in ms, source-bound + marked so it bypasses the tunnel.
fn tcp_ping_bypass(host: &str, port: u16, timeout_ms: u32) -> Result<u32, String> {
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    use std::net::{SocketAddr, ToSocketAddrs};
    use std::time::{Duration, Instant};

    if host.trim().is_empty() {
        return Err("empty host".into());
    }
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_')) {
        return Err("invalid host".into());
    }
    let dst: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("resolve: {e}"))?
        .find(|a| a.is_ipv4())
        .ok_or_else(|| "no ipv4".to_string())?;

    let sock = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| format!("socket: {e}"))?;
    let _ = sock.set_mark(XRAY_DIAL_MARK);
    if let Some(iface) = pick_physical_iface() {
        let _ = sock.bind_device(Some(iface.as_bytes()));
    }
    let timeout = Duration::from_millis(timeout_ms as u64);
    let started = Instant::now();
    sock.connect_timeout(&SockAddr::from(dst), timeout)
        .map_err(|e| format!("connect: {e}"))?;
    Ok(started.elapsed().as_millis().min(u32::MAX as u128) as u32)
}

/// ICMP RTT via the system `ping` tool.
fn icmp_ping(host: &str, timeout_ms: u32) -> Result<u32, String> {
    if host.trim().is_empty() {
        return Err("empty host".into());
    }
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_')) {
        return Err("invalid host".into());
    }
    let timeout_s = timeout_ms.div_ceil(1000).clamp(1, 10);
    let out = Command::new("ping")
        .arg("-n").arg("-c").arg("1").arg("-W").arg(timeout_s.to_string()).arg(host)
        .stdout(Stdio::piped()).stderr(Stdio::null())
        .output().map_err(|e| format!("spawn ping: {e}"))?;
    if !out.status.success() {
        return Err("ping failed".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(idx) = line.find("time=") {
            let rest = &line[idx + 5..];
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if let Ok(ms) = num.parse::<f64>() {
                return Ok(ms.round().max(1.0).min(u32::MAX as f64) as u32);
            }
        }
    }
    Err("no RTT in ping output".into())
}

// --- killswitch ------------------------------------------------------------

/// Build + apply the killswitch ruleset: drop all output except loopback, the
/// tunnel, xray's own marked dials (0x2024), the proxy server, DNS bootstrap,
/// and (optionally) LAN. Atomic via a single `nft -f` transaction.
fn apply_killswitch(server_ips: &[std::net::IpAddr], allow_lan: bool) -> Result<(), String> {
    let mut r = String::new();
    r.push_str(&format!("add table inet {KS_TABLE}\n"));
    r.push_str(&format!("delete table inet {KS_TABLE}\n"));
    r.push_str(&format!("table inet {KS_TABLE} {{\n"));
    r.push_str("  chain out {\n");
    r.push_str("    type filter hook output priority 0; policy drop;\n");
    r.push_str("    oifname \"lo\" counter accept\n");
    r.push_str(&format!("    oifname \"{TUN_IFACE}\" counter accept\n"));
    r.push_str("    ct state established,related counter accept\n");
    r.push_str("    fib daddr type local counter accept\n");
    r.push_str("    meta mark & 0x0000ffff == 0x2023 counter accept\n");
    r.push_str("    meta mark & 0x0000ffff == 0x2024 counter accept\n");
    r.push_str("    ct mark & 0x0000ffff == 0x2023 counter accept\n");
    r.push_str("    ct mark & 0x0000ffff == 0x2024 counter accept\n");
    r.push_str("    ip daddr 1.1.1.1 udp dport 53 counter accept\n");
    r.push_str("    ip daddr 1.1.1.1 tcp dport 53 counter accept\n");
    r.push_str("    ip daddr 1.1.1.1 tcp dport 443 counter accept\n");
    for ip in server_ips {
        match ip {
            std::net::IpAddr::V4(v4) => r.push_str(&format!("    ip daddr {v4} counter accept\n")),
            std::net::IpAddr::V6(v6) => r.push_str(&format!("    ip6 daddr {v6} counter accept\n")),
        }
    }
    if allow_lan {
        r.push_str("    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 } counter accept\n");
        r.push_str("    ip6 daddr { fe80::/10, fc00::/7 } counter accept\n");
    }
    r.push_str("    limit rate 30/second log prefix \"varmlen_ks_drop \" level info\n");
    r.push_str("    counter drop\n");
    r.push_str("  }\n}\n");

    nft_apply(&r)
}

/// Pipe a ruleset into `nft -f -` (atomic transaction).
fn nft_apply(ruleset: &str) -> Result<(), String> {
    let mut child = Command::new("nft").arg("-f").arg("-")
        .stdin(Stdio::piped()).spawn().map_err(|e| format!("nft spawn: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(ruleset.as_bytes()).map_err(|e| format!("nft write: {e}"))?;
    }
    let status = child.wait().map_err(|e| format!("nft wait: {e}"))?;
    if status.success() { Ok(()) } else { Err("nft apply failed".to_string()) }
}

fn remove_killswitch() {
    let _ = Command::new("nft").arg("delete").arg("table").arg("inet").arg(KS_TABLE)
        .stderr(Stdio::null()).status();
}

fn delete_tun() {
    let _ = Command::new("ip").arg("link").arg("delete").arg("dev").arg(TUN_IFACE)
        .stderr(Stdio::null()).status();
}

// --- routing for xray's native tun -----------------------------------------
//
// xray's native tun creates the device but manages NO routes/DNS, so the helper
// lays: the default route into the tun (all traffic enters; xray's routing then
// does the per-app/site split via its native process/domain matchers), a
// physical bypass table + ip rule for xray's own marked dials (anti-loop), the
// anti-loop server /32, and loose rp_filter. No cgroup — per-app is xray's job.

/// Run `ip <args>`, returning an error with stderr on failure.
fn ip_req(args: &[&str]) -> Result<(), String> {
    let out = Command::new("ip").args(args).output().map_err(|e| format!("ip: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("ip {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Run `ip <args>`, ignoring the result (idempotent teardown / best-effort).
fn ip_quiet(args: &[&str]) {
    let _ = Command::new("ip").args(args).stderr(Stdio::null()).status();
}

fn write_file(path: &str, val: &str) -> Result<(), String> {
    std::fs::write(path, val).map_err(|e| format!("write {path}: {e}"))
}

/// Write a fixed-name state file under /run/varmlen WITHOUT following symlinks.
/// /run is tmpfs with no root pre-creation, so the dir is created by the
/// (unprivileged) invoking user on first run; a same-uid attacker could swap a
/// state file for a symlink to a root-owned target and our cap_dac_override
/// write would clobber it. O_NOFOLLOW + a 0700 dir close that. Best-effort.
fn write_state(path: &str, val: &str) {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create("/run/varmlen");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        let _ = f.write_all(val.as_bytes());
    }
}

/// The physical default route `(gateway, iface)`, ignoring our own tun. The
/// gateway is optional: point-to-point/link-scope defaults (PPP/LTE modems,
/// WireGuard-as-default — `default dev ppp0 scope link`) have a `dev` but no
/// `via`, and must still work.
fn detect_default_route() -> Result<(Option<String>, String), String> {
    let out = Command::new("ip").args(["-4", "route", "show", "default"])
        .output().map_err(|e| format!("ip route: {e}"))?;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if line.contains(&format!("dev {TUN_IFACE}")) {
            continue;
        }
        let toks: Vec<&str> = line.split_whitespace().collect();
        let via = toks.iter().position(|&t| t == "via").and_then(|i| toks.get(i + 1));
        let dev = toks.iter().position(|&t| t == "dev").and_then(|i| toks.get(i + 1));
        if let Some(d) = dev {
            return Ok((via.map(|g| g.to_string()), d.to_string()));
        }
    }
    Err("no physical default route found".into())
}

/// The physical IPv6 default route `(gateway, iface)`, if the host has v6.
fn detect_default_route6() -> Option<(String, String)> {
    let out = Command::new("ip").args(["-6", "route", "show", "default"]).output().ok()?;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if line.contains(&format!("dev {TUN_IFACE}")) {
            continue;
        }
        let toks: Vec<&str> = line.split_whitespace().collect();
        let via = toks.iter().position(|&t| t == "via").and_then(|i| toks.get(i + 1));
        let dev = toks.iter().position(|&t| t == "dev").and_then(|i| toks.get(i + 1));
        if let (Some(g), Some(d)) = (via, dev) {
            return Some((g.to_string(), d.to_string()));
        }
    }
    None
}

/// Ensure `varmlen0` exists (xray normally creates it; create a persistent device
/// as a fallback), is addressed, and is up.
fn ensure_tun() -> Result<(), String> {
    if !std::path::Path::new(&format!("/sys/class/net/{TUN_IFACE}")).exists() {
        ip_quiet(&["tuntap", "add", "dev", TUN_IFACE, "mode", "tun"]);
    }
    ip_quiet(&["addr", "replace", TUN_ADDR, "dev", TUN_IFACE]);
    ip_req(&["link", "set", TUN_IFACE, "up"])
}

const RP_ALL: &str = "/proc/sys/net/ipv4/conf/all/rp_filter";

/// Loosen reverse-path filtering (RPF) so the asymmetric bypass replies on the
/// physical NIC aren't dropped. Effective RPF = max(all, iface), so setting
/// `all=2` (loose) suffices. Original captured for restore.
fn set_rp_filter_loose() -> Result<(), String> {
    let orig = std::fs::read_to_string(RP_ALL).unwrap_or_default();
    write_state(RP_STATE, orig.trim());
    write_file(RP_ALL, "2")
}

/// Add an `ip rule fwmark <mark> lookup <table>` idempotently.
fn add_rule_fwmark(mark: u32, table: &str) -> Result<(), String> {
    let m = format!("{mark:#x}");
    ip_quiet(&["rule", "del", "fwmark", &m, "lookup", table]);
    ip_req(&["rule", "add", "fwmark", &m, "lookup", table])
}

/// Lay the routing xray's native tun needs. Atomic-ish: rolls back via
/// `route_down` on any error. Mode-independent — the per-app/site split is
/// entirely xray's job (native `process`/`domain` routing); the helper only
/// gets traffic into the tun and keeps xray's own dials out of it.
fn route_up(servers: &[std::net::IpAddr]) -> Result<(), String> {
    let (gw, iface) = detect_default_route()?;

    let result = (|| -> Result<(), String> {
        // 1. tun device (xray usually created it already; ensure addr + up).
        ensure_tun()?;

        // 2. loosen RPF so the asymmetric bypass replies aren't dropped.
        set_rp_filter_loose()?;

        // 3. physical bypass table + rule for xray's own marked dials, so the
        //    proxy/direct outbounds escape the tun instead of looping. The
        //    gateway is omitted on link-scope defaults (PPP/LTE/wg).
        let mut def: Vec<&str> = vec!["route", "replace", "default"];
        if let Some(g) = gw.as_deref() {
            def.push("via");
            def.push(g);
        }
        def.push("dev");
        def.push(&iface);
        def.push("table");
        def.push(PHYS_TABLE);
        ip_req(&def)?;
        add_rule_fwmark(XRAY_DIAL_MARK, PHYS_TABLE)?;

        // 4. anti-loop FIRST: pin each server IP to the physical path (more
        //    specific than 0/1) so xray's dial escapes the tun even if SO_MARK
        //    no-ops — laid before the default-into-tun route below.
        let mut server_lines = String::new();
        for s in servers {
            if let std::net::IpAddr::V4(v4) = s {
                let dst = format!("{v4}/32");
                let mut r: Vec<&str> = vec!["route", "replace", &dst];
                if let Some(g) = gw.as_deref() {
                    r.push("via");
                    r.push(g);
                }
                r.push("dev");
                r.push(&iface);
                ip_req(&r)?;
                server_lines.push_str(&format!("{v4}\n"));
            }
        }
        write_state(SERVERS_STATE, &server_lines);

        // 5. default into the tun (0/1 + 128/1 are more specific than the
        //    existing physical default, which stays as fallback). Everything
        //    enters the tun; xray's routing decides proxy vs direct per app/site.
        ip_req(&["route", "replace", "0.0.0.0/1", "dev", TUN_IFACE])?;
        ip_req(&["route", "replace", "128.0.0.0/1", "dev", TUN_IFACE])?;

        // 6. IPv6: the tun is v4-only, so v6 must fail CLOSED — otherwise native
        //    v6 traffic (incl. plaintext v6 DNS) leaks straight out the physical
        //    NIC. Blackhole v6 with /1 routes (more specific than the physical
        //    ::/0 default, left intact for clean teardown). A v6 server dial, if
        //    any, gets a /128 bypass first (longest-prefix wins over the /1).
        let v6 = detect_default_route6();
        let mut s6 = String::new();
        for s in servers {
            if let std::net::IpAddr::V6(addr) = s {
                if let Some((gw6, if6)) = v6.as_ref() {
                    ip_req(&["-6", "route", "replace", &format!("{addr}/128"), "via", gw6, "dev", if6])?;
                    s6.push_str(&format!("{addr}\n"));
                }
            }
        }
        write_state(SERVERS6_STATE, &s6);
        ip_req(&["-6", "route", "replace", "blackhole", "::/1"])?;
        ip_req(&["-6", "route", "replace", "blackhole", "8000::/1"])?;
        Ok(())
    })();

    if result.is_err() {
        route_down();
    }
    result
}

/// Tear the tun routing down. Idempotent and best-effort; restores physical
/// reachability FIRST so a partial failure never black-holes the box.
fn route_down() {
    // 1. drop the tun default overrides → physical default is reachable again.
    ip_quiet(&["route", "del", "0.0.0.0/1", "dev", TUN_IFACE]);
    ip_quiet(&["route", "del", "128.0.0.0/1", "dev", TUN_IFACE]);

    // 1b. drop the IPv6 blackholes + any v6 server bypass routes.
    ip_quiet(&["-6", "route", "del", "::/1"]);
    ip_quiet(&["-6", "route", "del", "8000::/1"]);
    if let Ok(list) = std::fs::read_to_string(SERVERS6_STATE) {
        for ip in list.lines().filter(|l| !l.trim().is_empty()) {
            ip_quiet(&["-6", "route", "del", &format!("{}/128", ip.trim())]);
        }
        let _ = std::fs::remove_file(SERVERS6_STATE);
    }

    // 2. remove the dial-mark policy rule (loop: a crash may have stacked dups).
    let m = format!("{XRAY_DIAL_MARK:#x}");
    for _ in 0..4 {
        let ok = Command::new("ip").args(["rule", "del", "fwmark", &m])
            .stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            break;
        }
    }

    // 3. flush the physical bypass table.
    ip_quiet(&["route", "flush", "table", PHYS_TABLE]);

    // 4. remove the anti-loop server /32 routes recorded at route-up.
    if let Ok(list) = std::fs::read_to_string(SERVERS_STATE) {
        for ip in list.lines().filter(|l| !l.trim().is_empty()) {
            ip_quiet(&["route", "del", &format!("{}/32", ip.trim())]);
        }
        let _ = std::fs::remove_file(SERVERS_STATE);
    }

    // 5. restore RPF.
    if let Ok(orig) = std::fs::read_to_string(RP_STATE) {
        let v = orig.trim();
        if !v.is_empty() {
            let _ = write_file(RP_ALL, v);
        }
        let _ = std::fs::remove_file(RP_STATE);
    }
}
