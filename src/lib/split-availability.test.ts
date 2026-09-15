import { describe, expect, it } from "vitest";
import { appSplitAvailable } from "./split-availability";
import { SPLIT_APPS, zoneOrder } from "./nav-zones";

describe("per-app split availability on Android", () => {
  it("is always available, because the tunnel is a VpnService", () => {
    // There is no VPN mode on Android to rule the applications half out: the
    // per-application split is handed to the service when the tunnel starts.
    expect(appSplitAvailable()).toBe(true);
  });

  it("puts the applications zone in the strip, so the strip is four places long", () => {
    const order = zoneOrder(appSplitAvailable());
    expect(order).toContain(SPLIT_APPS);
    expect(order).toEqual(["/", "/split/apps", "/split/sites", "/settings"]);
  });
});