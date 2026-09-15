import { describe, expect, it } from "vitest";

import { stripGeometry } from "./scroll-strip";

/**
 * The shell draws the scrollbar, so the geometry of the bar is ours to get right. It
 * follows the convention a thumb uses: its length is the share of the document on
 * screen, and its travel maps the scroll offset onto the space the bar has left.
 */
describe("the scrollbar the shell draws", () => {
  it("is hidden when there is nothing to scroll", () => {
    expect(stripGeometry(0, 600, 610)).toEqual({ top: 0, height: 0, visible: false });
    expect(stripGeometry(0, 0, 0)).toEqual({ top: 0, height: 0, visible: false });
  });

  it("is nearly the whole track when only a little overflows", () => {
    const g = stripGeometry(0, 610, 600);
    expect(g.visible).toBe(true);
    expect(g.height).toBeCloseTo((600 * 600) / 610);
    expect(g.top).toBeCloseTo(0);
  });

  it("maps the scroll offset onto the room the bar has to move in", () => {
    const half = stripGeometry(500, 1600, 600);
    const end = stripGeometry(1000, 1600, 600);
    expect(half.height).toBeCloseTo(225); // 600 * 600 / 1600
    expect(half.top).toBeCloseTo((600 - 225) / 2);
    expect(end.top).toBeCloseTo(600 - 225); // the bar's bottom edge is the viewport's
  });

  it("keeps something visible on a very long list", () => {
    const g = stripGeometry(20000, 40000, 600);
    expect(g.height).toBeGreaterThanOrEqual(24);
    expect(g.top + g.height).toBeLessThanOrEqual(600 + 0.5);
  });

  it("stays inside the viewport when the numbers arrive mid-layout", () => {
    // A scroller measured while its content is still settling can report an offset past
    // the end; the bar must not be drawn outside the page.
    const g = stripGeometry(9000, 1000, 600);
    expect(g.top).toBeCloseTo(600 - g.height);
  });
});
