import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("Android replaceable Xray core + in-app kill switch", () => {
  it("keeps the APK-bundled core in sync with the native build script", () => {
    const core = read("../../src-tauri/src/core.rs");
    const nativeBuild = read("../../scripts/android-native.sh");
    const version = core.match(/BUNDLED_XRAY_VERSION: &str = "([^"]+)"/)?.[1];

    expect(version).toBe("26.3.27");
    expect(nativeBuild).toContain(`XRAY_VER="${version}"`);
    expect(nativeBuild).toContain("57149ffd48b629c07bf76938e73ab2729fde5910091497eab3e93d1c190f4c1b");
    expect(nativeBuild).toContain("libxray.so.version");
  });

  it("lets Android manage core versions like the other Varmlen clients", () => {
    const core = read("../../src-tauri/src/core.rs");

    // Downloads the official android/arm64 asset, exactly like the APK pin.
    expect(core).toContain('name == "Xray-android-arm64-v8a.zip"');
    // The bundled core is virtual (jniLibs, in place) and can never be deleted.
    expect(core).toContain("bundled_core(app)");
    expect(core).toContain(
      "the bundled Xray ships with the Varmlen APK and can't be removed",
    );
    // A downloaded version runs whenever it is the active selection; a stale
    // selection self-heals back to the bundled core.
    expect(core).toContain("pub async fn active_core_bin");
    // Desktop-only setcap must not fire on Android.
    expect(core).toMatch(
      /#\[cfg\(not\(target_os = "android"\)\)\]\s+if became_active && kind == CoreKind::Xray/,
    );
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

  it("lets Android open the core versions modal (like desktop)", () => {
    const page = read("../routes/settings/+page.svelte");
    expect(page).not.toContain("{#if showVersions && !isAndroid}");
    expect(page).not.toContain("core.androidManaged");
    // Bundled row stays identifiable inside the shared modal.
    expect(page).toContain('t("core.bundled")');
    expect(page).toContain("{#if !v.bundled}{@render delBtn(v.tag, isSwitching)}{/if}");
  });
});
