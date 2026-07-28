import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextFutureRefresh } from "./subscription-refresh";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("subscription refresh scheduling", () => {
  it("returns the first interval boundary after now", () => {
    expect(
      nextFutureRefresh(
        "2026-07-28T10:00:00Z",
        1,
        Date.parse("2026-07-28T10:20:00Z"),
      ),
    ).toBe(Date.parse("2026-07-28T11:00:00Z"));
  });

  it("skips boundaries missed while the client was closed", () => {
    expect(
      nextFutureRefresh(
        "2026-07-28T10:00:00Z",
        1,
        Date.parse("2026-07-28T12:20:00Z"),
      ),
    ).toBe(Date.parse("2026-07-28T13:00:00Z"));
  });

  it("rejects unusable schedules", () => {
    expect(() => nextFutureRefresh("not-a-date", 1, Date.now())).toThrow(
      "invalid subscription refresh schedule",
    );
    expect(() =>
      nextFutureRefresh("2026-07-28T10:00:00Z", 0, Date.now()),
    ).toThrow("invalid subscription refresh schedule");
  });
});

describe("subscription refresh setting contract", () => {
  it("is persisted, enabled by default, and exposed in Settings", () => {
    const store = read("./settings.svelte.ts");
    const page = read("../routes/settings/+page.svelte");

    expect(store).toContain("subscriptionAutoUpdate: boolean");
    expect(store).toMatch(/subscriptionAutoUpdate:\s*true/);
    expect(store).toContain("setSubscriptionAutoUpdate");
    expect(page).toContain('t("settings.subscriptionAutoUpdate")');
    expect(page).toContain("settings.setSubscriptionAutoUpdate");
  });
});
