import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("card surface contract", () => {
  it("uses borderless cards and page-coloured row separators", () => {
    const css = read("../app.css");
    const home = read("../routes/+page.svelte");
    const settings = read("../routes/settings/+page.svelte");
    const split = read("../routes/split/+page.svelte");

    expect(css).toMatch(/\.card\s*\{[^}]*border:\s*none;/s);
    expect(css).toMatch(/\.list\s*\{[^}]*border:\s*none;/s);
    expect(css).toMatch(
      /\.list > \* \+ \*\s*\{[^}]*border-top:\s*1px solid var\(--bg\);/s,
    );
    expect(home).toMatch(/\.sub-card\s*\{[^}]*border:\s*none;/s);
    expect(settings).toMatch(/\.theme-tile\s*\{[^}]*border:\s*none;/s);
    expect(settings).toMatch(
      /\.row \+ \.row\s*\{[^}]*border-top:\s*1px solid var\(--bg\);/s,
    );
    expect(settings).toMatch(/\.ver-list\s*\{[^}]*border:\s*none;/s);
    expect(settings).toMatch(
      /\.ver-list li \+ li\s*\{\s*border-top:\s*1px solid var\(--bg\);/s,
    );
    expect(split).toMatch(/\.picker\s*\{[^}]*border:\s*none;/s);
    expect(split).toMatch(
      /\.picker-row \+ \.picker-row\s*\{[^}]*border-top:\s*1px solid var\(--bg\);/s,
    );
  });

  it("shows the Tauri application version in Settings", () => {
    const settings = read("../routes/settings/+page.svelte");

    expect(settings).toContain(
      'import { getVersion } from "@tauri-apps/api/app";',
    );
    expect(settings).toContain("appVersion = await getVersion()");
    expect(settings).toContain("Varmlen {appVersion}");
  });

  it("uses native flags and separate link and JSON import modes", () => {
    const css = read("../app.css");
    const home = read("../routes/+page.svelte");

    expect(css).toContain('@import "flag-icons/css/flag-icons.min.css";');
    expect(home).toContain('import FlagIcon from "$lib/components/FlagIcon.svelte";');
    expect(home).toContain('$state<"choose" | "link" | "json">');
    expect(home).toContain('class="import-link"');
    expect(home).toContain('class="import-json"');
    expect(home).toContain('t("menu.json")');
    expect(home).toContain('class="json-editor"');
  });
});
