import { browser } from "$app/environment";
import {
  fetchSubscription,
  parseSubscriptionBody,
  flagFor,
  stripLeadingFlag,
  formatBytes,
  formatExpires,
  tcpPingHost,
  proxyGetPing,
  type ImportResult,
  type VlessServer,
} from "$lib/api";
import { settings, type PingMethod } from "$lib/settings.svelte";
import { isRemoteSource } from "$lib/subscription-json";
import {
  isRemoteConfiguration,
  mergeManualConfigurations,
} from "$lib/manual-configurations";

/** Ping result for a server entry. `null` = unknown / not yet measured,
 *  `"pinging"` = probe in flight, `"timeout"` = host unreachable / timed out,
 *  number = RTT in milliseconds. */
export type PingState = number | "pinging" | "timeout";

export interface ServerEntry {
  id: string;
  flag: string;
  name: string;
  transport: string;
  raw: VlessServer;
}

export interface Subscription {
  id: string;
  name: string;
  /** Free-text description sourced from a leading `# …` comment in the
   *  subscription body. null when the server doesn't include one. */
  description: string | null;
  url: string;
  importedAt: string; // ISO
  /** Server-advertised refresh interval (hours). null when not sent. */
  updateIntervalHours: number | null;
  /** Bytes used (upload + download). */
  usedBytes: number;
  /** Total quota in bytes; 0 = unlimited. */
  totalBytes: number;
  /** Unix seconds, or null when no expiry was sent. */
  expiresAtUnix: number | null;
  /** Telegram/support contact (Support-Url) — paper-plane icon when it's a
   *  t.me link, which for our own service is the bot. */
  supportUrl: string | null;
  /** Provider website (Profile-Web-Page-Url) — shown as an info icon. */
  webPageUrl: string | null;
  /** Original JSON returned by a JSON subscription or pasted by the user. */
  sourceJson: string | null;
  /** Locally edited remote JSON is not overwritten by background refreshes. */
  jsonEdited: boolean;
  servers: ServerEntry[];
  collapsed: boolean;
  /** Pinned subscriptions sort to the top of the list. */
  pinned: boolean;
  /** True while refresh() is in flight. Not persisted. */
  refreshing?: boolean;
}

interface Persisted {
  subs: Subscription[];
  selectedServerId: string | null;
  /** Stable host:port of the selection — survives a refresh (which reassigns the
   *  per-entry random ids) so the chosen location stays chosen. */
  selectedKey: string | null;
}

/** Stable identity of a server entry (random `id` changes on every parse). */
function serverKey(srv: ServerEntry): string {
  return srv.raw
    ? [
        srv.raw.protocol,
        srv.raw.host,
        srv.raw.port,
        srv.raw.uuid,
        srv.raw.password ?? "",
        srv.raw.method ?? "",
      ].join("\u0000")
    : srv.id;
}

const KEY = "varmlen.subs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Earlier versions used a deterministic `host:port#uuid8` for ServerEntry.id.
 *  When two subscriptions advertised the same endpoint, those IDs collided
 *  and broke `{#each}`'s keyed reconciliation. New entries use random UUIDs,
 *  so we transparently regenerate any old-format IDs the first time we load.
 */
function migrateIds(subs: Subscription[]): { subs: Subscription[]; remapped: Record<string, string> } {
  const remapped: Record<string, string> = {};
  for (const sub of subs) {
    // Drop balancer/auto-select sentinels (host "balancer.host") — they aren't
    // connectable servers; the backend also rejects them at parse time now.
    sub.servers = sub.servers.filter((srv) => srv.raw?.host !== "balancer.host");
    for (const srv of sub.servers) {
      if (!srv.id || !UUID_RE.test(srv.id)) {
        const fresh = crypto.randomUUID();
        remapped[srv.id ?? ""] = fresh;
        srv.id = fresh;
      }
      // Drop any legacy ping fields that older versions persisted on the
      // entry — pinging is gone from the UI for now.
      delete (srv as unknown as Record<string, unknown>).pingMs;
      delete (srv as unknown as Record<string, unknown>).pinging;
      // Drop the leading flag emoji from older labels stored before the
      // flag was rendered separately.
      srv.name = stripLeadingFlag(srv.name);
      // Re-derive the flag from the original label so entries imported before
      // we preferred the label's own flag emoji pick up the correct one.
      if (srv.raw?.label) srv.flag = flagFor(srv.raw.label);
      // JSON metadata was added after 0.2.0. Normalize old persisted entries so
      // the editor and transport badge can distinguish them safely; the next
      // normal subscription refresh fills the exact provider JSON/outbound.
      if (srv.raw && srv.raw.source_json === undefined) srv.raw.source_json = null;
      if (srv.raw && srv.raw.raw_outbound === undefined) srv.raw.raw_outbound = null;
      if (srv.raw && srv.raw.raw_profile === undefined) srv.raw.raw_profile = null;
    }
    if (sub.description === undefined) sub.description = null;
    if (sub.webPageUrl === undefined) sub.webPageUrl = null;
    if (sub.sourceJson === undefined) sub.sourceJson = null;
    if (sub.jsonEdited === undefined) sub.jsonEdited = false;
    if (sub.pinned === undefined) sub.pinned = false;
    if (sub.refreshing) sub.refreshing = false;
  }
  return { subs: mergeManualConfigurations(subs), remapped };
}

function load(): Persisted {
  if (!browser) return { subs: [], selectedServerId: null, selectedKey: null };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { subs: [], selectedServerId: null, selectedKey: null };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const rawSubs = Array.isArray(parsed.subs) ? parsed.subs : [];
    const { subs, remapped } = migrateIds(rawSubs);
    let selected: string | null =
      typeof parsed.selectedServerId === "string" ? parsed.selectedServerId : null;
    if (selected && remapped[selected]) selected = remapped[selected];
    // If the persisted selection points at an id we no longer have, drop it
    // (reconcileSelection re-resolves it from selectedKey on construction).
    if (selected && !subs.some((s) => s.servers.some((sv) => sv.id === selected))) {
      selected = null;
    }
    const selectedKey =
      typeof parsed.selectedKey === "string" ? parsed.selectedKey : null;
    return { subs, selectedServerId: selected, selectedKey };
  } catch {
    return { subs: [], selectedServerId: null, selectedKey: null };
  }
}

const PROTOCOL_LABELS: Record<string, string> = {
  vless: "VLESS",
  trojan: "Trojan",
  shadowsocks: "Shadowsocks",
  vmess: "VMess",
};

export function transportSummary(s: VlessServer): string {
  const proto = PROTOCOL_LABELS[s.protocol] ?? s.protocol.toUpperCase();
  const parts = [proto, s.transport.toUpperCase()];
  if (s.security && s.security !== "none") parts.push(s.security.toUpperCase());
  if (s.source_json) parts.push("JSON");
  return parts.join(" / ");
}

function toServerEntry(s: VlessServer): ServerEntry {
  return {
    // Random id avoids collisions when two subscriptions advertise the same
    // host:port endpoint (otherwise Svelte's keyed {#each} blows up the
    // second render).
    id: crypto.randomUUID(),
    flag: flagFor(s.label),
    name: stripLeadingFlag(s.label),
    transport: transportSummary(s),
    raw: s,
  };
}

/** The subscription's OWN name (Profile-Title / a real title), or null. A
 *  location/server label is deliberately NOT used here — the subscription name
 *  is a separate thing; when it's absent the caller assigns "Configuration N" /
 *  "Subscription N". */
function deriveSubName(result: ImportResult): string | null {
  return result.meta.title?.trim() || null;
}

// Hydrate from localStorage once when the module first loads, before the
// SubsStore class fields are evaluated. (Referencing `this` from inside a
// `$state(...)` field initialiser blew up Svelte 5's compiled output.)
const _initialSubs = load();

class SubsStore {
  list = $state<Subscription[]>(_initialSubs.subs);
  selectedServerId = $state<string | null>(_initialSubs.selectedServerId);
  selectedKey = $state<string | null>(_initialSubs.selectedKey);
  importing = $state(false);

  private autoRefreshStarted = false;
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Re-resolve / auto-pick a location from the persisted state on startup.
    this.reconcileSelection();
  }

  private persist(): void {
    if (!browser) return;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        subs: this.list,
        selectedServerId: this.selectedServerId,
        selectedKey: this.selectedKey,
      }),
    );
  }

  selectServer(id: string): void {
    this.selectedServerId = id;
    const srv = this.list.flatMap((s) => s.servers).find((s) => s.id === id);
    if (srv) this.selectedKey = serverKey(srv);
    this.persist();
  }

  /** Keep a location selected: the per-entry `id` is regenerated on every parse
   *  (refresh/re-import), so resolve the selection by its stable host:port key,
   *  and auto-pick the first location when nothing is selected. */
  reconcileSelection(): void {
    const all = this.list.flatMap((s) => s.servers);
    if (all.length === 0) {
      this.selectedServerId = null;
      this.selectedKey = null;
      this.persist();
      return;
    }
    let current = all.find((s) => s.id === this.selectedServerId);
    if (!current && this.selectedKey) {
      current = all.find((s) => serverKey(s) === this.selectedKey);
    }
    if (!current) current = all[0];
    this.selectedServerId = current.id;
    this.selectedKey = serverKey(current);
    this.persist();
  }

  /** Parsed server for the current selection, or null if nothing is selected. */
  selectedServerRaw(): VlessServer | null {
    const id = this.selectedServerId;
    if (!id) return null;
    for (const sub of this.list) {
      const srv = sub.servers.find((s) => s.id === id);
      if (srv) return srv.raw;
    }
    return null;
  }

  toggleCollapse(subId: string): void {
    const s = this.list.find((x) => x.id === subId);
    if (s) {
      s.collapsed = !s.collapsed;
      this.persist();
    }
  }

  collapseAll(): void {
    for (const s of this.list) s.collapsed = true;
    this.persist();
  }

  expandAll(): void {
    for (const s of this.list) s.collapsed = false;
    this.persist();
  }

  remove(subId: string): void {
    this.list = this.list.filter((s) => s.id !== subId);
    this.reconcileSelection();
    this.prunePings();
    this.persist();
  }

  /** Pinned subscriptions first, otherwise insertion order (Array.sort is
   *  stable, so unpinned entries keep their relative order). */
  get ordered(): Subscription[] {
    return [...this.list].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }

  togglePin(subId: string): void {
    // Only one subscription may be pinned: pinning one unpins every other.
    const willPin = !this.list.find((s) => s.id === subId)?.pinned;
    this.list = this.list.map((s) =>
      s.id === subId ? { ...s, pinned: willPin } : { ...s, pinned: false },
    );
    this.persist();
  }

  /** Whether the provider sent any traffic figures — gates the traffic pill, so
   *  a bare config (no quota/usage) doesn't show a meaningless "0B". */
  hasTraffic(sub: Subscription): boolean {
    return sub.totalBytes > 0 || sub.usedBytes > 0;
  }

  trafficText(sub: Subscription): string {
    const used = formatBytes(sub.usedBytes);
    // No quota (total=0 = unlimited) → show just the bare used figure, not
    // "X/∞" — the infinity denominator is noise when there's no cap.
    if (sub.totalBytes > 0) return `${used}/${formatBytes(sub.totalBytes)}`;
    return used;
  }

  /** Next "Subscription N" for an unnamed remote import. */
  nextAutoName(kind: "Subscription"): string {
    const re = new RegExp(`^${kind} (\\d+)$`);
    let max = 0;
    for (const s of this.list) {
      const m = s.name.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${kind} ${max + 1}`;
  }

  expiresText(sub: Subscription): string | null {
    return formatExpires(sub.expiresAtUnix);
  }

  async importFromUrl(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) throw new Error("empty url");
    this.importing = true;
    try {
      const result = await fetchSubscription(
        trimmed,
        settings.subscriptionUserAgent,
      );
      if (result.servers.length === 0) {
        throw new Error("no servers found in this subscription");
      }
      const servers = result.servers.map(toServerEntry);
      const totalBytes = result.meta.total_bytes ?? 0;
      const usedBytes =
        (result.meta.upload_bytes ?? 0) + (result.meta.download_bytes ?? 0);

      const isUrl = isRemoteConfiguration(trimmed);
      const sub: Subscription = {
        id: crypto.randomUUID(),
        name:
          deriveSubName(result) ??
          (isUrl
            ? this.nextAutoName("Subscription")
            : servers.length === 1
              ? "Configuration"
              : "Configurations"),
        description: result.description,
        url: trimmed,
        importedAt: new Date().toISOString(),
        updateIntervalHours: result.meta.update_interval_hours ?? null,
        usedBytes,
        totalBytes,
        expiresAtUnix: result.meta.expires_at_unix,
        supportUrl: result.meta.support_url,
        webPageUrl: result.meta.web_page_url,
        sourceJson: result.source_json,
        jsonEdited: false,
        servers,
        collapsed: false,
        pinned: false,
      };
      this.list = isUrl
        ? [...this.list, sub]
        : mergeManualConfigurations([...this.list, sub]);
      // Auto-select the first location if none is chosen yet.
      this.reconcileSelection();
    } finally {
      this.importing = false;
    }
  }

  async refresh(subId: string): Promise<void> {
    const idx = this.list.findIndex((s) => s.id === subId);
    if (idx < 0) return;
    const sub = this.list[idx];
    // mark this sub as refreshing for the UI spinner
    this.list = this.list.map((s) =>
      s.id === subId ? { ...s, refreshing: true } : s,
    );
    try {
      const result = await fetchSubscription(
        sub.url,
        settings.subscriptionUserAgent,
      );
      if (result.servers.length === 0) {
        this.list = this.list.map((s) =>
          s.id === subId ? { ...s, refreshing: false } : s,
        );
        return;
      }
      // A present Subscription-Userinfo header is AUTHORITATIVE: an absent
      // key means "no quota / never expires" and must CLEAR the stored value
      // (e.g. a plan upgraded to unlimited previously kept showing the old
      // expiry forever). Only when the header is missing entirely do we keep
      // what we knew.
      const info = result.meta.has_userinfo;
      const totalBytes = info ? (result.meta.total_bytes ?? 0) : sub.totalBytes;
      const usedBytes = info
        ? (result.meta.upload_bytes ?? 0) + (result.meta.download_bytes ?? 0)
        : sub.usedBytes;
      const freshServers = result.servers.map(toServerEntry);
      this.list = this.list.map((s) =>
        s.id === subId
          ? {
              ...s,
              name: result.meta.title ?? s.name,
              description: result.description ?? s.description,
              servers: freshServers,
              updateIntervalHours:
                result.meta.update_interval_hours ?? s.updateIntervalHours,
              usedBytes,
              totalBytes,
              expiresAtUnix: info
                ? (result.meta.expires_at_unix ?? null)
                : s.expiresAtUnix,
              supportUrl: result.meta.support_url,
              webPageUrl: result.meta.web_page_url,
              sourceJson: result.source_json,
              jsonEdited: false,
              importedAt: new Date().toISOString(),
              refreshing: false,
            }
          : s,
      );
      // The server IDs were just regenerated — re-resolve the selection from its
      // stable key so the chosen location stays chosen.
      this.reconcileSelection();
      // The old server IDs were just dropped (new ones are random) — drop their
      // now-dead ping entries.
      this.prunePings();
    } catch (e) {
      console.error("refresh failed:", e);
      this.list = this.list.map((s) =>
        s.id === subId ? { ...s, refreshing: false } : s,
      );
    }
  }

  /** Validate and atomically apply edited subscription JSON. Remote sources keep
   *  their URL so an explicit Refresh can restore the provider's version. */
  async updateJson(subId: string, source: string): Promise<void> {
    const sub = this.list.find((s) => s.id === subId);
    if (!sub) throw new Error("subscription not found");
    const trimmed = source.trim();
    if (!trimmed) throw new Error("empty JSON");

    const result = await fetchSubscription(
      trimmed,
      settings.subscriptionUserAgent,
    );
    if (!result.source_json || result.servers.length === 0) {
      throw new Error("no servers found in the JSON");
    }

    const freshServers = result.servers.map(toServerEntry);
    const remote = isRemoteSource(sub.url);
    this.list = this.list.map((s) =>
      s.id === subId
        ? {
            ...s,
            url: remote ? s.url : trimmed,
            sourceJson: result.source_json,
            jsonEdited: remote,
            servers: freshServers,
            importedAt: new Date().toISOString(),
          }
        : s,
    );
    this.reconcileSelection();
    this.prunePings();
  }

  /** Start the background auto-refresh loop: each subscription is re-fetched
   *  once its server-advertised interval has elapsed since the last update
   *  (`importedAt` is bumped on every successful refresh, so it survives
   *  restarts). Safe to call once on app start — checks immediately, then every
   *  few minutes so long-running sessions pick up due refreshes. Idempotent. */
  startAutoRefresh(): void {
    if (this.autoRefreshStarted) return;
    this.autoRefreshStarted = true;
    const check = () => void this.refreshDue();
    void this.rehydratePersistedJson().finally(check);
    this.autoRefreshTimer = setInterval(check, 5 * 60 * 1000);
  }

  /** Reparse JSON already cached by 0.2.0 with the new lossless parser. This is
   *  deliberately local-only: it fixes old IP:port labels immediately without
   *  fetching the subscription URL or overwriting a user's local JSON edit. */
  private async rehydratePersistedJson(): Promise<void> {
    const stale = this.list.filter(
      (sub) =>
        sub.sourceJson &&
        !sub.jsonEdited &&
        sub.servers.some(
          (server) =>
            server.raw.source_json == null || server.raw.raw_outbound == null,
        ),
    );
    let changed = false;
    for (const sub of stale) {
      if (!sub.sourceJson) continue;
      try {
        const parsed = await parseSubscriptionBody(sub.sourceJson);
        if (parsed.length === 0) continue;
        this.list = this.list.map((current) =>
          current.id === sub.id
            ? { ...current, servers: parsed.map(toServerEntry) }
            : current,
        );
        changed = true;
      } catch (error) {
        console.error("cached JSON migration failed:", error);
      }
    }
    if (changed) {
      this.reconcileSelection();
      this.prunePings();
    }
  }

  /** Refresh every subscription whose update interval has elapsed. */
  private async refreshDue(): Promise<void> {
    const now = Date.now();
    const due = this.list.filter((s) => {
      if (s.jsonEdited) return false;
      if (!s.updateIntervalHours || s.updateIntervalHours <= 0) return false;
      if (s.refreshing) return false;
      const last = Date.parse(s.importedAt);
      if (Number.isNaN(last)) return true; // unknown last-update → refresh now
      return now - last >= s.updateIntervalHours * 3_600_000;
    });
    // Sequential so we don't hammer the panel when several are due at once.
    for (const s of due) {
      await this.refresh(s.id);
    }
  }

  rename(subId: string, newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed) return;
    this.list = this.list.map((s) =>
      s.id === subId ? { ...s, name: trimmed } : s,
    );
    this.persist();
  }

  /** Apply a validated location JSON edit while preserving the UI row identity.
   *  Automatic refresh pauses so a background fetch cannot silently overwrite
   *  the local edit; an explicit refresh still restores the provider version. */
  updateServer(serverId: string, raw: VlessServer): ServerEntry {
    let updated: ServerEntry | null = null;
    this.list = this.list.map((sub) => {
      const current = sub.servers.find((server) => server.id === serverId);
      if (!current) return sub;
      const normalized = { ...raw, id: current.raw.id };
      updated = {
        ...current,
        flag: flagFor(normalized.label),
        name: stripLeadingFlag(normalized.label),
        transport: transportSummary(normalized),
        raw: normalized,
      };
      return {
        ...sub,
        jsonEdited: true,
        servers: sub.servers.map((server) => (server.id === serverId ? updated! : server)),
      };
    });
    if (!updated) throw new Error("location not found");
    if (this.selectedServerId === serverId) this.selectedKey = serverKey(updated);
    const { [serverId]: _stalePing, ...remainingPings } = this.pings;
    this.pings = remainingPings;
    this.persist();
    return updated;
  }

  // Ephemeral per-server ping state. Not persisted, and never measured
  // automatically — the user triggers pings explicitly via the ping button.
  pings = $state<Record<string, PingState>>({});

  /** Drop ping entries for servers that no longer exist — refresh() replaces a
   *  sub's server IDs and remove() deletes a sub, so without this `pings` would
   *  accumulate dead keys over a session. */
  private prunePings(): void {
    const live = new Set(this.list.flatMap((s) => s.servers).map((s) => s.id));
    const pruned: Record<string, PingState> = {};
    for (const id of Object.keys(this.pings)) {
      if (live.has(id)) pruned[id] = this.pings[id];
    }
    this.pings = pruned;
  }

  /** Probe one server with the user's chosen method (TCP or via-proxy real
   *  delay). Updates `pings[id]` in place; never throws. */
  async pingServer(srv: ServerEntry, method: PingMethod = settings.pingMethod): Promise<void> {
    this.pings = { ...this.pings, [srv.id]: "pinging" };
    try {
      const rtt =
        method === "proxy"
          ? await proxyGetPing(srv.raw, 5000)
          : await tcpPingHost(srv.raw.host, srv.raw.port, 2500);
      this.pings = { ...this.pings, [srv.id]: rtt };
    } catch {
      this.pings = { ...this.pings, [srv.id]: "timeout" };
    }
  }

  /** Probe a batch with bounded concurrency. Proxy pings each spin a throwaway
   *  xray, so they run far fewer at a time than the cheap TCP probes. The
   *  method is captured once so a mid-batch settings change stays consistent. */
  private async pingMany(servers: ServerEntry[]): Promise<void> {
    const method = settings.pingMethod;
    // TCP probes are cheap (a connect) so run them all but for a sanity cap.
    // Proxy probes each spin a throwaway xray, so keep that more bounded.
    const limit = method === "proxy" ? 8 : 32;
    // Mark the whole batch in-flight up front so every old result clears at
    // once, instead of one-by-one as the bounded-concurrency workers reach
    // each server (the actual probing stays rate-limited below).
    const next = { ...this.pings };
    for (const s of servers) next[s.id] = "pinging";
    this.pings = next;
    let i = 0;
    const worker = async () => {
      while (i < servers.length) await this.pingServer(servers[i++], method);
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, servers.length) }, worker),
    );
  }

  /** Probe every server across every subscription. Safe to call while one is
   *  already in flight; the in-flight ones just get overwritten. */
  async pingAll(): Promise<void> {
    this.prunePings();
    await this.pingMany(this.list.flatMap((s) => s.servers));
  }

  /** Probe every server inside a single subscription. Used by the
   *  per-subscription ping button. */
  async pingSub(subId: string): Promise<void> {
    const sub = this.list.find((s) => s.id === subId);
    if (!sub) return;
    await this.pingMany(sub.servers);
  }

  /** True iff at least one server in this subscription has an in-flight probe. */
  isSubPinging(subId: string): boolean {
    const sub = this.list.find((s) => s.id === subId);
    if (!sub) return false;
    return sub.servers.some((srv) => this.pings[srv.id] === "pinging");
  }
}

export const subs = new SubsStore();
