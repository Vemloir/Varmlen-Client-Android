import { describe, expect, it } from "vitest";
import {
  normalizeSubscriptionUserAgent,
  SUBSCRIPTION_USER_AGENTS,
} from "./subscription-user-agent";

describe("subscription User-Agent setting", () => {
  it("offers only the four supported identities", () => {
    expect(SUBSCRIPTION_USER_AGENTS).toEqual([
      "varmlen",
      "happ",
      "incy",
      "v2raytun",
    ]);
  });

  it("falls back to Varmlen for missing or arbitrary persisted values", () => {
    expect(normalizeSubscriptionUserAgent(undefined)).toBe("varmlen");
    expect(normalizeSubscriptionUserAgent("attacker\r\nHeader: injected")).toBe(
      "varmlen",
    );
    expect(normalizeSubscriptionUserAgent("happ")).toBe("happ");
  });
});
