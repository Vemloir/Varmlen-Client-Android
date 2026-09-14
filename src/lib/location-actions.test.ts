import { describe, expect, it } from "vitest";
import {
  hiddenCount,
  isHiddenLocation,
  locationActions,
  orderLocations,
} from "./location-actions";

interface Row {
  id: string;
  key: string;
}

const row = (id: string, key = `vless:${id}:443:u`): Row => ({ id, key });
const keyOf = (r: Row) => r.key;

const order = (
  servers: Row[],
  over: Partial<Parameters<typeof orderLocations<Row>>[1]> = {},
) =>
  orderLocations(servers, {
    keyOf,
    hiddenKeys: [],
    pinnedAt: {},
    revealHidden: false,
    pinOrder: "newestLast",
    ...over,
  });

describe("location menu", () => {
  it("offers hide, never delete, for a location from a subscription", () => {
    expect(
      locationActions({
        fromSubscription: true,
        hidden: false,
        pinned: false,
      }),
    ).toEqual(["ping", "rename", "pin", "hide"]);
  });

  it("offers delete, never hide, for a manually added location", () => {
    // Nothing regenerates a manual location, so "hide" would only lose it.
    expect(
      locationActions({
        fromSubscription: false,
        hidden: false,
        pinned: true,
      }),
    ).toEqual(["ping", "rename", "unpin", "delete"]);
  });

  it("flips hide and pin against the current state", () => {
    expect(
      locationActions({
        fromSubscription: true,
        hidden: true,
        pinned: true,
      }),
    ).toEqual(["ping", "rename", "unpin", "unhide"]);
  });

  it("offers hide without any duration setting to choose", () => {
    // Hiding used to come in modes; the row either stays hidden or it does not.
    expect(locationActions({ fromSubscription: true, hidden: false, pinned: false })).toContain(
      "hide",
    );
  });
});

describe("hidden locations", () => {
  it("keeps a hidden location out of the list and counts it", () => {
    const servers = [row("a"), row("b"), row("c")];
    const hiddenKeys = [servers[1].key];
    const out = order(servers, { hiddenKeys });
    expect(out.visible.map((s) => s.id)).toEqual(["a", "c"]);
    expect(out.hidden.map((s) => s.id)).toEqual(["b"]);
    expect(hiddenCount(servers, keyOf, hiddenKeys)).toBe(1);
  });

  it("keeps the location hidden until the card reveals it", () => {
    const servers = [row("a"), row("b")];
    const hiddenKeys = [servers[1].key];
    expect(isHiddenLocation(servers[1].key, hiddenKeys, false)).toBe(true);
    expect(order(servers, { hiddenKeys }).visible).toHaveLength(1);
    expect(hiddenCount(servers, keyOf, hiddenKeys)).toBe(1);
    // revealing shows them dimmed without un-hiding anything
    expect(isHiddenLocation(servers[1].key, hiddenKeys, true)).toBe(false);
    expect(order(servers, { hiddenKeys, revealHidden: true }).visible).toHaveLength(2);
    expect(hiddenCount(servers, keyOf, hiddenKeys)).toBe(1);
  });

  it("reveals hidden locations on request without un-hiding them", () => {
    const servers = [row("a"), row("b")];
    const hiddenKeys = [servers[1].key];
    const out = order(servers, { hiddenKeys, revealHidden: true });
    expect(out.visible.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out.hidden).toHaveLength(0);
    // Still counted, so the card keeps offering the way to hide them again.
    expect(hiddenCount(servers, keyOf, hiddenKeys)).toBe(1);
  });
});

describe("pinned locations", () => {
  it("moves pinned locations to the top, oldest first by default", () => {
    const servers = [row("a"), row("b"), row("c"), row("d")];
    const pinnedAt: Record<string, number> = {
      [servers[1].key]: 20,
      [servers[3].key]: 10,
    };
    expect(order(servers, { pinnedAt }).visible.map((s) => s.id)).toEqual([
      "d",
      "b",
      "a",
      "c",
    ]);
  });

  it("reverses the pinned block when asked for newest first", () => {
    const servers = [row("a"), row("b"), row("c"), row("d")];
    const pinnedAt: Record<string, number> = {
      [servers[1].key]: 20,
      [servers[3].key]: 10,
    };
    expect(
      order(servers, { pinnedAt, pinOrder: "newestFirst" })
        .visible.map((s) => s.id),
    ).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps a pinned location hidden while it is hidden", () => {
    const servers = [row("a"), row("b")];
    const out = order(servers, {
      pinnedAt: { [servers[1].key]: 5 },
      hiddenKeys: [servers[1].key],
    });
    expect(out.visible.map((s) => s.id)).toEqual(["a"]);
    expect(out.hidden.map((s) => s.id)).toEqual(["b"]);
  });
});
