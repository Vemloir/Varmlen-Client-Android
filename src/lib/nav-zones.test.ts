import { describe, expect, it } from "vitest";

import {
  SPLIT_APPS,
  SPLIT_SITES,
  entryZone,
  routeOf,
  tabOf,
  zoneOf,
  zoneOrder,
} from "./nav-zones";

/**
 * The places a swipe travels between, which are not the routes. The tab bar has three
 * segments and the router knows three paths; the strip has four places, because the
 * split page is two places wide. Everything that drags, previews or remembers a scroll
 * position reads the strip through these four functions, so they are the contract.
 */
describe("the swipe strip", () => {
  it("is four places long when applications can be routed", () => {
    expect(zoneOrder(true)).toEqual(["/", "/split/apps", "/split/sites", "/settings"]);
  });

  it("leaves the applications place out when they cannot", () => {
    // A wall is more honest than a tab that goes nowhere.
    expect(zoneOrder(false)).toEqual(["/", "/split/sites", "/settings"]);
  });

  it("counts the split page as two places and every other route as one", () => {
    expect(zoneOf("/split", "apps")).toBe("/split/apps");
    expect(zoneOf("/split", "websites")).toBe("/split/sites");
    expect(zoneOf("/", "apps")).toBe("/");
    expect(zoneOf("/settings", "apps")).toBe("/settings");
  });

  it("knows the route a place lives on", () => {
    expect(routeOf("/split/apps")).toBe("/split");
    expect(routeOf("/split/sites")).toBe("/split");
    expect(routeOf("/settings")).toBe("/settings");
    expect(routeOf("/")).toBe("/");
  });

  it("knows which half of the split page a place asks for", () => {
    expect(tabOf("/split/apps")).toBe("apps");
    expect(tabOf("/split/sites")).toBe("websites");
    expect(tabOf("/settings")).toBe(null);
    expect(tabOf("/")).toBe(null);
  });

  it("opens the split page on the half that was left selected", () => {
    expect(entryZone("websites", true)).toBe(SPLIT_SITES);
    expect(entryZone("apps", true)).toBe(SPLIT_APPS);
    // Without application routing there is no applications place to land on.
    expect(entryZone("apps", false)).toBe(SPLIT_SITES);
    // The place it returns is always in the strip it is asked about.
    expect(zoneOrder(false)).toContain(entryZone("apps", false));
    expect(zoneOrder(true)).toContain(entryZone("apps", true));
  });

  it("walks one place either way from anywhere in the strip", () => {
    const order = zoneOrder(true);
    const at = (zone: string) => order.indexOf(zone);
    expect(order[at("/") + 1]).toBe("/split/apps");
    expect(order[at("/split/apps") + 1]).toBe("/split/sites");
    expect(order[at("/split/sites") + 1]).toBe("/settings");
    expect(order[at("/settings") + 1]).toBeUndefined();
    expect(order[at("/") - 1]).toBeUndefined();
  });
});
