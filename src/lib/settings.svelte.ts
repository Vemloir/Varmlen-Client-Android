import { browser } from "$app/environment";
import {
  normalizeSubscriptionUserAgent,
  type SubscriptionUserAgent,
} from "./subscription-user-agent";
import type { PinOrder } from "./location-actions";
import { MTU_DEFAULT, normalizeMtu } from "./mtu";

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
  /** Concurrency cap for the "ping all locations" sweep (0 = ping them all at
   *  once). The sweep runs inside the app process, so an unbounded burst costs
   *  memory and CPU on a device that may be doing something else. */
  pingConcurrency: number;
  /** Names under the bottom tab icons. Off by default: three tabs with two words
   *  each cost vertical space the location list needs. */
  navLabels: boolean;
  /** MTU of the tunnel interface. A path that encapsulates again cannot carry
   *  Ethernet's 1500 inside the tunnel, and then only large responses die. */
  mtu: number;
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
  pingConcurrency: 0,
  navLabels: false,
  mtu: MTU_DEFAULT,
  pinOrder: "newestLast",
};

const LOG_LEVELS: LogLevel[] = ["debug", "warn", "error"];
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
      pingConcurrency: sanitizePingConcurrency(parsed.pingConcurrency),
      navLabels: parsed.navLabels ?? DEFAULTS.navLabels,
      mtu: normalizeMtu(parsed.mtu),
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
  pingConcurrency = $state<number>(_initialSettings.pingConcurrency);
  navLabels = $state<boolean>(_initialSettings.navLabels);
  mtu = $state<number>(_initialSettings.mtu);
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
        pingConcurrency: this.pingConcurrency,
        navLabels: this.navLabels,
        mtu: this.mtu,
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
  setPingConcurrency(v: number): void {
    this.pingConcurrency = sanitizePingConcurrency(v);
    this.persist();
  }
  setNavLabels(v: boolean): void {
    this.navLabels = v;
    this.persist();
  }
  setMtu(v: number): void {
    this.mtu = normalizeMtu(v);
    this.persist();
  }
  setPinOrder(v: PinOrder): void {
    this.pinOrder = PIN_ORDERS.includes(v) ? v : DEFAULTS.pinOrder;
    this.persist();
  }
}

/** Clamped ping concurrency; the rule lives next to the scheduler that obeys it. */
function sanitizePingConcurrency(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export const settings = new SettingsStore();
