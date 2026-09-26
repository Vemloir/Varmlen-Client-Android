import { describe, expect, it } from "vitest";

import { revealDelta } from "./keyboard";

describe("revealing a field above the keyboard", () => {
  it("leaves a field that already clears the keyboard where it is", () => {
    expect(revealDelta(400, 578)).toBe(0);
  });

  it("moves a covered field up to a margin above the keyboard", () => {
    expect(revealDelta(700, 578)).toBe(134);
  });

  it("counts a field that only touches the keyboard as covered", () => {
    expect(revealDelta(570, 578)).toBe(4);
  });
});
