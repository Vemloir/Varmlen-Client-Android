import { describe, expect, it } from "vitest";
import {
  normalizeSubscriptionUserAgent,
  SUBSCRIPTION_USER_AGENTS,
  subscriptionUserAgentOptions,
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

  it("shows every identity the store can hold", () => {
    // A choice the picker does not list is a choice the user cannot see or change:
    // the dropdown would open on a value with no entry, and a stored `v2raytun` --
    // which Android shipped, and which some providers gate on -- would be invisible
    // rather than editable. The options are derived from the choices for this reason.
    expect(subscriptionUserAgentOptions().map((o) => o.value)).toEqual([
      ...SUBSCRIPTION_USER_AGENTS,
    ]);
    expect(subscriptionUserAgentOptions().map((o) => o.label)).toEqual([
      "Varmlen",
      "Happ",
      "INCY",
      "v2rayTun",
    ]);
  });
});
