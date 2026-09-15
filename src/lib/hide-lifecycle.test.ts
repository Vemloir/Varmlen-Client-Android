// @vitest-environment happy-dom

/** The lifetime of a hidden location, as the user asked for it: hiding is
 *  durable (a background update must not undo it), an explicit Refresh on the
 *  card may, and deleting the subscription and importing it again always brings
 *  every location back -- that is a new subscription, not a refresh of the old
 *  one. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchSubscription } = vi.hoisted(() => ({ fetchSubscription: vi.fn() }));

vi.mock("$lib/api", () => ({
  fetchSubscription,
  parseSubscriptionBody: vi.fn(async () => []),
  flagFor: () => null,
  stripLeadingFlag: (label: string) => label,
  formatBytes: (n: number) => `${n}`,
  formatExpires: () => null,
  tcpPingHost: () => null,
  proxyGetPing: vi.fn(async () => null),
}));

import { settings } from "$lib/settings.svelte";
import { subs } from "$lib/subs.svelte";

const URL = "https://provider.example/sub/abc";

const server = (label: string, i: number) => ({
  protocol: "vless",
  uuid: `11111111-1111-4111-8111-11111111111${i}0`,
  security: "reality",
  port: 443,
  host: `h${i}.example.com`,
  sni: "example.com",
  uids: null,
  label,
  transport: "tcp",
  flow: "",
  password: null,
  method: null,
  path: null,
  public_key: null,
  short_id: null,
});

const reply = (labels: string[]) => ({
  meta: { title: "Proxen" },
  servers: labels.map(server),
  description: null,
  source_json: null,
});

const card = () => subs.list.find((s) => s.url === URL)!;
const names = () => subs.visibleLocations(card()).map((s) => s.name);

describe("hidden locations across the subscription's life", () => {
  beforeEach(async () => {
    // The store is a module singleton; without this, cards (and their hidden and
    // pinned keys) leak from one case into the next.
    subs.list = [];
    localStorage.clear();
    fetchSubscription.mockReset();
    fetchSubscription.mockResolvedValue(reply(["Finland", "Germany", "Berlin"]));
    await subs.importFromUrl(URL);
  });

  it("hides the one location and keeps the others", () => {
    subs.toggleHideLocation(card().id, card().servers[1]);
    expect(names()).toEqual(["Finland", "Berlin"]);
    expect(subs.hiddenCount(card())).toBe(1);
  });

  it("brings every location back when the subscription is removed and imported again", async () => {
    subs.toggleHideLocation(card().id, card().servers[1]);
    subs.togglePinLocation(card().id, card().servers[2]);
    expect(subs.hiddenCount(card())).toBe(1);

    subs.remove(card().id);
    expect(subs.list).toHaveLength(0);

    await subs.importFromUrl(URL);
    const fresh = card();
    // Hiding belongs to the subscription the user acted on. A re-import is a new
    // subscription, so it starts with nothing hidden and nothing pinned.
    expect(subs.hiddenCount(fresh)).toBe(0);
    expect(subs.locationPinnedIds(fresh)).toEqual([]);
    expect(names()).toEqual(["Finland", "Germany", "Berlin"]);
  });

  it("keeps the location hidden through a background update", async () => {
    subs.toggleHideLocation(card().id, card().servers[1]);
    await subs.refresh(card().id, false, false);
    expect(names()).toEqual(["Finland", "Berlin"]);
  });

  it("keeps it hidden through an explicit refresh too -- a refresh is not an undo", async () => {
    subs.toggleHideLocation(card().id, card().servers[1]);
    await subs.refresh(card().id, false, true);
    expect(names()).toEqual(["Finland", "Berlin"]);
    expect(subs.hiddenCount(card())).toBe(1);
  });

  it("shows the hidden ones again through the card, without un-hiding them", () => {
    const sub = card();
    subs.toggleHideLocation(sub.id, sub.servers[1]);
    expect(subs.isRevealed(sub.id)).toBe(false);

    subs.toggleRevealed(sub.id);
    expect(subs.isRevealed(sub.id)).toBe(true);
    expect(subs.visibleLocations(card(), true).map((s) => s.name)).toEqual([
      "Finland",
      "Germany",
      "Berlin",
    ]);
    // the row is still hidden: the card is only showing it to him
    expect(subs.hiddenCount(card())).toBe(1);

    subs.toggleRevealed(sub.id);
    expect(subs.isRevealed(sub.id)).toBe(false);
    expect(names()).toEqual(["Finland", "Berlin"]);
  });
});