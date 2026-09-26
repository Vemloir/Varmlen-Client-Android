import { tunnelStats, vpnConnect, vpnDisconnect, vpnStatus } from "$lib/api";
import { SessionThroughput } from "$lib/session-stats";
import { subs } from "$lib/subs.svelte";
import { split } from "$lib/split.svelte";
import { settings } from "$lib/settings.svelte";
import { t } from "$lib/i18n.svelte";
import { listen } from "@tauri-apps/api/event";
import { ConnectionOperationGate } from "$lib/connection-operation";

// "dropped": the tunnel died unexpectedly and the kill switch is holding traffic
// blocked (fail-closed). Distinct from "disconnected" so the UI can say so.
export type Status = "disconnected" | "connecting" | "connected" | "dropped";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Current split-tunnel selection (enabled entries for the active mode). */
class ConnStore {
  status = $state<Status>("disconnected");
  /** Last connect error, surfaced under the power button. */
  error = $state<string | null>(null);
  /** True while in the "dropped" phase WITH the kill switch holding traffic. */
  blockedByKillswitch = $state(false);
  /** Throughput of the tunnel, bytes per second over the last sample, and the age
   *  of the tunnel in seconds. Zero while disconnected: the pill reports that
   *  state. Null while connected means there was nothing to read: no tunnel device
   *  on a desktop, or a phone that does not count traffic per app. */
  sessionUp = $state<number | null>(0);
  sessionDown = $state<number | null>(0);
  sessionSeconds = $state(0);

  private throughput = new SessionThroughput();
  private sessionStartedAt = 0;
  private sessionTickerStarted = false;

  /** Count the session once a second while the tunnel is up. Started from
   *  refresh(), next to the drop listener: both are about the tunnel, not about
   *  whichever page happens to be open. */
  startSessionTicker(): void {
    if (this.sessionTickerStarted) return;
    this.sessionTickerStarted = true;
    setInterval(() => void this.tickSession(), 1000);
  }

  private async tickSession(): Promise<void> {
    if (this.status !== "connected") return;
    let stats = null;
    try {
      stats = await tunnelStats();
    } catch {
      stats = null; // no counters on this device
    }
    if (this.status !== "connected") return;
    const at = Date.now();
    if (!stats) {
      // The session is still measurable in time, and the rates say "unknown"
      // rather than claiming an idle tunnel.
      this.sessionUp = null;
      this.sessionDown = null;
      this.sessionSeconds = Math.max(
        0,
        Math.floor(at / 1000 - this.sessionStartedAt / 1000),
      );
      return;
    }
    const rate = this.throughput.sample(
      { up: stats.tx_bytes, down: stats.rx_bytes },
      at,
    );
    this.sessionUp = rate.up;
    this.sessionDown = rate.down;
    // The device knows how old the tunnel is; only if sysfs would not say do we
    // fall back to when this window noticed the connection.
    const since = stats.since_unix ?? Math.floor(this.sessionStartedAt / 1000);
    this.sessionSeconds = Math.max(0, Math.floor(at / 1000) - since);
  }

  /** A tunnel came up: start counting from here, not from whatever the device
   *  has carried since it was created. */
  private openSession(): void {
    if (this.sessionStartedAt !== 0) return;
    this.sessionStartedAt = Date.now();
    this.throughput.reset();
    this.sessionSeconds = 0;
  }

  private closeSession(): void {
    this.sessionStartedAt = 0;
    this.throughput.reset();
    this.sessionUp = 0;
    this.sessionDown = 0;
    this.sessionSeconds = 0;
  }

  private operations = new ConnectionOperationGate();
  private dropListenerStarted = false;

  /** Subscribe to backend "vpn-dropped" events (tunnel died unexpectedly). The
   *  payload is `true` when the kill switch is holding traffic blocked. */
  startDropListener(): void {
    if (this.dropListenerStarted) return;
    this.dropListenerStarted = true;
    void listen<boolean>("vpn-dropped", (e) => {
      this.operations.cancel();
      if (e.payload) {
        this.status = "dropped";
        this.blockedByKillswitch = true;
        this.error = t("conn.dropped");
      } else {
        this.status = "disconnected";
        this.blockedByKillswitch = false;
        this.error = t("conn.droppedNoKill");
      }
    });
  }
  /** Signature of the config last applied, to avoid redundant reconnects. */
  private lastSig: string | null = null;
  private lastProviderRefreshRevision = 0;
  /** When we last reached "connected". A status poll right after connecting can
   *  falsely read "not running" (Android registers the service a beat late, and
   *  the VPN-consent dialog resumes the activity mid-connect), so refresh() must
   *  not downgrade within this grace window. */
  private lastConnectedAt = 0;
  private readonly CONNECT_GRACE_MS = 6000;

  /** Signature of everything that affects the generated config. Keyed on the
   *  stable host:port (NOT the per-entry id, which is regenerated on every
   *  refresh) so refreshing a subscription doesn't look like a config change
   *  and trigger a needless reconnect. */
  private configSig(): string {
    return JSON.stringify({
      server: subs.selectedKey,
      killswitch: settings.killswitch,
      allowLan: settings.allowLan,
      // The MTU belongs in the signature: a tunnel that is already up must be
      // rebuilt when the user changes it, or the setting reads as applied and is not.
      mtu: settings.mtu,
      split: split.input(),
    });
  }

  /** Called reactively when config (location / split / settings)
   *  changes: while connected, debounce-reconnect with the new config so the
   *  change takes effect live. The killswitch (if on) holds across the gap. */
  onConfigChanged(providerRefreshRevision = 0): void {
    const sig = this.configSig();
    if (providerRefreshRevision !== this.lastProviderRefreshRevision) {
      this.lastProviderRefreshRevision = providerRefreshRevision;
      this.lastSig = sig;
      return;
    }
    if (this.lastSig === null) {
      this.lastSig = sig; // baseline on first run, no reconnect
      return;
    }
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    if (this.status !== "connected" && this.status !== "connecting") return;
    this.operations.schedule(() => void this.connect(), 500);
  }

  async toggle(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") {
      await this.disconnect();
    } else if (this.status === "dropped") {
      // From a kill-switch-blocked drop, the power button reconnects.
      await this.connect();
    } else {
      await this.connect();
    }
  }

  /** Clear a kill-switch-blocked drop without reconnecting (restores traffic). */
  async clearDrop(): Promise<void> {
    await this.disconnect();
  }

  async connect(): Promise<void> {
    const generation = this.operations.begin();
    this.error = null;
    this.blockedByKillswitch = false;
    let server;
    try {
      server = await subs.selectedServerRaw();
    } catch (error) {
      if (this.operations.isCurrent(generation)) this.error = msg(error);
      return;
    }
    if (!server) {
      this.error = t("conn.selectLocation");
      return;
    }
    // A connect while a tunnel is already up is a RECONFIGURE. The service
    // establishes the replacement interface before it retires the running one
    // (VarmlenVpnService.startAll: "Android atomically switches VPN routing to the
    // new descriptor"), so the session never drops and the kill switch is never
    // lifted -- and the UI must not paint "connecting" over a tunnel that stayed
    // up. That is what makes editing the split while connected silent: the
    // interface is rebuilt, the power button does not blink.
    const reconfigure = this.status === "connected";
    if (!reconfigure) this.status = "connecting";
    this.lastSig = this.configSig();
    // Hold the "connecting" indicator visible for at least this long even
    // when the helper rejects in <50ms — otherwise the spinner / animated
    // ring is gone before the user perceives it, and a fast failure looks
    // like "the button does nothing". A reconfigure shows nothing, so it has
    // nothing to hold.
    const startedAt = Date.now();
    const MIN_CONNECTING_MS = reconfigure ? 0 : 700;
    try {
      const resp = await vpnConnect(
        server,
        split.input(),
        settings.killswitch,
        settings.allowLan,
        settings.logLevel,
        settings.mtu,
        reconfigure,
      );
      const remain = MIN_CONNECTING_MS - (Date.now() - startedAt);
      if (remain > 0) await new Promise((r) => setTimeout(r, remain));
      if (!this.operations.isCurrent(generation)) return;
      if (!resp.ok) throw new Error(resp.error || "connection failed");
      this.applyBackendState(resp.state);
    } catch (e) {
      const remain = MIN_CONNECTING_MS - (Date.now() - startedAt);
      if (remain > 0) await new Promise((r) => setTimeout(r, remain));
      if (!this.operations.isCurrent(generation)) return;
      this.error = msg(e);
      try {
        const status = await vpnStatus();
        if (!this.operations.isCurrent(generation)) return;
        this.applyBackendState(status.state);
      } catch {
        this.status = "disconnected";
      }
    }
  }

  async disconnect(): Promise<void> {
    const generation = this.operations.cancel();
    try {
      const response = await vpnDisconnect();
      if (!this.operations.isCurrent(generation)) return;
      this.applyBackendState(response.state);
      this.error = null;
    } catch (e) {
      if (!this.operations.isCurrent(generation)) return;
      this.error = msg(e);
      try {
        const status = await vpnStatus();
        if (!this.operations.isCurrent(generation)) return;
        this.applyBackendState(status.state);
      } catch {
        this.status = "dropped";
        this.blockedByKillswitch = true;
      }
    }
  }

  /** Reconcile UI with the helper's actual state (e.g. window recreated while
   *  still connected, or core crashed/dropped while the window was away). */
  async refresh(): Promise<void> {
    this.startDropListener();
    this.startSessionTicker();
    const generation = this.operations.snapshot();
    try {
      const resp = await vpnStatus();
      if (!this.operations.isCurrent(generation)) return;
      if (
        resp.state === "disconnected" &&
        (this.status === "connected" || this.status === "dropped") &&
        Date.now() - this.lastConnectedAt > this.CONNECT_GRACE_MS
      ) {
        // Don't trust a single "not running" poll right after connecting.
        this.status = "disconnected";
        this.blockedByKillswitch = false;
      } else if (resp.state !== "disconnected") {
        this.applyBackendState(resp.state);
      }
    } catch {
      // helper unreachable — leave UI as is
    }
  }

  /** Native-pushed state (Android): the VpnService broadcasts on connect, on a
   *  notification/tile/system disconnect, and on an xray crash — apply it
   *  instantly, no status round-trip. "connecting" is left for connect() to
   *  resolve. */
  applyExternalState(running: boolean): void {
    // connect() owns the connecting -> connected/disconnected transition (incl.
    // the minimum spinner time); don't let a watcher tick race it.
    if (this.status === "connecting") return;
    if (running) {
      this.status = "connected";
      this.lastConnectedAt = Date.now();
      this.blockedByKillswitch = false;
      this.openSession();
    } else if (this.status === "connected" || this.status === "dropped") {
      this.status = "disconnected";
      this.blockedByKillswitch = false;
      this.closeSession();
    }
  }

  private applyBackendState(state: string): void {
    if (state === "connected") {
      this.status = "connected";
      this.lastConnectedAt = Date.now();
      this.blockedByKillswitch = false;
      this.openSession();
      return;
    }
    if (state === "dropped") {
      this.status = "dropped";
      this.blockedByKillswitch = true;
      this.error ||= t("conn.dropped");
      return;
    }
    this.status = "disconnected";
    this.blockedByKillswitch = false;
    this.closeSession();
  }
}

export const conn = new ConnStore();
