import { describe, expect, it } from "vitest";

import {
  COMMIT_FRACTION,
  COMMIT_VELOCITY,
  FLING_MIN_PX,
  SWIPE_AXIS_RATIO,
  neighbourPath,
  pageTravel,
  slideDirection,
  swipeDirection,
  velocityOver,
  wallOffset,
} from "./swipe";

const TABS = ["/", "/split", "/settings"] as const;

/**
 * A swipe has to win against two neighbours: a tap that drifted, and a scroll that
 * wobbled sideways. The decision is the one a pager makes -- far enough, or still
 * moving -- because that is the rule that lets a slow deliberate drag and a short
 * flick both count without letting a list scroll count.
 */
describe("swipe between tabs", () => {
  const W = 440;

  it("switches when the page is dragged past the line", () => {
    expect(swipeDirection(-W * COMMIT_FRACTION, 0, 0, W)).toBe("next");
    expect(swipeDirection(W * COMMIT_FRACTION, 0, 0, W)).toBe("prev");
    // Slow is not the same as unwilling: no clock in the rule.
    expect(swipeDirection(-300, -20, 0.01, W)).toBe("next");
  });

  it("switches on a flick that never reached the line", () => {
    expect(swipeDirection(-60, 0, -1.2, W)).toBe("next");
    expect(swipeDirection(60, 0, 1.2, W)).toBe("prev");
  });

  it("leaves a slow short drag alone", () => {
    expect(swipeDirection(-60, 0, 0, W)).toBe(null);
    expect(swipeDirection(0, 0, 0, W)).toBe(null);
  });

  it("lets the page decide once it is dragged past the line", () => {
    // The finger came back through the page and was still moving right at release,
    // but 200 of 440 pixels are under the reader's eye: it switches.
    expect(swipeDirection(-200, 0, 0.9, W)).toBe("next");
    // Short of the line, the flick has to agree with the drag.
    expect(swipeDirection(-60, 0, 0.9, W)).toBe(null);
  });

  it("does not read a twitch as a flick", () => {
    expect(swipeDirection(-(FLING_MIN_PX - 1), 0, -3, W)).toBe(null);
    expect(swipeDirection(-FLING_MIN_PX, 0, COMMIT_VELOCITY - 0.01, W)).toBe(null);
  });

  it("leaves a scroll that wobbled sideways alone", () => {
    expect(swipeDirection(W, W * SWIPE_AXIS_RATIO - 1, -2, W)).toBe(null);
    expect(swipeDirection(-200, -150, -2, W)).toBe(null);
  });

  it("walks one tab either way and stops at the ends", () => {
    expect(neighbourPath("/", "next", TABS)).toBe("/split");
    expect(neighbourPath("/split", "prev", TABS)).toBe("/");
    expect(neighbourPath("/split", "next", TABS)).toBe("/settings");
    expect(neighbourPath("/", "prev", TABS)).toBe(null);
    expect(neighbourPath("/settings", "next", TABS)).toBe(null);
    expect(neighbourPath("/somewhere/else", "next", TABS)).toBe(null);
  });

  it("slows down into the wall instead of stopping at a number", () => {
    const LIMIT = 96;
    expect(wallOffset(0, LIMIT)).toBe(0);
    // At the wall the page follows the finger.
    expect(wallOffset(6, LIMIT) / 6).toBeGreaterThan(0.93);
    // Every extra pixel of finger buys less page than the one before it: the
    // increments between equal stretches of finger keep falling.
    const marks = [0, 6, 12, 24, 48, 96, 192, 4000];
    const rates = marks.slice(1).map((x, i) => ({ dx: x - marks[i], x, from: marks[i] }))
      .map(({ dx, x, from }) => (wallOffset(x, LIMIT) - wallOffset(from, LIMIT)) / dx);
    rates.forEach((rate, i) => {
      expect(rate).toBeGreaterThan(0);
      if (i > 0) expect(rate).toBeLessThan(rates[i - 1]);
    });
    // It approaches the limit and never arrives, so there is no stop to feel.
    expect(wallOffset(4000, LIMIT)).toBeLessThan(LIMIT);
    expect(wallOffset(4000, LIMIT)).toBeGreaterThan(LIMIT * 0.97);
    // Both ends behave the same way.
    expect(wallOffset(-96, LIMIT)).toBe(-wallOffset(96, LIMIT));
  });

  it("says which way a route change arrives, and stays silent about unknown routes", () => {
    expect(slideDirection("/", "/split", TABS)).toBe("next");
    expect(slideDirection("/settings", "/", TABS)).toBe("prev");
    expect(slideDirection("/split", "/split", TABS)).toBe(null);
    expect(slideDirection("/", "/unknown", TABS)).toBe(null);
  });
});

/**
 * What the page does while the finger is down: it follows it, and it meets a wall
 * only where the strip runs out.
 */
describe("page travel under the finger", () => {
  const LIMIT = 96;
  const W = 440;

  it("follows the finger one for one where there is a page to follow", () => {
    expect(pageTravel(-120, W, LIMIT)).toBe(-120);
    expect(pageTravel(W, W, LIMIT)).toBe(W);
  });

  it("meets the wall from the first pixel at the end of the strip", () => {
    expect(pageTravel(0, 0, LIMIT)).toBe(0);
    expect(pageTravel(-120, 0, LIMIT)).toBeCloseTo(-wallOffset(120, LIMIT));
    expect(pageTravel(-4000, 0, LIMIT)).toBeGreaterThan(-LIMIT);
  });

  it("meets the wall again past a full page", () => {
    expect(pageTravel(W + 120, W, LIMIT)).toBeCloseTo(-(0) - (W + wallOffset(120, LIMIT)) * -1);
    expect(pageTravel(W + 4000, W, LIMIT)).toBeLessThan(W + LIMIT);
  });

  it("slows down the further it is pulled, and mirrors either way", () => {
    const rate = (from: number, to: number) =>
      (pageTravel(to, 0, LIMIT) - pageTravel(from, 0, LIMIT)) / (to - from);
    expect(rate(0, 6)).toBeGreaterThan(rate(300, 306));
    expect(pageTravel(-240, 0, LIMIT)).toBe(-pageTravel(240, 0, LIMIT));
  });
});
