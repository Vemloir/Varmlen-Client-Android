import { browser } from "$app/environment";
import {
  normalizeSubscriptionUserAgent,
  type SubscriptionUserAgent,
} from "./subscription-user-agent";
import type { HideLocationsMode, PinOrder } from "./location-actions";

/** How server latency is measured. `tcp` = raw TCP connect to the endpoint
 *  (bypasses the tunnel, works disconnected). `proxy` = an HTTP GET routed
 *  through a throwaway xray per server (via-proxy latency). */
export type PingMethod = "tcp" | "proxy";
export type LogLevel = "debug" | "warn" | "error";

interface Persisted {
  killswitch: boolean;
  allowLan: boolean;
  pingMethod: PingMethod;
  /** Closing the window hides to the tray (true) vs fully quits (false). */
  closeToTray: boolean;
  /** Verbosity of the VPN log (VpnService + xray). */
  logLevel: LogLevel;
  /** Identity advertised only while importing/refreshing subscriptions. */
  subscriptionUserAgent: SubscriptionUserAgent;
  subscriptionAutoUpdate: boolean;
  /** How long a hidden location stays out of the list. */
  hideLocations: HideLocationsMode;
  /** Order of the pinned locations among themselves. */
  pinOrder: PinOrder;
}

const KEY = "varmlen.settings";
const DEFAULTS: Persisted = {
  killswitch: true,
  allowLan: true,
  pingMethod: "tcp",
  closeToTray: true,
  logLevel: "warn",
  subscriptionUserAgent: "varmlen",
  subscriptionAutoUpdate: true,
  hideLocations: "untilManualRefresh",
  pinOrder: "newestLast",
};

const LOG_LEVELS: LogLevel[] = ["debug", "warn", "error"];
const HIDE_MODES: HideLocationsMode[] = ["untilManualRefresh", "never"];

/** Earlier builds offered `always`, `off` and `untilRefresh`. `always` is now
 *  `never`; "do not hide anything" is not a hiding mode; and a location hidden
 *  "until the next update" that came back by itself was the complaint, so
 *  `untilRefresh` falls back to the default, where only the user restores it. */
function migrateHideMode(value: unknown): HideLocationsMode {
  if (value === "always") return "never";
  return HIDE_MODES.includes(value as HideLocationsMode)
    ? (value as HideLocationsMode)
    : DEFAULTS.hideLocations;
}
const PIN_ORDERS: PinOrder[] = ["newestLast", "newestFirst"];

function load(): Persisted {
  if (!browser) return DEFAULTS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
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
      subscriptionAutoUpdate:
        parsed.subscriptionAutoUpdate ?? DEFAULTS.subscriptionAutoUpdate,
      hideLocations: migrateHideMode(parsed.hideLocations),
      pinOrder: PIN_ORDERS.includes(parsed.pinOrder as PinOrder)
        ? (parsed.pinOrder as PinOrder)
        : DEFAULTS.pinOrder,
    };
  } catch {
    return DEFAULTS;
  }
}

const _initialSettings = load();

class SettingsStore {
  killswitch = $state(_initialSettings.killswitch);
  allowLan = $state(_initialSettings.allowLan);
  pingMethod = $state<PingMethod>(_initialSettings.pingMethod);
  closeToTray = $state(_initialSettings.closeToTray);
  logLevel = $state<LogLevel>(_initialSettings.logLevel);
  subscriptionUserAgent = $state<SubscriptionUserAgent>(
    _initialSettings.subscriptionUserAgent,
  );
  subscriptionAutoUpdate = $state(_initialSettings.subscriptionAutoUpdate);
  hideLocations = $state<HideLocationsMode>(_initialSettings.hideLocations);
  pinOrder = $state<PinOrder>(_initialSettings.pinOrder);

  private persist(): void {
    if (!browser) return;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        killswitch: this.killswitch,
        allowLan: this.allowLan,
        pingMethod: this.pingMethod,
        closeToTray: this.closeToTray,
        logLevel: this.logLevel,
        subscriptionUserAgent: this.subscriptionUserAgent,
        subscriptionAutoUpdate: this.subscriptionAutoUpdate,
        hideLocations: this.hideLocations,
        pinOrder: this.pinOrder,
      }),
    );
  }

  setKillswitch(v: boolean): void { this.killswitch = v; this.persist(); }
  setAllowLan(v: boolean): void { this.allowLan = v; this.persist(); }
  setPingMethod(v: PingMethod): void { this.pingMethod = v; this.persist(); }
  setCloseToTray(v: boolean): void { this.closeToTray = v; this.persist(); }
  setLogLevel(v: LogLevel): void { this.logLevel = v; this.persist(); }
  setSubscriptionUserAgent(v: SubscriptionUserAgent): void {
    this.subscriptionUserAgent = normalizeSubscriptionUserAgent(v);
    this.persist();
  }
  setSubscriptionAutoUpdate(v: boolean): void {
    this.subscriptionAutoUpdate = v;
    this.persist();
  }
  setHideLocations(v: HideLocationsMode): void {
    this.hideLocations = migrateHideMode(v);
    this.persist();
  }
  setPinOrder(v: PinOrder): void {
    this.pinOrder = PIN_ORDERS.includes(v) ? v : DEFAULTS.pinOrder;
    this.persist();
  }
}

export const settings = new SettingsStore();
