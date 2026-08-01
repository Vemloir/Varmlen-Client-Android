import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("Android subscription fetch contract", () => {
  it("uses the shared Android-native HTTP stack for imports and background refreshes", () => {
    const rustCommand = read("../../src-tauri/src/lib.rs");
    const rustBridge = read("../../src-tauri/src/mobile_vpn.rs");
    const plugin = read(
      "../../src-tauri/gen/android/app/src/main/java/app/varmlen/client/VpnPlugin.kt",
    );
    const worker = read(
      "../../src-tauri/gen/android/app/src/main/java/app/varmlen/client/SubscriptionRefreshWorker.kt",
    );
    const nativeHttpUrl = new URL(
      "../../src-tauri/gen/android/app/src/main/java/app/varmlen/client/SubscriptionHttp.kt",
      import.meta.url,
    );

    expect(existsSync(fileURLToPath(nativeHttpUrl))).toBe(true);
    const nativeHttp = readFileSync(fileURLToPath(nativeHttpUrl), "utf8");
    expect(rustCommand).toMatch(
      /#\[cfg\(target_os = "android"\)\][\s\S]*mobile_vpn::fetch_subscription\(/,
    );
    expect(rustBridge).toContain('"fetchSubscription"');
    expect(plugin).toContain("fun fetchSubscription(invoke: Invoke)");
    expect(plugin).toContain("fetchSubscriptionHttp(");
    expect(worker).toContain("fetchSubscriptionHttp(");
    expect(nativeHttp).toContain("OkHttpClient.Builder()");
    expect(nativeHttp).toContain("PinnedSubscriptionDns");
    expect(nativeHttp).toContain("approvedSubscriptionAddresses(url)");
    expect(nativeHttp).toContain(".followRedirects(false)");
    expect(nativeHttp).toContain("MAX_SUBSCRIPTION_BODY_BYTES");
    expect(nativeHttp).toContain("MAX_SUBSCRIPTION_REDIRECTS");
  });
});
