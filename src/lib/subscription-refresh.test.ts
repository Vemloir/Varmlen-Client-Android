import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  nextFutureRefresh,
  nextRefreshBatch,
} from "./subscription-refresh";

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

  it("groups only the earliest future subscription boundary", () => {
    const now = Date.parse("2026-07-28T10:20:00Z");
    expect(
      nextRefreshBatch(
        [
          {
            id: "hourly-a",
            lastSuccessIso: "2026-07-28T10:00:00Z",
            intervalHours: 1,
          },
          {
            id: "later",
            lastSuccessIso: "2026-07-28T10:00:00Z",
            intervalHours: 2,
          },
          {
            id: "hourly-b",
            lastSuccessIso: "2026-07-28T09:00:00Z",
            intervalHours: 1,
          },
        ],
        now,
      ),
    ).toEqual({
      at: Date.parse("2026-07-28T11:00:00Z"),
      ids: ["hourly-a", "hourly-b"],
    });
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

  it("uses one cancellable future timer and never refreshes on mount", () => {
    const store = read("./subs.svelte.ts");
    const layout = read("../routes/+layout.svelte");

    expect(store).toContain("nextRefreshBatch");
    expect(store).toContain("setTimeout");
    expect(store).toContain("stopAutoRefresh");
    expect(store).not.toContain("setInterval(check");
    expect(store).not.toContain(".finally(check)");
    expect(layout).toContain("settings.subscriptionAutoUpdate");
    expect(layout).toContain("subs.stopAutoRefresh()");
  });

  it("delegates closed-app Android refreshes without touching the VPN service", () => {
    const api = read("./api.ts");
    const store = read("./subs.svelte.ts");
    const connection = read("./conn.svelte.ts");
    const layout = read("../routes/+layout.svelte");
    const worker = read(
      "../../src-tauri/gen/android/app/src/main/java/app/varmlen/client/SubscriptionRefreshWorker.kt",
    );

    expect(api).toContain("syncSubscriptionRefresh");
    expect(api).toContain("drainSubscriptionRefreshes");
    expect(store).toContain("applyStagedRefreshes");
    expect(store).toContain("providerRefreshRevision");
    expect(connection).toContain("lastProviderRefreshRevision");
    expect(layout).toContain("drainNativeSubscriptionRefreshes");
    expect(layout).toContain("syncSubscriptionRefresh(schedules)");
    expect(worker).toContain("CoroutineWorker");
    expect(worker).toContain('setRequestProperty("X-Device-OS", "android")');
    expect(worker).not.toContain("VarmlenVpnService");
    expect(worker).not.toContain("startActivity");
  });
});
