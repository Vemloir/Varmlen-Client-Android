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
  resolveSelection,
  serverKey,
  type SelectionIdentity,
} from "$lib/subscription-selection";
import {
  nextFutureRefresh,
  nextRefreshBatch,
} from "$lib/subscription-refresh";
import { runPingsInParallel } from "$lib/ping-scheduler";
import {
  locationKey,
  migrateLocationKeys,
  selectedLocationSignature,
} from "$lib/location-identity";
import { hasTraffic, trafficPercent } from "$lib/traffic";
import { measureLocationPing } from "$lib/location-ping";
import {
  hiddenCount as countHidden,
  locationActions as menuForLocation,
  orderLocations,
  type LocationAction,
} from "$lib/location-actions";
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
  /** Row keys (`locationKey`: endpoint + label) the user hid from this card. Not
   *  entry ids -- a refresh regenerates every id -- and not the bare endpoint,
   *  because two rows can share one endpoint. */
  hiddenKeys?: string[];
  /** Endpoint key -> the moment it was pinned, so the pinned block can be
   *  ordered by pin time instead of by latency. */
  pinnedLocations?: Record<string, number>;
  /** Why the last update failed, or null/absent when the last update worked. A
   *  failed update keeps the previous locations, so without this the subscription
   *  simply grows stale with no trace of why. Optional because it did not exist
   *  before 0.4.0, and it describes the last attempt this window made. */
  lastError?: string | null;
  /** True while refresh() is in flight. Not persisted. */
  refreshing?: boolean;
}

interface Persisted {
  subs: Subscription[];
  selectedServerId: string | null;
  /** Stable host:port of the selection — survives a refresh (which reassigns the
   *  per-entry random ids) so the chosen location stays chosen. */
  selectedKey: string | null;
  /** Which subscription and which location label the user picked. A provider
   *  rotates the endpoint hosts inside a profile (a composite profile's host is
   *  its first proxy outbound), so `selectedKey` alone can stop matching after a
   *  refresh while the location the user chose is still there. */
  selectedSubId: string | null;
  selectedLabel: string | null;
}

const KEY = "varmlen.subs";

/** Shown when the fetch worked but yielded nothing usable -- the usual sign of a
 *  provider that answered with an error page or a format we cannot parse. */
export const NO_LOCATIONS_ERROR = "subscription returned no locations";

/** A fetch error is a transport string; keep the URL out of it and keep the
 *  message short enough to render in the subscription card. */
function describeError(e: unknown, url: string): string {
  const raw =
    e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  const text = (raw || "unknown error").replace(url, "<subscription>").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

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
    // Hidden/pinned keys were endpoint-only before rows were told apart by label.
    migrateLocationKeys(sub);
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
  const empty: Persisted = {
    subs: [],
    selectedServerId: null,
    selectedKey: null,
    selectedSubId: null,
    selectedLabel: null,
  };
  if (!browser) return empty;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
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
    const selectedSubId =
      typeof parsed.selectedSubId === "string" ? parsed.selectedSubId : null;
    const selectedLabel =
      typeof parsed.selectedLabel === "string" ? parsed.selectedLabel : null;
    return {
      subs,
      selectedServerId: selected,
      selectedKey,
      selectedSubId,
      selectedLabel,
    };
  } catch {
    return empty;
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
  selectedSubId = $state<string | null>(_initialSubs.selectedSubId);
  selectedLabel = $state<string | null>(_initialSubs.selectedLabel);
  /** The chosen location is missing from the subscription right now. Set by
   *  reconcileSelection; the UI says so instead of another location being picked. */
  selectionLost = $state(false);
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
        selectedSubId: this.selectedSubId,
        selectedLabel: this.selectedLabel,
      }),
    );
    this.rescheduleAutoRefresh();
  }

  /** The selected location as a connection tells locations apart; see
   *  `selectedLocationSignature`. */
  get selectedLocation(): string | null {
    return selectedLocationSignature({
      subId: this.selectedSubId,
      key: this.selectedKey,
      label: this.selectedLabel,
    });
  }

  selectServer(id: string): void {
    this.selectedServerId = id;
    for (const sub of this.list) {
      const srv = sub.servers.find((s) => s.id === id);
      if (!srv) continue;
      this.selectedKey = serverKey(srv);
      this.selectedSubId = sub.id;
      this.selectedLabel = srv.name;
      this.selectionLost = false;
      break;
    }
    this.persist();
  }

  /** Where the selection came from, before and after a refresh. */
  private selectionIdentity(): SelectionIdentity {
    return {
      serverId: this.selectedServerId,
      key: this.selectedKey,
      subId: this.selectedSubId,
      label: this.selectedLabel,
    };
  }

  /** Keep a location selected across a refresh: the per-entry `id` is
   *  regenerated on every parse, so fall back to the stable host key and then to
   *  the same label inside the same subscription. A location that vanished leaves
   *  nothing selected instead of jumping the user to another country. */
  reconcileSelection(): void {
    const before = this.selectionIdentity();
    const resolved = resolveSelection(this.list, before);
    this.selectedServerId = resolved.serverId;
    this.selectedKey = resolved.key;
    this.selectedSubId = resolved.subId;
    this.selectedLabel = resolved.label;
    this.selectionLost = resolved.lost;
    if (
      resolved.serverId !== before.serverId ||
      resolved.key !== before.key ||
      resolved.subId !== before.subId ||
      resolved.label !== before.label ||
      resolved.lost
    ) {
      this.persist();
    }
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

  /** Pinned subscriptions first, then the manually added configurations (they are
   *  the things the user reaches for when a provider fleet is down), then every
   *  other subscription. Array.sort is stable, so each group keeps its own order. */
  get ordered(): Subscription[] {
    const rank = (sub: Subscription): number =>
      sub.pinned ? 0 : this.isManualCard(sub) ? 1 : 2;
    return [...this.list].sort((a, b) => rank(a) - rank(b));
  }

  /** A manually added configuration: nothing fetches it, so it has no refresh,
   *  no expiry and no quota, and its locations can be deleted for real. */
  isManualCard(sub: Subscription): boolean {
    return !isRemoteConfiguration(sub.url);
  }

  /** The list for the card: hidden locations drop out, pinned ones move to the
   *  TOP (ordered by pin time). `revealHidden` shows the hidden ones again
   *  without un-hiding them. */
  visibleLocations(sub: Subscription, revealHidden = false): ServerEntry[] {
    return orderLocations(sub.servers, {
      keyOf: (server) => locationKey(server),
      hiddenKeys: sub.hiddenKeys ?? [],
      pinnedAt: sub.pinnedLocations ?? {},
      revealHidden,
      pinOrder: settings.pinOrder,
    }).visible;
  }

  hiddenCount(sub: Subscription): number {
    return countHidden(
      sub.servers,
      (server) => locationKey(server),
      sub.hiddenKeys ?? [],
    );
  }

  /** Hidden endpoint keys resolved to the entries they match right now, so the
   *  list can dim them while the card reveals them. */
  hiddenLocationIds(sub: Subscription): string[] {
    const hidden = sub.hiddenKeys ?? [];
    if (hidden.length === 0) return [];
    return sub.servers
      .filter((s) => hidden.includes(locationKey(s)))
      .map((s) => s.id);
  }

  /** Pinned endpoint keys resolved to the entries they match right now, so the
   *  row can show the same pin mark a pinned card shows. */
  locationPinnedIds(sub: Subscription): string[] {
    const pinned = sub.pinnedLocations ?? {};
    if (Object.keys(pinned).length === 0) return [];
    return sub.servers
      .filter((s) => locationKey(s) in pinned)
      .map((s) => s.id);
  }

  isLocationHidden(sub: Subscription, server: ServerEntry): boolean {
    return (sub.hiddenKeys ?? []).includes(locationKey(server));
  }

  isLocationPinned(sub: Subscription, server: ServerEntry): boolean {
    return locationKey(server) in (sub.pinnedLocations ?? {});
  }

  /** The action set for one location: hide for a subscription, delete for a
   *  manually added configuration. */
  locationActionsFor(sub: Subscription, server: ServerEntry): LocationAction[] {
    return menuForLocation({
      fromSubscription: !this.isManualCard(sub),
      hidden: this.isLocationHidden(sub, server),
      pinned: this.isLocationPinned(sub, server),
    });
  }

  toggleHideLocation(subId: string, server: ServerEntry): void {
    const key = locationKey(server);
    this.list = this.list.map((s) => {
      if (s.id !== subId) return s;
      const hidden = s.hiddenKeys ?? [];
      return {
        ...s,
        hiddenKeys: hidden.includes(key)
          ? hidden.filter((k) => k !== key)
          : [...hidden, key],
      };
    });
    this.persist();
  }

  togglePinLocation(subId: string, server: ServerEntry): void {
    const key = locationKey(server);
    this.list = this.list.map((s) => {
      if (s.id !== subId) return s;
      const pinned = { ...(s.pinnedLocations ?? {}) };
      if (key in pinned) delete pinned[key];
      else pinned[key] = Date.now();
      return { ...s, pinnedLocations: pinned };
    });
    this.persist();
  }

  /** Remove a manually added location for good. When the last one goes, the card
   *  that only held it goes with it -- a configuration has no other way to be
   *  deleted, since its card carries no menu. */
  deleteLocation(subId: string, serverId: string): void {
    const sub = this.list.find((s) => s.id === subId);
    if (!sub || !this.isManualCard(sub)) return;
    const kept = sub.servers.filter((s) => s.id !== serverId);
    this.list =
      kept.length === 0
        ? this.list.filter((s) => s.id !== subId)
        : this.list.map((s) => (s.id === subId ? { ...s, servers: kept } : s));
    this.reconcileSelection();
    this.prunePings();
    this.persist();
  }

  togglePin(subId: string): void {
    // Only one subscription may be pinned: pinning one unpins every other.
    const willPin = !this.list.find((s) => s.id === subId)?.pinned;
    this.list = this.list.map((s) =>
      s.id === subId ? { ...s, pinned: willPin } : { ...s, pinned: false },
    );
    this.persist();
  }

  /** Cards whose hidden locations the user is looking at right now. Revealing is
   *  temporary and per card -- it shows them dimmed without un-hiding anything --
   *  and it lives in the store rather than in the page, because switching to
   *  Settings and back re-creates the page component and the card started
   *  pretending the user had never asked to see them. */
  revealedHidden = $state<Set<string>>(new Set());

  isRevealed(subId: string): boolean {
    return this.revealedHidden.has(subId);
  }

  toggleRevealed(subId: string): void {
    const next = new Set(this.revealedHidden);
    if (next.has(subId)) next.delete(subId);
    else next.add(subId);
    this.revealedHidden = next;
  }

  /** Whether the provider sent any traffic figures. The strip is drawn either way;
   *  this only decides whether it shows numbers or says there are none. */
  hasTraffic(sub: Subscription): boolean {
    return hasTraffic(sub.usedBytes, sub.totalBytes);
  }

  /** How full the strip is, 0-100. No quota means no fraction to draw: an unknown
   *  total is not an infinite bar, it is a bar with nothing known about it. */
  trafficPercent(sub: Subscription): number {
    return trafficPercent(sub.usedBytes, sub.totalBytes);
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

  async refresh(
    subId: string,
    reschedule = true,
    manual = true,
  ): Promise<void> {
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
          s.id === subId
            ? { ...s, refreshing: false, lastError: NO_LOCATIONS_ERROR }
            : s,
        );
        return;
      }
      this.applyProviderResult(subId, result, new Date().toISOString());
      // Nothing here restores a hidden location, not even an explicit Refresh: the
      // user hid that row and only he brings it back (the card's "N hidden" line),
      // or he removes the subscription and imports it again. A refresh is the
      // provider's business, not the user's undo button.
    } catch (e) {
      console.error("refresh failed:", e);
      this.list = this.list.map((s) =>
        s.id === subId
          ? { ...s, refreshing: false, lastError: describeError(e, sub.url) }
          : s,
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
    // The latest response is authoritative, full stop — no falling back to
    // cached quota/expiry from a previous fetch. If this response doesn't
    // carry a value, there is no value: show nothing rather than stale data.
    const totalBytes = result.meta.total_bytes ?? 0;
    const usedBytes =
      (result.meta.upload_bytes ?? 0) + (result.meta.download_bytes ?? 0);
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
            expiresAtUnix: result.meta.expires_at_unix ?? null,
            supportUrl: result.meta.support_url,
            webPageUrl: result.meta.web_page_url,
            sourceJson: result.source_json,
            jsonEdited: false,
            importedAt,
            refreshing: false,
            // The locations the card shows came from this response, so whatever
            // the previous attempt complained about is no longer true.
            lastError: null,
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
      await this.refresh(id, false, false);
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

  /** Probe one server with the user's chosen method. UDP-only transports use
   *  their end-to-end proxy RTT because their endpoint has no TCP latency. */
  async pingServer(srv: ServerEntry, method: PingMethod = settings.pingMethod): Promise<void> {
    this.pings = { ...this.pings, [srv.id]: "pinging" };
    try {
      const rtt = await measureLocationPing(srv.raw, method, {
        tcpPingHost,
        proxyGetPing,
      });
      this.pings = { ...this.pings, [srv.id]: rtt };
    } catch {
      this.pings = { ...this.pings, [srv.id]: "timeout" };
    }
  }

  /** Probe every location in the batch concurrently. Each composite JSON
   *  location uses one temporary Xray process for all of its concrete paths,
   *  so an additional frontend queue makes large subscriptions unnecessarily
   *  slow. The method is captured once for a consistent batch. */
  private async pingMany(servers: ServerEntry[]): Promise<void> {
    const method = settings.pingMethod;
    // Mark the whole batch in-flight up front so every old result clears at
    // once instead of one-by-one as the probes finish.
    const next = { ...this.pings };
    for (const s of servers) next[s.id] = "pinging";
    this.pings = next;
    await runPingsInParallel(
      servers,
      (server) => this.pingServer(server, method),
      settings.pingConcurrency,
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
