import { createHash } from "node:crypto";
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
    const manifest = read(
      "../../src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    );
    const store = read("./subs.svelte.ts");
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
    expect(nativeHttp).toContain("awaitValidatedSubscriptionNetwork(context)");
    expect(nativeHttp).toContain("NET_CAPABILITY_VALIDATED");
    expect(nativeHttp).toContain(".socketFactory(network.socketFactory)");
    expect(nativeHttp).toContain("network::getAllByName");
    expect(manifest).toContain("android.permission.ACCESS_NETWORK_STATE");
    expect(store).not.toContain("fetchSubscriptionWithRetry");
    expect(store).not.toContain("setTimeout(resolve, 800)");
    expect(nativeHttp).toContain(".followRedirects(false)");
    expect(nativeHttp).toContain("MAX_SUBSCRIPTION_BODY_BYTES");
    expect(nativeHttp).toContain("MAX_SUBSCRIPTION_REDIRECTS");
  });

  it("extends system trust with the official ISRG Root X2 certificate", () => {
    const manifest = read(
      "../../src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    );
    const networkSecurity = read(
      "../../src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml",
    );
    const root = readFileSync(
      fileURLToPath(
        new URL(
          "../../src-tauri/gen/android/app/src/main/res/raw/isrg_root_x2.der",
          import.meta.url,
        ),
      ),
    );

    expect(manifest).toContain(
      'android:networkSecurityConfig="@xml/network_security_config"',
    );
    expect(networkSecurity).toContain('<certificates src="system" />');
    expect(networkSecurity).toContain(
      '<certificates src="@raw/isrg_root_x2" />',
    );
    expect(networkSecurity).not.toContain('src="user"');
    expect(createHash("sha256").update(root).digest("hex")).toBe(
      "69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470",
    );
  });
});
