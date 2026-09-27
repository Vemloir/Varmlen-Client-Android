import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/**
 * The shell around every page: how you get between tabs, and what the interface
 * lets you take out of it. These are layout-wide rules, so they are checked
 * against the layout rather than against a screenshot someone has to remember.
 */
describe("shell: tabs by swipe, with the new page arriving from the side", () => {
  const layout = read("./+layout.svelte");
  const shell = layout.slice(layout.indexOf("<div class=\"app\">"), layout.indexOf("<style>"));
  const css = layout.slice(layout.indexOf("<style>"));

  it("hands the content area to the swipe action", () => {
    expect(shell).toMatch(/<main\s+bind:this=\{contentEl\}\s+class="content"\s+use:swipeNav=\{\{/s);
    // Not `page.url.pathname`: the origin Tauri serves from has no path at all.
    // The strip is longer than the tab bar: the split page counts as two places.
    expect(shell).toMatch(/path: \(\) => zoneOf\(navPath\(\), split\.tab\),/);
    expect(shell).toMatch(/order: \(\) => zoneOrder\(appsAvailable\),/);
    expect(shell).toMatch(/go: goToZone,/);
  });

  it("keeps a sideways drag from the touch screen's own pan", () => {
    // Without it Chromium on a touch screen takes the drag and cancels the pointer.
    expect(css).toMatch(/\.content\s*\{[^}]*touch-action:\s*pan-y;/s);
  });

  it("rides with the pointer and slows down into the end of the list", () => {
    const action = read("../lib/swipe-nav.ts");
    expect(action).toMatch(/element\.style\.transform = /);
    // Past the first and the last tab the page still moves, but each pixel of
    // finger buys less of it, and it never reaches the limit.
    expect(action).toMatch(/pageTravel\(dx, span, WALL_LIMIT_PX\)/);
    // And the layout hands it the element to move.
    expect(layout).toMatch(/track: \(\) => trackEl/);
    expect(layout).toMatch(/bind:this=\{trackEl\}/);
  });

  it("does not take a gesture that starts on a control or an open window", () => {
    const action = read("../lib/swipe-nav.ts");
    // Fields keep their gestures, and a swipe over an open modal must not carry
    // the half-typed draft away with it.
    expect(action).toMatch(/const REFUSED =/);
    expect(action).toMatch(/input, textarea, select, \[contenteditable\], \[data-no-swipe\], \.modal-backdrop, \.loc-menu/);
    // A row is a button, but only until the finger goes sideways: the home page is
    // nothing but rows, and refusing those gestures makes it unsweipeable.
    expect(action).toMatch(/const CONTROL = "button, a";/);
  });

  it("keeps every page mounted on the one element that moves", () => {
    // Mounting a page on a tab change froze the main thread for 50-450ms right after
    // the tap; every page now lives on the track from the start.
    expect(shell).toMatch(/<div bind:this=\{trackEl\} class="page-track" style=\{`--shown: \$\{shown\}`\}>/);
    expect(shell).toMatch(/\{#each TAB_PATHS as path, slot \(path\)\}/);
    expect(shell).toMatch(/<HomePage \/>/);
    expect(shell).toMatch(/<SplitPage \/>/);
    expect(shell).toMatch(/<SettingsPage active=\{slot === shown\} \/>/);
    expect(shell).not.toMatch(/@render children/);
    // The pages that are not on screen cannot be reached.
    expect(shell).toMatch(/inert=\{slot !== shown\}/);
    // Placed by `left`, never a transform: a transform is a stacking context, and the
    // page's modals would sit under the tab pill.
    expect(css).toMatch(/\.page-shell\s*\{[^}]*position:\s*absolute;[^}]*left:\s*calc\(\(var\(--slot\) - var\(--shown\)\) \* 100%\);/s);
    expect(css).not.toMatch(/\.page-shell\s*\{[^}]*transform/s);
  });

  it("slides a tab tap the way a swipe lands, and lands a swipe without a slide", () => {
    expect(layout).toMatch(/import \{ COMMIT, COMMIT_MS, swipeNav \} from "\$lib\/swipe-nav";/);
    expect(layout).toMatch(/el\.style\.transition = COMMIT;/);
    expect(layout).toMatch(/el\.style\.transform = `translateX\(\$\{\(from - target\) \* width\}px\)`;/);
    expect(layout).toMatch(/if \(draggedIn === navPath\(\)\) \{\s*draggedIn = null;\s*shown = target;/s);
    // The arrival keyframes are gone: nothing arrives, it was already there.
    expect(css).not.toMatch(/@keyframes page-from/);
  });
});

describe("shell: the tab pill floats over the pages, in three segments", () => {
  const layout = read("./+layout.svelte");
  const css = layout.slice(layout.indexOf("<style>"));

  it("floats over the pages instead of taking a row of its own", () => {
    expect(css).toMatch(/\.tabbar\s*\{[^}]*position:\s*absolute;/s);
    expect(css).toMatch(/\.tabbar\s*\{[^}]*z-index:\s*5;/s);
    expect(css).toMatch(/\.content\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s);
    // The list has to keep room at the bottom or the last row hides for good.
    for (const page of ["./+page.svelte", "./split/+page.svelte", "./settings/+page.svelte"]) {
      expect(read(page)).toMatch(/var\(--nav-clearance\)/);
    }
  });

  it("partitions with transparent gaps, edge to edge by construction", () => {
    expect(css).toMatch(/\.tabbar\s*\{[^}]*gap:\s*2px;/s);
    // A drawn line (or a border) is either the page colour or a rounded sliver;
    // a gap is neither, and what scrolls behind it stays visible.
    expect(css).not.toMatch(/\.tab \+ \.tab/);
    // The plate is solid; only the partitions are open.
    expect(css).toMatch(/\.tab\s*\{[^}]*background:\s*var\(--nav-bg\);/s);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/color-mix/);
    // One tone below the card colour, in both themes.
    const app = read("../app.css");
    // The panel colour, darkened -- derived, so both themes get it.
    expect(app).toMatch(
      /--nav-bg:\s*color-mix\(in srgb, var\(--bg-elev\) 93%, #000000\);/,
    );
    // One stadium silhouette: only the outer corners round off.
    expect(css).toMatch(/\.tab:first-child\s*\{\s*border-radius:\s*999px 0 0 999px;/s);
    expect(css).toMatch(/\.tab:last-child\s*\{\s*border-radius:\s*0 999px 999px 0;/s);
  });

  it("is narrower than the window, so it reads as a control and not as an edge", () => {
    // The pill is a fixed, centred object rather than a bar spanning the window.
    expect(css).toMatch(/\.tabbar\s*\{[^}]*width:\s*var\(--nav-width\);/s);
    expect(css).toMatch(/left:\s*50%;/);
  });

  it("leaves the page layer out of the modal fight", () => {
    // will-change would give .page-shell its own stacking context, and every
    // modal inside a page would then paint under the tab pill.
    const shell = css.slice(css.indexOf(".page-shell"), css.indexOf("@keyframes page-from-right"));
    expect(shell).not.toMatch(/will-change\s*:/);
    expect(shell).toMatch(/position:\s*absolute;/);
  });

  it("fades the pages out at the bottom edge, just past the pill", () => {
    const app = read("../app.css");
    // A band, not a curve: it ends a little above the pill's top edge, and its
    // height is the pill's own geometry.
    expect(app).toMatch(/--fade-lift: 12px;/);
    expect(app).toMatch(
      /--fade-height:\s*calc\(var\(--nav-inset\) \+ var\(--nav-height\) \+ var\(--fade-lift\)\);/,
    );
    expect(css).toMatch(
      /\.edge-fade\s*\{[^}]*background:\s*linear-gradient\(to top, var\(--bg\) 45%, transparent\);/s,
    );
    expect(css).toMatch(/\.edge-fade\s*\{[^}]*z-index:\s*3;/s);
    // A mask on the scroll container is what trapped every modal under the pill.
    expect(app).not.toMatch(/fade-y/);
    for (const page of ["./+page.svelte", "./split/+page.svelte", "./settings/+page.svelte"]) {
      expect(read(page)).not.toMatch(/fade-y/);
    }
  });

  it("leaves the split pill out of the scrolling and slides the halves instead", () => {
    const split = read("./split/+page.svelte");
    const css = split.slice(split.indexOf("<style>"));
    // A pinned control is a control that is not inside the thing that scrolls. Pinning
    // it to the scroller with sticky painted the rows through it.
    expect(css).toMatch(/\.page \{[^}]*display: flex;[^}]*overflow: hidden;/s);
    expect(css).not.toMatch(/\.segmented \{[^}]*position: sticky;/s);
    expect(css).toMatch(/\.segmented \{[^}]*flex-shrink: 0;/s);
    // The chosen half travels, and travels with the finger where the shell has it. The
    // transform is on the half: a transform on the pair makes WebKit composite it and
    // paint nothing for the scrollable halves inside -- geometry right, window blank.
    expect(css).toMatch(
      /\.pane \{[^}]*transform: translateX\(calc\(-100% \* var\(--idx, 0\) \+ var\(--pan, 0px\)\)\);[^}]*transition: transform/s,
    );
    expect(css).toMatch(/\.panes--dragging \.pane \{[^}]*transition: none;/s);
    expect(css).not.toMatch(/\.panes \{[^}]*transform:/s);
    // Each half scrolls on its own, so the one you left keeps its position and the
    // taller one cannot carry the other off the screen.
    expect(css).toMatch(/\.pane \{[^}]*flex: 0 0 100%;[^}]*overflow-y: scroll;[^}]*overflow-x: hidden;/s);
    expect(css).toMatch(/\.pane \{[^}]*padding: 0 14px calc\(24px \+ var\(--nav-clearance\)\) 20px;/s);
  });

});

describe("split tunnelling: one scroller, two halves", () => {
  const source = read("./split/+page.svelte");

  it("keeps the half off screen unreachable", () => {
    // Both halves are mounted so the pair can slide; the one the user is not on must
    // not answer clicks, focus or a screen reader.
    expect(source).toMatch(/class="pane"[^>]*inert=\{tab !== "apps"\}\s*aria-hidden=\{tab !== "apps"\}/s);
    expect(source).toMatch(/class="pane"[^>]*inert=\{tab === "apps"\}\s*aria-hidden=\{tab === "apps"\}/s);
  });

  it("keeps the plate a plate, and lets the finger move it", () => {
    // The control's own padding is the plate's inner frame. Spacing around it has to be
    // a margin: as padding it widened the pill to the whole window and floated the
    // labels 20px inside it.
    expect(source).toMatch(/\.segmented \{[^}]*margin: 12px 14px 0 20px;/s);
    expect(source.slice(source.indexOf("<style>"))).not.toMatch(/\.segmented \{[^}]*padding:/s);
    // Under the finger the plate is where the finger is, so it does not animate, and it
    // is the only highlight while it travels.
    expect(source).toMatch(/\.segmented\.seg--dragging \.seg-thumb \{[^}]*transition: none;/s);
    // The plate is placed by measurement, and it may not move until that place has been
    // on screen: a transition starts from whatever the browser computed before, and before
    // the measurement the plate sits over the other label. Enabling the transition in the
    // commit that reveals it is what swept the highlight across the control on arrival.
    expect(source).toMatch(/\.segmented \.seg-thumb \{[^}]*opacity: 0;[^}]*transition: none;/s);
    expect(source).toMatch(
      /\.segmented\.seg--ready \.seg-thumb \{[^}]*opacity: 1;[^}]*transition: transform var\(--transition\);/s,
    );
    expect(source).toMatch(/class:seg--ready=\{plateReady\}/);
    expect(source).toMatch(/function armPlate\(\): void \{\s*if \(plateReady\) return;/);
    // The place has to be computed before the transition is allowed, or the frame that
    // arms it is the frame that moves.
    expect(source).toMatch(
      /requestAnimationFrame\(\(\) => \{\s*void segEl\?\.offsetWidth;\s*plateReady = true;/,
    );
    expect(source).toMatch(/armPlate\(\);\s*\}/);
    expect(source).toMatch(
      /\.segmented\.seg--dragging :global\(button\.active\) \{[^}]*background: transparent;/s,
    );
    // Its place is a number between the two labels, read from the same finger that moves
    // the halves -- so the control above says what the halves are doing.
    expect(source).toMatch(/const segPos = \$derived\.by\(\(\) => \{[\s\S]*?base - paneDrag\.offset \/ span/);
    expect(source).toMatch(/transform: translateX\(\$\{segPos \* seg\.step\}px\)/);
  });

  it("carries one mode card per half, because the categories are independent", () => {
    expect(source).toMatch(/{@render modeCard\("apps"\)}/);
    expect(source).toMatch(/{@render modeCard\("websites"\)}/);
    expect(source).toMatch(/function setActiveMode\(kind: "apps" \| "websites", m: Mode\)/);
  });
});

describe("shell: nothing in the interface is selectable", () => {
  const css = read("../app.css");

  it("draws the scrollbar itself, so it cannot travel with the page", () => {
    const app = read("../app.css");
    const layout = read("./+layout.svelte");
    const shell = layout.slice(layout.indexOf("<div class=\"app\">"), layout.indexOf("<style>"));
    const css = layout.slice(layout.indexOf("<style>"));
    // The bar is a real element in the shell, over the gutter the native one reserves.
    expect(shell).toMatch(/<div\s+class="scroll-strip"/);
    expect(css).toMatch(/\.scroll-strip \{[^}]*position: absolute;[^}]*right: 0;[^}]*width: 6px;/s);
    expect(css).toMatch(/\.scroll-strip \{[^}]*transition: opacity 90ms linear;/s);
    // Out of the way during a swipe, and back afterwards.
    expect(css).toMatch(/:global\(\.swiping\) \.scroll-strip \{[^}]*opacity: 0;/s);
    // Not on Android. A phone reserves no gutter at all -- `@media (pointer: coarse)`
    // zeroes the scrollbar box -- so there is nothing for a drawn bar to sit in, the
    // platform's own overlay bar is the idiom, and a 6px plate that is always on
    // costs width the location rows need. The shell keeps the code (same shell on
    // both platforms) and switches it off here.
    expect(app).toMatch(/::-webkit-scrollbar-thumb \{[^}]*background: var\(--border\);/s);
    expect(css).toMatch(
      /:global\(html\.is-android\) \.scroll-strip \{[^}]*display: none;/s,
    );
    // And the shell knows which scroller to describe: the live page's, not the inert
    // half of the split page, not the neighbour standing beside the finger.
    expect(layout).toMatch(/\.page-shell\.current \[data-scroll\]/);
    expect(layout).toMatch(/if \(!el\.hasAttribute\("inert"\)\) return el;/);
    for (const page of ["./+page.svelte", "./settings/+page.svelte", "./split/+page.svelte"]) {
      expect(read(page)).toMatch(/data-scroll/);
    }
  });

  it("turns selection off on everything", () => {
    expect(css).toMatch(
      /\*\s*\{[^}]*user-select:\s*none;[^}]*-webkit-user-select:\s*none;/s,
    );
  });

  it("leaves the user's own text selectable", () => {
    expect(css).toMatch(
      /input,\s*textarea,\s*select,\s*\[contenteditable\],\s*\.selectable\s*\{[^}]*user-select:\s*text;/s,
    );
  });
});

describe("shell: each tab keeps the position the reader stopped at", () => {
  it("keeps it by never taking the page down", () => {
    // The scroll memory that restored an offset into a re-mounted page is gone with the
    // re-mounting: a page that stays keeps its own scroller, and with it the place.
    for (const page of ["./+page.svelte", "./split/+page.svelte", "./settings/+page.svelte"]) {
      expect(read(page)).not.toMatch(/persistScroll|scroll-memory/);
    }
  });
});
