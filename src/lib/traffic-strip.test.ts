import { describe, expect, it } from "vitest";

import { hasTraffic, trafficPercent } from "./traffic";

/**
 * The strip that reports what a subscription has spent. Providers are the unreliable
 * part of that sentence -- no quota, no usage, or more spent than the quota allows --
 * and every one of those has to end up as a strip that is drawn and a figure that is
 * honest.
 */
describe("traffic strip", () => {
  it("fills in proportion to what was spent", () => {
    expect(trafficPercent(0, 1000)).toBe(0);
    expect(trafficPercent(250, 1000)).toBe(25);
    expect(trafficPercent(1000, 1000)).toBe(100);
  });

  it("caps at full when the provider reports more than the quota", () => {
    expect(trafficPercent(4000, 1000)).toBe(100);
  });

  it("draws nothing for an unknown quota, which is not the same as infinite", () => {
    expect(trafficPercent(500, 0)).toBe(0);
    expect(hasTraffic(500, 0)).toBe(true);
  });

  it("knows a subscription that reported nothing at all", () => {
    expect(hasTraffic(0, 0)).toBe(false);
    expect(trafficPercent(0, 0)).toBe(0);
  });

  it("is not fooled by a negative figure, which no provider should send but some do", () => {
    expect(trafficPercent(-5, 1000)).toBe(0);
    expect(trafficPercent(500, -1)).toBe(0);
  });
});
