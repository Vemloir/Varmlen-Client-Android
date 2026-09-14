import { describe, expect, it } from "vitest";

import { navPathFrom } from "./nav-path";
import { neighbourPath } from "./swipe";
import { NAV } from "./nav";

const TAB_PATHS = NAV.map((item) => item.path);

/**
 * Tauri serves the bundle from `tauri://localhost`, and WebKitGTK reports that
 * origin with an empty pathname. Everything in the tab strip is a non-empty path,
 * so the empty string matches nothing: no tab is current, and a swipe cannot find
 * the page it is standing on. This was measured in the installed build -- the
 * handler logged `path=` and nothing after it -- and it made the first tab
 * unswipeable until another tab had been opened by hand.
 */
describe("the path the app runs on", () => {
  it("treats the origin with no path as the first tab", () => {
    expect(navPathFrom("")).toBe("/");
    expect(navPathFrom("index.html")).toBe("/");
    expect(navPathFrom("/index.html")).toBe("/");
  });

  it("leaves real paths alone", () => {
    expect(navPathFrom("/")).toBe("/");
    expect(navPathFrom("/split")).toBe("/split");
    expect(navPathFrom("/settings")).toBe("/settings");
  });

  it("makes the first swipe work before anything has been navigated", () => {
    // The measured failure: standing on the empty pathname, both directions were
    // walls, because no tab is named "".
    expect(neighbourPath(navPathFrom(""), "next", TAB_PATHS)).toBe("/split");
    expect(neighbourPath(navPathFrom(""), "prev", TAB_PATHS)).toBe(null);
  });
});
