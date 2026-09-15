// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { SPLIT_APPS, SPLIT_SITES } from "./nav-zones";
import { forgetAllScrolls, persistScroll, rememberScroll, savedScroll } from "./scroll-memory";

/**
 * Split tunnelling is one route with two halves, and each half is its own scroller, so
 * the two remember separately. A scroller that only stands in for another one -- the
 * page shown beside the finger in the middle of a swipe -- has no reading position of
 * its own: restoring one would write it back on its first scroll event, and the real
 * half would come back to a position some copy of it had reached.
 */
const fakeScroller = () => {
  const node = document.createElement("div");
  return node;
};

describe("each half of the split page remembers on its own", () => {
  beforeEach(() => forgetAllScrolls());

  it("keeps the two halves apart", () => {
    const apps = fakeScroller();
    const sites = fakeScroller();
    persistScroll(apps, SPLIT_APPS);
    persistScroll(sites, SPLIT_SITES);

    apps.scrollTop = 400;
    apps.dispatchEvent(new Event("scroll"));
    sites.scrollTop = 60;
    sites.dispatchEvent(new Event("scroll"));

    expect(savedScroll(SPLIT_APPS)).toBe(400);
    expect(savedScroll(SPLIT_SITES)).toBe(60);
  });

  it("hands a half back the position it was left at", () => {
    rememberScroll(SPLIT_APPS, 250);
    const again = fakeScroller();
    persistScroll(again, SPLIT_APPS);
    expect(again.scrollTop).toBe(250);
  });

  it("neither reads nor writes for a half that is only standing in", () => {
    rememberScroll(SPLIT_APPS, 500);
    const standIn = fakeScroller();
    const action = persistScroll(standIn, null);
    // It did not jump to where the real half had got to.
    expect(standIn.scrollTop).toBe(0);
    standIn.scrollTop = 640;
    standIn.dispatchEvent(new Event("scroll"));
    action.destroy();
    // And it left no position behind for the real half to come back to.
    expect(savedScroll(SPLIT_APPS)).toBe(500);
  });
});