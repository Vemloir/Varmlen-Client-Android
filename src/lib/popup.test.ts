// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { placeAtPoint } from "./popup";

function viewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: height,
    configurable: true,
  });
}

const restore = () => viewport(1024, 768);
afterEach(restore);

describe("cursor-anchored popup", () => {
  it("puts its top-left corner under the cursor", () => {
    viewport(1024, 768);
    expect(placeAtPoint(300, 200, 220, 156)).toEqual({ top: 206, left: 306 });
  });

  it("opens to the left of the cursor when the right edge is too close", () => {
    viewport(400, 768);
    const { left } = placeAtPoint(390, 100, 220, 156);
    expect(left).toBe(390 - 6 - 220);
  });

  it("opens above the cursor when the bottom edge is too close", () => {
    viewport(1024, 400);
    const { top } = placeAtPoint(100, 390, 220, 156);
    expect(top).toBe(390 - 6 - 156);
  });

  it("never leaves the viewport, even in a corner with no room either way", () => {
    viewport(200, 200);
    const { top, left } = placeAtPoint(199, 199, 220, 156);
    expect(left).toBe(8);
    expect(top + 156).toBeLessThanOrEqual(200 - 8);
  });
});
