import { NAV } from "$lib/nav";

/**
 * The places a swipe can travel between.
 *
 * They are not the same list as the routes. The tab bar has three segments and the
 * router knows three paths, but the split page is two places wide -- applications on
 * one side, websites on the other -- and a reader who drags between them is moving
 * between places whether or not the address changes. Keeping that difference in one
 * pure module means the gesture, the neighbour under the finger and the scroll memory
 * all agree about where the strip goes.
 */

/** Which half of the split page the reader is looking at. */
export type SplitTab = "apps" | "websites";

export const SPLIT_APPS = "/split/apps";
export const SPLIT_SITES = "/split/sites";

/** The place the reader is standing in: the route, except that the split page counts
 *  as two. */
export function zoneOf(path: string, splitTab: SplitTab): string {
  if (path !== "/split") return path;
  return splitTab === "apps" ? SPLIT_APPS : SPLIT_SITES;
}

/** The strip, in order. When applications cannot be routed -- the VPN mode decides --
 *  the applications zone is not in the strip at all: a wall is more honest than a tab
 *  that goes nowhere. */
export function zoneOrder(appsAvailable: boolean): string[] {
  return NAV.map((item) => item.path).flatMap((route) =>
    route === "/split"
      ? appsAvailable
        ? [SPLIT_APPS, SPLIT_SITES]
        : [SPLIT_SITES]
      : [route],
  );
}

/** The place a gesture arriving at the split page from somewhere else should land on:
 *  the half the reader left selected, because a page opens where it was left and not
 *  where the direction of the swipe happens to point. Applications win only if they can
 *  actually be routed, otherwise the strip has no such place to stand. */
export function entryZone(splitTab: SplitTab, appsAvailable: boolean): string {
  return splitTab === "apps" && appsAvailable ? SPLIT_APPS : SPLIT_SITES;
}

/** The route a zone lives on. */
export function routeOf(zone: string): string {
  return zone.startsWith("/split") ? "/split" : zone;
}

/** The half of the split page a zone asks for, or null for any other zone. */
export function tabOf(zone: string): SplitTab | null {
  if (zone === SPLIT_APPS) return "apps";
  if (zone === SPLIT_SITES) return "websites";
  return null;
}