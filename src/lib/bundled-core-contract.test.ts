import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("Android bundled Xray core + in-app kill switch", () => {
  it("keeps the APK-bundled core in sync with the native build script", () => {
    const core = read("../../src-tauri/src/core.rs");
    const nativeBuild = read("../../scripts/android-native.sh");
    const version = core.match(/BUNDLED_XRAY_VERSION: &str = "([^"]+)"/)?.[1];

    expect(version).toBe("26.3.27");
    expect(nativeBuild).toContain(`XRAY_VER="${version}"`);
    expect(nativeBuild).toContain("57149ffd48b629c07bf76938e73ab2729fde5910091497eab3e93d1c190f4c1b");
    expect(nativeBuild).toContain("libxray.so.version");
  });

  it("keeps the Android core bundled-only (OS W^X blocks exec of downloaded binaries)", () => {
    const page = read("../routes/settings/+page.svelte");
    const i18n = read("i18n.svelte.ts");
    const service = read(
      "../../src-tauri/gen/android/app/src/main/java/app/varmlen/client/VarmlenVpnService.kt",
    );

    // Android 10+ (targetSdk 29+) refuses exec() on files in the app's private
    // storage, so downloaded cores cannot run. The UI says so and hides the
    // version manager on Android only.
    expect(page).toContain("{#if showVersions && !isAndroid}");
    expect(page).toContain("{t(\"core.androidManaged\")}");
    expect(i18n).toContain('"core.androidManaged"');
    // A stale selection (e.g. from a build that allowed downloads) must never
    // break a connect: validation failure heals to the bundled core.
    expect(service).toContain("falling back to the bundled core");
  });

  it("keeps the Android TUN IPv4-only so IPv4-only proxy servers serve v6-preferring apps", () => {
    const service = read(
      "../../src-tauri/gen/android/app/src/main/java/app/varmlen/client/VarmlenVpnService.kt",
    );

    // No IPv6 address / no ::/0 route on the TUN: an app's IPv6 attempt is
    // dropped locally in milliseconds and Happy-Eyeballs falls back to IPv4,
    // instead of dying at an IPv4-only remote server ("network is unreachable").
    expect(service).not.toContain(".addAddress(TUN_ADDR_V6");
    expect(service).not.toContain('.addRoute("::", 0)');
    expect(service).toContain('.addAddress(TUN_ADDR, 30)');
    expect(service).toContain('.addRoute("0.0.0.0", 0)');
  });

  it("exposes the kill switch as a real in-app toggle on Android", () => {
    const page = read("../routes/settings/+page.svelte");
    const i18n = read("i18n.svelte.ts");
    const mobile = read("../../src-tauri/src/mobile_vpn.rs");
    const service = read(
      "../../src-tauri/gen/android/app/src/main/java/app/varmlen/client/VarmlenVpnService.kt",
    );

    // One shared killswitch row for all platforms (no isAndroid gating on it),
    // bound to the persisted settings store.
    expect(page).toContain("checked={settings.killswitch}");
    expect(page).toContain("settings.setKillswitch");
    expect(page).not.toContain("settings.androidKillswitch");
    // The system-level lockdown is now an explicitly optional extra.
    expect(page).toContain("settings.androidSystemLockdown");
    expect(i18n).toContain('"settings.androidSystemLockdown"');
    // The kill switch reaches the VpnService (core death → hold + retry).
    expect(mobile).toContain("killswitch: bool");
    expect(service).toContain("onCoreCrashed");
    expect(service).toContain("restartCore");
    expect(service).toContain("CORE_RETRY_BACKOFF_MS");
    expect(service).toContain("EXTRA_KILLSWITCH");
  });
});
