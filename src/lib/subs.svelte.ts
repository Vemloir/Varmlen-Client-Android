import { browser } from "$app/environment";
import {
  fetchSubscription,
  parseSubscriptionBody,
  parseSubscriptionResponse,
  flagFor,
  stripLeadingFlag,
  formatBytes,
  formatExpires,
  tcpPingHost,
  proxyGetPing,
  type ImportResult,
  type StagedSubscriptionResponse,
  type SubscriptionRefreshSchedule,
  type VlessServer,
} from "$lib/api";
import { settings, type PingMethod } from "$lib/settings.svelte";
import { isRemoteSource } from "$lib/subscription-json";
import {
  isRemoteConfiguration,
  mergeManualConfigurations,
} from "$lib/manual-configurations";
import {
  compileFieldDraft,
  type LocationEditDraft,
} from "$lib/location-draft";
import { transportSummary } from "$lib/server-label";
import {
  nextFutureRefresh,
  nextRefreshBatch,
} from "$lib/subscription-refresh";
export { transportSummary } from "$lib/server-label";

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
  editDraft: LocationEditDraft | null;
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
  /** Whether the subscription JSON currently differs from its remote source. */
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
      if (srv.editDraft === undefined) srv.editDraft = null;
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
    editDraft: null,
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
  /** Increments when provider data is applied. ConnStore uses it to absorb the
   * new config without reconnecting an already-running tunnel. */
  providerRefreshRevision = $state(0);

  private autoRefreshStarted = false;
  private autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private persistedJsonRehydrated = false;

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
    this.rescheduleAutoRefresh();
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

  /** Compile the persisted edit draft for the current selection. Draft text is
   *  authoritative: invalid edits fail instead of silently using stale data. */
  async selectedServerRaw(): Promise<VlessServer | null> {
    const id = this.selectedServerId;
    if (!id) return null;
    for (const sub of this.list) {
      const srv = sub.servers.find((s) => s.id === id);
      if (!srv) continue;
      const draft = srv.editDraft;
      if (!draft) return srv.raw;
      if (draft.kind === "fields") {
        const compiled = compileFieldDraft(draft, srv.raw);
        if (!compiled.ok) throw new Error(compiled.error);
        return compiled.server;
      }
      const parsed = await parseSubscriptionBody(draft.source);
      if (parsed.length !== 1) {
        throw new Error(
          `location JSON must contain exactly one proxy (found ${parsed.length})`,
        );
      }
      return parsed[0];
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

  async refresh(subId: string, reschedule = true): Promise<void> {
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
      this.applyProviderResult(subId, result, new Date().toISOString());
    } catch (e) {
      console.error("refresh failed:", e);
      this.list = this.list.map((s) =>
        s.id === subId ? { ...s, refreshing: false } : s,
      );
    } finally {
      if (reschedule) this.rescheduleAutoRefresh();
    }
  }

  /** Schedules passed to WorkManager. Only real remote subscriptions with a
   * provider interval participate; pasted/manual configurations never do. */
  backgroundRefreshSchedules(
    userAgent: SubscriptionRefreshSchedule["userAgent"],
    now = Date.now(),
  ): SubscriptionRefreshSchedule[] {
    return this.list.flatMap((sub) => {
      if (
        !isRemoteSource(sub.url) ||
        !sub.updateIntervalHours ||
        sub.updateIntervalHours <= 0
      ) {
        return [];
      }
      try {
        return [{
          id: sub.id,
          url: sub.url,
          userAgent,
          intervalHours: sub.updateIntervalHours,
          lastSuccessAt: Date.parse(sub.importedAt),
          nextUpdateAt: nextFutureRefresh(
            sub.importedAt,
            sub.updateIntervalHours,
            now,
          ),
        }];
      } catch {
        return [];
      }
    });
  }

  /** Parse and apply responses fetched while the WebView was closed. No network
   * request is made here; stale results older than current state are ignored. */
  async applyStagedRefreshes(
    responses: StagedSubscriptionResponse[],
  ): Promise<void> {
    for (const response of responses) {
      const sub = this.list.find((item) => item.id === response.id);
      if (!sub || response.refreshedAt <= Date.parse(sub.importedAt)) continue;
      try {
        const result = await parseSubscriptionResponse(
          response.body,
          response.headers,
        );
        if (result.servers.length === 0) continue;
        this.applyProviderResult(
          response.id,
          result,
          new Date(response.refreshedAt).toISOString(),
        );
      } catch (error) {
        console.error("staged subscription refresh failed:", error);
      }
    }
  }

  private applyProviderResult(
    subId: string,
    result: ImportResult,
    importedAt: string,
  ): void {
    const previous = this.list.find((sub) => sub.id === subId);
    if (!previous || result.servers.length === 0) return;
    // A present Subscription-Userinfo header is authoritative. Missing quota
    // or expiry values therefore clear old finite-plan data.
    const info = result.meta.has_userinfo;
    const totalBytes = info
      ? (result.meta.total_bytes ?? 0)
      : previous.totalBytes;
    const usedBytes = info
      ? (result.meta.upload_bytes ?? 0) + (result.meta.download_bytes ?? 0)
      : previous.usedBytes;
    const freshServers = result.servers.map(toServerEntry);
    this.list = this.list.map((sub) =>
      sub.id === subId
        ? {
            ...sub,
            name: result.meta.title ?? sub.name,
            description: result.description ?? sub.description,
            servers: freshServers,
            updateIntervalHours:
              result.meta.update_interval_hours ?? sub.updateIntervalHours,
            usedBytes,
            totalBytes,
            expiresAtUnix: info
              ? (result.meta.expires_at_unix ?? null)
              : sub.expiresAtUnix,
            supportUrl: result.meta.support_url,
            webPageUrl: result.meta.web_page_url,
            sourceJson: result.source_json,
            jsonEdited: false,
            importedAt,
            refreshing: false,
          }
        : sub,
    );
    this.reconcileSelection();
    this.prunePings();
    this.providerRefreshRevision += 1;
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

  /** Start exact future-boundary scheduling without fetching on application
   *  mount. Missed cycles are skipped by nextRefreshBatch. */
  startAutoRefresh(): () => void {
    if (this.autoRefreshStarted) return () => this.stopAutoRefresh();
    this.autoRefreshStarted = true;
    if (!this.persistedJsonRehydrated) {
      this.persistedJsonRehydrated = true;
      void this.rehydratePersistedJson().finally(() =>
        this.rescheduleAutoRefresh(),
      );
    } else {
      this.rescheduleAutoRefresh();
    }
    return () => this.stopAutoRefresh();
  }

  stopAutoRefresh(): void {
    this.autoRefreshStarted = false;
    if (this.autoRefreshTimer !== null) clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
  }

  /** Cancel the old timer and schedule exactly the earliest future boundary. */
  rescheduleAutoRefresh(): void {
    if (this.autoRefreshTimer !== null) clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
    if (!this.autoRefreshStarted || !settings.subscriptionAutoUpdate) return;

    const batch = nextRefreshBatch(
      this.list.map((sub) => ({
        id: sub.id,
        lastSuccessIso: sub.importedAt,
        intervalHours: sub.updateIntervalHours,
      })),
      Date.now(),
    );
    if (!batch) return;

    // Browsers clamp larger timeouts; wake once at the clamp and schedule the
    // remaining span without performing a premature refresh.
    const maxDelay = 2_147_000_000;
    const delay = Math.min(Math.max(0, batch.at - Date.now()), maxDelay);
    this.autoRefreshTimer = setTimeout(() => {
      this.autoRefreshTimer = null;
      if (Date.now() + 1_000 < batch.at) {
        this.rescheduleAutoRefresh();
        return;
      }
      void this.refreshAutoBatch(batch.ids);
    }, delay);
  }

  private async refreshAutoBatch(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!this.autoRefreshStarted || !settings.subscriptionAutoUpdate) break;
      await this.refresh(id, false);
    }
    this.rescheduleAutoRefresh();
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

  rename(subId: string, newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed) return;
    this.list = this.list.map((s) =>
      s.id === subId ? { ...s, name: trimmed } : s,
    );
    this.persist();
  }

  /** Persist any location edit, including invalid text. When it can be parsed,
   *  also update the row immediately; provider refresh remains authoritative. */
  async saveServerDraft(
    serverId: string,
    draft: LocationEditDraft,
  ): Promise<ServerEntry> {
    let compiled: VlessServer | null = null;
    if (draft.kind === "fields") {
      const current = this.list
        .flatMap((sub) => sub.servers)
        .find((server) => server.id === serverId);
      if (!current) throw new Error("location not found");
      const result = compileFieldDraft(draft, current.raw);
      if (result.ok) compiled = result.server;
    } else {
      const parsed = await parseSubscriptionBody(draft.source);
      if (parsed.length === 1) compiled = parsed[0];
    }

    let updated: ServerEntry | null = null;
    this.list = this.list.map((sub) => ({
      ...sub,
      servers: sub.servers.map((current) => {
        if (current.id !== serverId) return current;
        const raw = compiled
          ? { ...compiled, id: current.raw.id }
          : current.raw;
        updated = {
          ...current,
          flag: flagFor(raw.label),
          name: stripLeadingFlag(raw.label),
          transport: transportSummary(raw),
          raw,
          editDraft: structuredClone(draft),
        };
        return updated;
      }),
    }));
    if (!updated) throw new Error("location not found");
    if (this.selectedServerId === serverId && compiled) {
      this.selectedKey = serverKey(updated);
    }
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
