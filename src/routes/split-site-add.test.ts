import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/**
 * Adding a website is a window with one field. Everything that was built around the
 * field -- suggested zones, suggested services, a set of ticks, a counter, a
 * paragraph explaining the notation -- asked the user to read the interface before
 * using it, and each of them was removed on those grounds. What has to survive is
 * the path from the keyboard to the store: a pattern that reaches xray in another
 * shape sits in the list looking like a rule while doing nothing.
 */
describe("split websites: one field, one action", () => {
  const split = read("./split/+page.svelte");
  const i18n = read("../lib/i18n.svelte.ts");
  const modal = split.slice(split.indexOf("{#if showAddSite}"), split.indexOf("<style>"));

  it("offers adding on both tabs through the same full-width plate", () => {
    expect(split).toMatch(
      /<button class="btn panel-add" onclick=\{openAddApp\}>\{t\("split\.addApp"\)\}<\/button>/,
    );
    expect(split).toMatch(
      /<button class="btn panel-add" onclick=\{openAddSite\}>\{t\("split\.addSites"\)\}<\/button>/,
    );
    expect(split).toMatch(/\.panel-add\s*\{[^}]*width:\s*100%;[^}]*border:\s*none;/s);
  });

  it("is a field and a button, and nothing else", () => {
    expect((modal.match(/<input/g) ?? []).length).toBe(1);
    expect(modal).toMatch(/<form class="site-add" onsubmit=\{\(e\) => \{ e\.preventDefault\(\); addSiteFromDraft\(\); \}\}/);
    expect(modal).toMatch(/type="submit" disabled=\{!siteDraft\.trim\(\)\}/);
    // The suggestions, the tick-set and the explainer are gone for good; the app
    // picker owns the only `.picker` list left on this page.
    expect(modal).not.toMatch(/class="picker/);
    expect(modal).not.toMatch(/type="checkbox"/);
    expect(modal).not.toMatch(/modal-actions/);
    // The tab itself has no second input competing with the window.
    const tab = split.slice(split.indexOf("{:else}"), split.indexOf("{#if showAddSite}"));
    expect(tab).not.toMatch(/<form/);
  });

  it("normalises, validates and refuses a duplicate before the store sees it", () => {
    const add = split.slice(
      split.indexOf("function addSiteFromDraft"),
      split.indexOf("let showAddApp"),
    );
    expect(add).toMatch(/normalizeSitePattern\(siteDraft\)/);
    expect(add).toMatch(/if \(!isSitePattern\(pattern\)\)/);
    expect(add).toMatch(/t\("split\.siteDuplicate"\)/);
    expect(add).toMatch(/split\.addSite\(pattern\);/);
    // Success closes the window -- the row appearing behind it is the confirmation.
    expect(add).toMatch(/showAddSite = false;/);
    // Nothing stores the raw field value.
    expect(split).not.toMatch(/split\.addSite\(siteDraft\)/);
  });

  it("keeps the meaning of a pattern available without a caption under it", () => {
    // "AND SUBDOMAINS" under every row is a caption the user does not have to read
    // to use the list, so it is not printed; it is what the row is about.
    expect(split).not.toMatch(/class="site-kind/);
    expect(split).toMatch(
      /<div class="list-row" title=\{t\(siteKindLabelKey\(siteRuleKind\(s\.pattern\)\)\)\}>/,
    );
  });

  it("centres the window and cuts field, button and plate out of the card", () => {
    const css = split.slice(split.indexOf("<style>"));
    expect(css).toMatch(/\.modal-backdrop\s*\{[^}]*align-items:\s*center;/s);
    expect(css).toMatch(/\.site-add input\s*\{[^}]*background:\s*var\(--bg\);[^}]*border:\s*none;/s);
    expect(css).toMatch(/\.site-add \.btn\s*\{[^}]*background:\s*var\(--bg\);[^}]*border:\s*none;/s);
    // The plate on the tab must stay above the page colour -- painted with the page
    // colour it is invisible. Inside the card, the field and the button use it.
    expect(css).toMatch(/\.panel-add\s*\{[^}]*background:\s*var\(--bg-elev\);[^}]*border:\s*none;/s);
    // The filled accent plate is gone from this flow.
    expect(modal).not.toMatch(/btn-primary/);
  });

  it("rewrites the old spelling of a pattern on load", () => {
    const store = read("../lib/split.svelte.ts");
    expect(store).toMatch(/migrateSitePatterns\(loaded\.sites\.general\)\.sites/);
    expect(store).toMatch(/migrateSitePatterns\(loaded\.sites\.selective\)\.sites/);
  });

  it("keeps the asterisk out of the wording the user reads", () => {
    for (const key of ['"split.sitePlaceholder"', '"split.noSitesHint"', '"split.siteInvalid"']) {
      const line = i18n.split("\n").find((l) => l.trim().startsWith(key));
      expect(line, key).toBeDefined();
      expect(line?.includes("*"), key).toBe(false);
    }
  });

  it("names every string the window uses in both languages", () => {
    for (const key of [
      '"split.addSites"',
      '"split.sitePlaceholder"',
      '"split.siteInvalid"',
      '"split.siteDuplicate"',
      '"split.siteKindSuffix"',
      '"split.siteKindZone"',
      '"split.siteKindExact"',
      // Still used, by the apps window, where multi-select did earn a counter.
      '"split.addSelected"',
    ]) {
      const hits = i18n.split(key).length - 1;
      expect(hits, key).toBe(2);
    }
  });

  it("leaves no string behind for a control that no longer exists", () => {
    for (const key of [
      '"split.presetRegion"',
      '"split.presetServices"',
      '"split.noSitePresets"',
      '"split.siteNotationHint"',
      '"split.siteExactOnly"',
    ]) {
      expect(i18n.includes(key), key).toBe(false);
    }
  });
});