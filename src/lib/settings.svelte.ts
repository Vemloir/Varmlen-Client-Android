import { browser } from "$app/environment";
import {
  normalizeSubscriptionUserAgent,
  type SubscriptionUserAgent,
} from "./subscription-user-agent";

export type VpnMode = "tun" | "proxy";
/** How server latency is measured. `tcp` = raw TCP connect to the endpoint
 *  (bypasses the tunnel, works disconnected). `proxy` = an HTTP GET routed
 *  through a throwaway xray per server (via-proxy latency). */
export type PingMethod = "tcp" | "proxy";
export type LogLevel = "debug" | "warn" | "error";

interface Persisted {
  vpnMode: VpnMode;
  killswitch: boolean;
  allowLan: boolean;
  pingMethod: PingMethod;
  /** Closing the window hides to the tray (true) vs fully quits (false). */
  closeToTray: boolean;
  /** Verbosity of the VPN log (xray + tun2socks). */
  logLevel: LogLevel;
  /** Identity advertised only while importing/refreshing subscriptions. */
  subscriptionUserAgent: SubscriptionUserAgent;
}

const KEY = "varmlen.settings";
const DEFAULTS: Persisted = {
  vpnMode: "tun",
  killswitch: true,
  allowLan: true,
  pingMethod: "tcp",
  closeToTray: true,
  logLevel: "warn",
  subscriptionUserAgent: "varmlen",
};

const LOG_LEVELS: LogLevel[] = ["debug", "warn", "error"];

function load(): Persisted {
  if (!browser) return DEFAULTS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      vpnMode: parsed.vpnMode === "proxy" ? "proxy" : "tun",
      killswitch: parsed.killswitch ?? DEFAULTS.killswitch,
      allowLan: parsed.allowLan ?? DEFAULTS.allowLan,
      pingMethod: parsed.pingMethod === "proxy" ? "proxy" : "tcp",
      closeToTray: parsed.closeToTray ?? DEFAULTS.closeToTray,
      logLevel: LOG_LEVELS.includes(parsed.logLevel as LogLevel)
        ? (parsed.logLevel as LogLevel)
        : DEFAULTS.logLevel,
      subscriptionUserAgent: normalizeSubscriptionUserAgent(
        parsed.subscriptionUserAgent,
      ),
    };
  } catch {
    return DEFAULTS;
  }
}

const _initialSettings = load();

class SettingsStore {
  vpnMode = $state<VpnMode>(_initialSettings.vpnMode);
  killswitch = $state(_initialSettings.killswitch);
  allowLan = $state(_initialSettings.allowLan);
  pingMethod = $state<PingMethod>(_initialSettings.pingMethod);
  closeToTray = $state(_initialSettings.closeToTray);
  logLevel = $state<LogLevel>(_initialSettings.logLevel);
  subscriptionUserAgent = $state<SubscriptionUserAgent>(
    _initialSettings.subscriptionUserAgent,
  );

  private persist(): void {
    if (!browser) return;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        vpnMode: this.vpnMode,
        killswitch: this.killswitch,
        allowLan: this.allowLan,
        pingMethod: this.pingMethod,
        closeToTray: this.closeToTray,
        logLevel: this.logLevel,
        subscriptionUserAgent: this.subscriptionUserAgent,
      }),
    );
  }

  setVpnMode(v: VpnMode): void { this.vpnMode = v; this.persist(); }
  setKillswitch(v: boolean): void { this.killswitch = v; this.persist(); }
  setAllowLan(v: boolean): void { this.allowLan = v; this.persist(); }
  setPingMethod(v: PingMethod): void { this.pingMethod = v; this.persist(); }
  setCloseToTray(v: boolean): void { this.closeToTray = v; this.persist(); }
  setLogLevel(v: LogLevel): void { this.logLevel = v; this.persist(); }
  setSubscriptionUserAgent(v: SubscriptionUserAgent): void {
    this.subscriptionUserAgent = normalizeSubscriptionUserAgent(v);
    this.persist();
  }
}

export const settings = new SettingsStore();
