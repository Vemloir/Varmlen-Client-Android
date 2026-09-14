import { beforeEach, describe, expect, it } from "vitest";

import { forgetAllScrolls, rememberScroll, savedScroll } from "./scroll-memory";

/**
 * Switching tabs used to throw the reader to the top of the next tab and back to
 * the top of this one, because each page owns its scroll container and that
 * container dies with the route. The memory is per path, so what comes back is
 * the position the reader stopped at, not the position some other tab reached.
 */
describe("scroll position per tab", () => {
  beforeEach(() => forgetAllScrolls());

  it("remembers each path on its own", () => {
    rememberScroll("/", 800);
    rememberScroll("/split", 120);
    expect(savedScroll("/")).toBe(800);
    expect(savedScroll("/split")).toBe(120);
    expect(savedScroll("/settings")).toBe(0);
  });

  it("keeps the last position written", () => {
    rememberScroll("/", 800);
    rememberScroll("/", 1440);
    expect(savedScroll("/")).toBe(1440);
  });

  it("never stores a negative or nonsense offset", () => {
    rememberScroll("/", -50);
    expect(savedScroll("/")).toBe(0);
    rememberScroll("/split", Number.NaN);
    expect(savedScroll("/split")).toBe(0);
  });

  it("forgets the least recently written tab past a bound", () => {
    for (let i = 0; i < 12; i++) rememberScroll(`/page-${i}`, i * 10);
    expect(savedScroll("/page-0")).toBe(0);
    expect(savedScroll("/page-11")).toBe(110);
  });
});
