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

    expect(version).toBe("26.3.27");
    expect(nativeBuild).toContain(`XRAY_VER="${version}"`);
    expect(nativeBuild).toContain("57149ffd48b629c07bf76938e73ab2729fde5910091497eab3e93d1c190f4c1b");
    expect(nativeBuild).toContain("libxray.so.version");
    expect(core).toContain("bundled: true");
    expect(core).toContain("Android Xray updates are delivered through Varmlen APK updates");
    expect(settings).toContain('t("core.bundled")');
    expect(settings).toContain("{#if !v.bundled}");
  });
});
