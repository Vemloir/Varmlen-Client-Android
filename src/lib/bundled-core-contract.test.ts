import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("Android bundled Xray core", () => {
  it("reports the APK core as active and immutable", () => {
    const core = read("../../src-tauri/src/core.rs");
    const nativeBuild = read("../../scripts/android-native.sh");
    const settings = read("../routes/settings/+page.svelte");
    const version = core.match(/BUNDLED_XRAY_VERSION: &str = "([^"]+)"/)?.[1];

    expect(version).toBe("26.7.28");
    expect(nativeBuild).toContain(`XRAY_VER="${version}"`);
    expect(nativeBuild).toContain("a442892c175fa648fc56866ec872aac441c5a6b8946a1b60f0258ae16a7fb402");
    expect(nativeBuild).toContain("libxray.so.version");
    expect(core).toContain("bundled: true");
    expect(core).toContain("Android Xray updates are delivered through Varmlen APK updates");
    expect(settings).toContain('t("core.bundled")');
    expect(settings).toContain('t("core.androidManaged")');
    expect(settings).toContain("{#if !isAndroid}");
    expect(settings).toContain("{#if !v.bundled}");
  });
});
