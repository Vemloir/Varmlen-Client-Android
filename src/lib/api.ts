import { invoke } from "@tauri-apps/api/core";

export interface VlessServer {
  id: string;
  /** "vless" | "trojan" | "shadowsocks" | "vmess" */
  protocol: string;
  uuid: string;
  password: string | null;
  method: string | null;
  host: string;
  port: number;
  label: string;
  transport: string;
  security: string;
  sni: string | null;
  fingerprint: string | null;
  public_key: string | null;
  short_id: string | null;
  flow: string | null;
  path: string | null;
  mode: string | null;
  packet_encoding: string | null;
  raw_params: Record<string, string>;
  /** Provider JSON object that produced this location, or null for share links. */
  source_json: string | null;
  /** Exact provider proxy outbound retained for safe config generation. */
  raw_outbound: unknown | null;
  /** Complete multi-outbound Xray profile retained as one logical location. */
  raw_profile: unknown | null;
}

export type SubscriptionUserAgent =
  | "varmlen"
  | "happ"
  | "incy"
  | "v2raytun";

export interface SubscriptionMeta {
  title: string | null;
  update_interval_hours: number | null;
  upload_bytes: number | null;
  download_bytes: number | null;
  total_bytes: number | null;
  expires_at_unix: number | null;
  /** True when a Subscription-Userinfo header was present — then its values
   *  (including absent ones = "no quota / no expiry") are authoritative. */
  has_userinfo: boolean;
  support_url: string | null;
  web_page_url: string | null;
}

export interface ImportResult {
  meta: SubscriptionMeta;
  servers: VlessServer[];
  description: string | null;
  source_json: string | null;
}

export function parseVlessUri(uri: string): Promise<VlessServer> {
  return invoke<VlessServer>("parse_vless_uri", { uri });
}

export function parseSubscriptionBody(body: string): Promise<VlessServer[]> {
  return invoke<VlessServer[]>("parse_subscription_body", { body });
}

export function fetchSubscription(
  url: string,
  subscriptionUserAgent: SubscriptionUserAgent = "varmlen",
): Promise<ImportResult> {
  return invoke<ImportResult>("fetch_subscription", {
    url,
    subscriptionUserAgent,
  });
}


export interface InstalledApp {
  /** Binary / process name used to match the running app. */
  id: string;
  /** Display name from the desktop entry. */
  name: string;
  /** Icon as a `data:image/...` URI, or null when none was resolved. */
  icon: string | null;
}

/** Installed desktop apps, parsed from the system's `.desktop` entries. */
export function listInstalledApps(): Promise<InstalledApp[]> {
  return invoke<InstalledApp[]>("list_installed_apps");
}

/** Open the system file picker (XDG portal → native DE dialog with search).
 *  Returns the chosen path, or null if cancelled. */
export function pickFile(): Promise<string | null> {
  return invoke<string | null>("pick_file");
}

/** Build an app entry from a user-picked file: a `.desktop` file is parsed
 *  (name / exec / icon), any other file is treated as the binary. */
export function appFromFile(path: string): Promise<InstalledApp | null> {
  return invoke<InstalledApp | null>("app_from_file", { path });
}

export interface InstalledVersion {
  /** Version tag like "1.13.0" (no leading "v"). */
  tag: string;
  /** True iff this is the currently active version. */
  active: boolean;
}

export interface CoreInfo {
  /** Locally cached versions, newest first. */
  installed: InstalledVersion[];
  /** Active tag, or null when no version is installed. */
  active: string | null;
  /** Latest version on GitHub, or null when the check failed. */
  latest: string | null;
  /** True iff `latest` is newer than `active` (or no version is active). */
  has_update: boolean;
}

/** The VPN core. xray is the sole core: native TUN + routing + per-app/site
 *  split + DNS + vless/reality/xhttp transport. */
export type CoreKind = "xray";

/** Installed/active vs latest core version (queries GitHub releases). */
export function coreInfo(kind: CoreKind): Promise<CoreInfo> {
  return invoke<CoreInfo>("core_info", { kind });
}

/** Download a specific version (or latest when `version` is null) into the
 *  local cache. Emits `core://progress` events. First install for a kind
 *  auto-activates it; xray installs trigger a setcap prompt (native TUN). */
export function coreInstall(kind: CoreKind, version: string | null = null): Promise<string> {
  return invoke<string>("core_install", { kind, version });
}

/** Switch the active version for a kind (must already be downloaded). */
export function coreActivate(kind: CoreKind, tag: string): Promise<void> {
  return invoke<void>("core_activate", { kind, tag });
}

/** Delete a cached version from disk. */
export function coreUninstall(kind: CoreKind, tag: string): Promise<void> {
  return invoke<void>("core_uninstall", { kind, tag });
}

export interface CoreRelease {
  tag: string;
  name: string;
  date: string | null;
  prerelease: boolean;
}

/** Recent releases (newest first) for the version picker. */
export function listCoreReleases(kind: CoreKind): Promise<CoreRelease[]> {
  return invoke<CoreRelease[]>("list_core_releases", { kind });
}

export interface CoreProgress {
  /** Tag the progress refers to. */
  tag: string;
  /** Bytes downloaded so far. */
  downloaded: number;
  /** Total expected bytes (0 when the server didn't send Content-Length). */
  total: number;
  /** Bytes per second over the last sample window. */
  speed_bps: number;
}


/** Enabled split-tunnel selection passed to the connect command. */
export interface SplitInput {
  /** Per-category modes, independent. "selective" = whitelist (only listed go
   *  via VPN); "general" = blacklist (all via VPN except listed). */
  appsMode: string;
  sitesMode: string;
  apps: string[];
  sites: string[];
}

export interface HelperResponse {
  ok: boolean;
  state: "connected" | "disconnected" | "unknown" | string;
  pid: number | null;
  error: string | null;
}

/** Connect in the given mode: "tun" (full system, via the root helper) or
 *  "proxy" (local SOCKS/HTTP, run as the user — no root). */
export function vpnConnect(
  server: VlessServer,
  split: SplitInput,
  mode: "tun" | "proxy",
  killswitch: boolean,
  allowLan: boolean,
  logLevel: string,
): Promise<HelperResponse> {
  return invoke<HelperResponse>("vpn_connect", {
    server,
    split,
    mode,
    killswitch,
    allowLan,
    logLevel,
  });
}

export function vpnDisconnect(): Promise<HelperResponse> {
  return invoke<HelperResponse>("vpn_disconnect");
}

/** The VPN log (Android: VpnService steps + xray/tun2socks output). */
export function vpnLog(): Promise<string> {
  return invoke<string>("vpn_log");
}

/** Read the system clipboard (Android — desktop uses navigator.clipboard). */
export function readClipboard(): Promise<string> {
  return invoke<string>("read_clipboard");
}

/** Write the system clipboard on Android. */
export function writeClipboard(text: string): Promise<void> {
  return invoke<void>("write_clipboard", { text });
}

/** Match the Android system-bar icons to the app theme (no-op on desktop). */
export function setStatusBar(light: boolean): Promise<void> {
  return invoke<void>("set_status_bar", { light });
}

/** Whether the app may post notifications (Android). */
export function notificationsEnabled(): Promise<boolean> {
  return invoke<boolean>("notifications_enabled");
}

/** Open the system notification settings for this app (Android). */
export function openNotificationSettings(): Promise<void> {
  return invoke<void>("open_notification_settings");
}

/** Open Android's Always-on VPN / lockdown settings. */
export function openVpnSettings(): Promise<void> {
  return invoke<void>("open_vpn_settings");
}

export function clearVpnLog(): Promise<void> {
  return invoke<void>("clear_vpn_log");
}

export function vpnStatus(): Promise<HelperResponse> {
  return invoke<HelperResponse>("vpn_status");
}

/** Whether xray has the network capability it needs for its native TUN
 *  (cap_net_admin). Replaces the old root-helper check. */
export function capsGranted(): Promise<boolean> {
  return invoke<boolean>("caps_granted");
}

/** Grant network permissions (setcap via one pkexec prompt). Also removes the
 *  legacy root helper if present. Replaces installHelper. */
export function grantCaps(): Promise<void> {
  return invoke<void>("grant_caps");
}

/** TCP-connect RTT to host:port in ms. Source-bound to the user's physical
 *  interface so the result reflects the real network even when the VPN tunnel
 *  is active. Rejects on DNS/timeout/refused. */
export function tcpPingHost(host: string, port: number, timeoutMs = 2500): Promise<number> {
  return invoke<number>("tcp_ping_host", { host, port, timeoutMs });
}

/** Via-proxy RTT in ms: spins a throwaway xray for `server` and times an HTTP
 *  GET to a 204 endpoint through it. Rejects on timeout / unreachable. */
export function proxyGetPing(server: VlessServer, timeoutMs = 5000): Promise<number> {
  return invoke<number>("proxy_get_ping", { server, timeoutMs });
}

/** One-time migration: read any prior dev-origin localStorage (subs, split,
 *  settings, …) so they aren't lost when the release build switches origin.
 *  Throws on error — frontend logs to console if migration can't run. */
export function readLegacyStorage(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("read_legacy_storage");
}

/** The single leading emoji cluster at the start of a label: a country flag
 *  (two regional indicators) or one pictographic emoji (📶 …) with its
 *  modifiers / ZWJ sequence / variation selector. Only the FIRST one. */
const LEADING_EMOJI =
  /^(?:\p{Regional_Indicator}\p{Regional_Indicator}|\p{Extended_Pictographic})(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*/u;

/** Split a server label into its leading emoji icon (just the first one) and
 *  the remaining text, so the icon renders in its own slot and isn't duplicated
 *  in the name. Panels prefix a country flag (or a 📶-style marker); we use
 *  whatever they send rather than guessing from the text. */
export function splitLabelEmoji(label: string): { icon: string; name: string } {
  const m = label.match(LEADING_EMOJI);
  if (!m) return { icon: "", name: label.trim() };
  return { icon: m[0], name: label.slice(m[0].length).trim() };
}

/** Server name with the leading emoji icon removed. */
export function stripLeadingFlag(label: string): string {
  return splitLabelEmoji(label).name;
}

/** The icon (flag or other leading emoji) for a server, or "" when none. */
export function flagFor(label: string): string {
  return splitLabelEmoji(label).icon;
}

/** Pretty bytes like 742.3GB / 1.5TB / 0B. */
export function formatBytes(n: number | null): string {
  if (n == null || n <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}

/** Format unix seconds as DD.MM.YYYY for the expires badge. */
export function formatExpires(unix: number | null): string | null {
  if (!unix || unix <= 0) return null;
  const d = new Date(unix * 1000);
  if (!Number.isFinite(d.getTime())) return null;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// --- tray + autostart -------------------------------------------------------

/** Reflect the connection status in the tray tooltip. */
export async function setTrayStatus(statusLabel: string): Promise<void> {
  await invoke("set_tray_status", { statusLabel });
}

/** Whether closing the window hides to the tray (true) or fully quits (false). */
export async function setCloseToTray(enabled: boolean): Promise<void> {
  await invoke("set_close_to_tray", { enabled });
}

export interface AutostartState {
  enabled: boolean;
  minimized: boolean;
}

/** Whether the ~/.config/autostart entry exists, and if it starts minimized. */
export async function autostartStatus(): Promise<AutostartState> {
  return invoke<AutostartState>("autostart_status");
}

/** Write/remove the autostart entry (Linux). `minimized` adds `--minimized`. */
export async function setAutostart(
  enabled: boolean,
  minimized: boolean,
): Promise<void> {
  await invoke("set_autostart", { enabled, minimized });
}
