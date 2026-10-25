import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("card surface contract", () => {
  it("uses borderless card surfaces with row separators", () => {
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
    // The theme is a row of the settings list, as on Linux, not a card of tiles.
    expect(settings).not.toContain("theme-tile");
    expect(settings).toMatch(
      /\.row \+ \.row\s*\{[^}]*border-top:\s*1px solid var\(--bg\);/s,
    );
    expect(settings).toMatch(/\.ver-list\s*\{[^}]*border:\s*none;/s);
    expect(settings).toMatch(
      /\.ver-list li \+ li\s*\{\s*border-top:\s*1px solid var\(--bg\);/s,
    );
    expect(split).toMatch(/\.empty-state\s*\{[^}]*border:\s*none;/s);
    expect(split).toMatch(/\.picker\s*\{[^}]*border:\s*none;/s);
    // The separator is one step off the plate it is drawn on. The picker plate took
    // the application background in the Linux pass (a plate inside a card reads as
    // cut out of it, not as a box glued on top), so the line has to be the lighter
    // colour now -- a separator the same colour as its surface is not a separator.
    expect(split).toMatch(
      /\.picker-row \+ \.picker-row\s*\{[^}]*border-top:\s*1px solid var\(--bg-elev\);/s,
    );
  });

  it("keeps settings controls readable on a hovered row", () => {
    const settings = read("../routes/settings/+page.svelte");
    const dropdown = read("./components/Dropdown.svelte");

    expect(settings).toMatch(/\.log-row\s*\{[^}]*border-radius:\s*0;/s);
    expect(dropdown).not.toMatch(
      /\.trigger\[aria-expanded="true"\]\s*\{[^}]*border-top-left-radius:\s*0;/s,
    );
    // Controls take the APPLICATION background (--bg) with no outline: the card
    // row is lighter and its hover is lighter still, so they read in both states.
    // This assertion used to demand --bg-elev-2, which pinned the mistake rather
    // than the design: the plate and the row's hover were the same grey, so the
    // control vanished into the state the hover was meant to reveal.
    expect(dropdown).toMatch(
      /\.trigger\s*\{[^}]*background:\s*var\(--bg\);[^}]*border:\s*none;/s,
    );
    expect(dropdown).toMatch(
      /\.trigger:hover\s*\{[^}]*background:\s*var\(--bg-elev-3\);/s,
    );
    expect(settings).toMatch(
      /\.versions-btn\s*\{[^}]*background:\s*var\(--bg\);[^}]*border:\s*none;/s,
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

  it("removes the user-facing local Proxy mode from Android", () => {
    const store = read("./settings.svelte.ts");
    const settings = read("../routes/settings/+page.svelte");
    const layout = read("../routes/+layout.svelte");
    const conn = read("./conn.svelte.ts");
    const api = read("./api.ts");
    const i18n = read("./i18n.svelte.ts");
    const vpn = read("../../src-tauri/src/vpn.rs");
    const xray = read("../../src-tauri/src/xray.rs");

    for (const source of [store, settings, layout, conn, api, i18n]) {
      expect(source).not.toContain("vpnMode");
    }
    expect(api).not.toContain('"tun" | "proxy"');
    expect(vpn).not.toContain('mode == "proxy"');
    expect(vpn).not.toContain("mobile_config_mode");
    expect(xray).not.toContain('mode == "proxy"');
    expect(xray).not.toContain("XRAY_SOCKS_PORT");
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

  it("uses separated location rows, background-only selection, and source-specific editors", () => {
    const list = read("./components/ServerList.svelte");
    const flag = read("./components/FlagIcon.svelte");
    const editor = read("./components/LocationEditor.svelte");
    const home = read("../routes/+page.svelte");

    expect(list).toMatch(/\.srv-row::before/);
    expect(list).toMatch(/\.srv-row::before\s*\{[^}]*left:\s*0;[^}]*right:\s*0;/s);
    expect(list).toMatch(/\.srv-row::before\s*\{[^}]*border-top:\s*1px solid var\(--bg\);/s);
    expect(list).not.toMatch(/\.srv-row::before\s*\{[^}]*opacity:/s);
    expect(list).not.toContain(".srv-row + .srv-row::before");
    expect(list).toMatch(
      /:global\(html:not\(\.is-android\)\) \.srv-row:not\(\.active\):hover\s*\{[^}]*background:\s*var\(--bg-elev-2\);/s,
    );
    expect(list).not.toMatch(/^\s*\.srv-row:hover\s*\{/m);
    expect(list).not.toContain("srv-stripe");
    expect(flag.match(/class="globe-arc"/g)).toHaveLength(4);
    expect(flag).toContain('class="globe-outline"');
    expect(editor).toContain('{#if draft.kind === "json"}');
    expect(editor).toContain("{:else}");
    expect(editor).toContain("rawParams");
    expect(editor).toContain('import Dropdown from "./Dropdown.svelte";');
    expect(editor).not.toContain("<select");
    expect(home).toContain('import LocationEditor from "$lib/components/LocationEditor.svelte";');
    expect(home).toContain("onBackButtonPress(closeModal)");
    expect(home).toContain('class="modal card location-modal"');
    expect(home).toContain('class="location-editor-scroll"');
    expect(home).toContain('type ModalKind =');
    expect(home).toContain('let activeModal = $state<ModalKind>("none")');
    expect(home).toContain("function closeModal()");
    expect(home).not.toContain("onclick={() => (jsonFor = null)}");
    expect(home).not.toContain("onclick={() => (detailFor = null)}");
    expect(home).not.toContain("onclick={() => (showImport = false)}");
    expect(home).not.toContain("detailRows");
    expect(home).not.toContain("formatLocationJson");
  });

  it("keeps Android modals inside both system insets and exposes a field dropdown variant", () => {
    const css = read("../app.css");
    const dropdown = read("./components/Dropdown.svelte");
    const editor = read("./components/LocationEditor.svelte");
    const home = read("../routes/+page.svelte");

    expect(css).toMatch(
      /\.is-android \.modal-backdrop\s*\{[^}]*padding-top:\s*calc\(var\(--sat\) \+ 12px\);/s,
    );
    expect(css).toMatch(
      /\.is-android \.modal-backdrop > \.modal\s*\{[^}]*max-height:\s*100%\s*!important;/s,
    );
    // The pages centre their dialogs for the desktop; on Android the sheet must come
    // back to the bottom edge, or a dialog floats in the middle of the screen with
    // nothing holding it there.
    expect(css).toMatch(
      /\.is-android \.modal-backdrop\s*\{[^}]*align-items:\s*flex-end;/s,
    );
    expect(dropdown).toContain("field?: boolean");
    expect(dropdown).toContain("class:field");
    expect(dropdown).toMatch(
      /\.dd\.field\s*\{[^}]*width:\s*100%;/s,
    );
    expect(dropdown).toMatch(
      /\.field \.trigger\s*\{[^}]*padding-right:\s*14px;/s,
    );
    expect(home).toMatch(
      /\.location-actions\s*\{[^}]*margin-top:\s*16px;/s,
    );
  });

  it("gives Android even side margins and the full clearance under the tab pill", () => {
    const css = read("../app.css");
    const android = css.slice(css.indexOf(".is-android .page,"));
    // The bottom keeps the pages' own clearance under the pill, plus the keyboard.
    expect(android).toMatch(
      /\.is-android \.scroll\s*\{[^}]*padding-bottom:\s*calc\(24px \+ var\(--nav-clearance\) \+ var\(--ime-height, 0px\)\) !important;/s,
    );
    expect(android).toMatch(/\.is-android \.scroll\s*\{[^}]*padding-left:\s*14px !important;/s);
    expect(android).toMatch(/\.is-android \.page \.pane\s*\{[^}]*padding-left:\s*14px !important;/s);
    expect(android).toMatch(/\.is-android \.page > \.segmented,/);
  });

  it("keeps the Android log viewer inside the safe viewport", () => {
    const css = read("../app.css");
    const settings = read("../routes/settings/+page.svelte");

    // The type selector deliberately outranks Svelte's scoped
    // `.modal-backdrop.svelte-* { padding: 16px }` rule.
    expect(css).toMatch(
      /html\.is-android \.modal-backdrop\s*\{[^}]*padding-top:\s*calc\(var\(--sat\) \+ 12px\);/s,
    );
    expect(css).toMatch(
      /html\.is-android \.modal-backdrop > \.modal\s*\{[^}]*max-height:\s*calc\(\s*100dvh - var\(--sat\) - max\(env\(safe-area-inset-bottom\), var\(--ime-height, 0px\)\) - 24px\s*\)\s*!important;/s,
    );
    expect(settings).toMatch(
      /\.log-modal\s*\{[^}]*overflow:\s*hidden;/s,
    );
    expect(settings).toMatch(
      /\.log-text\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*max-width:\s*100%;[^}]*margin:\s*0;/s,
    );
  });
});
