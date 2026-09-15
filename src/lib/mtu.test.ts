import { describe, expect, it } from "vitest";
import { MTU_DEFAULT, MTU_MAX, MTU_MIN, normalizeMtu } from "./mtu";

describe("normalizeMtu", () => {
  it("keeps a usable value as it is", () => {
    expect(normalizeMtu(1500)).toBe(1500);
    expect(normalizeMtu(1420)).toBe(1420);
    expect(normalizeMtu(MTU_MIN)).toBe(MTU_MIN);
    expect(normalizeMtu(MTU_MAX)).toBe(MTU_MAX);
  });

  it("clamps a value below the floor instead of resetting it", () => {
    // Someone who typed 1100 meant "smaller than default". Handing back 1500 --
    // the one value that does not work on such a network -- is the worse lie.
    expect(normalizeMtu(1100)).toBe(MTU_MIN);
    expect(normalizeMtu(0)).toBe(MTU_MIN);
  });

  it("clamps a typo above the ceiling", () => {
    expect(normalizeMtu(65535)).toBe(MTU_MAX);
  });

  it("falls back to the default for something that is not a number", () => {
    expect(normalizeMtu(undefined)).toBe(MTU_DEFAULT);
    expect(normalizeMtu("")).toBe(MTU_DEFAULT);
    expect(normalizeMtu("abc")).toBe(MTU_DEFAULT);
    expect(normalizeMtu(null)).toBe(MTU_DEFAULT);
  });

  it("accepts the string a number input hands back", () => {
    // `input type=number` gives "" when the field is emptied and a string otherwise.
    expect(normalizeMtu("1420")).toBe(1420);
    expect(normalizeMtu(1420.7)).toBe(1420);
  });
});