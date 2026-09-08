import { describe, expect, it, vi } from "vitest";
import { createLongPress } from "./long-press";

function harness(delay = 500, slop = 10) {
  vi.useFakeTimers();
  const triggers: { x: number; y: number }[] = [];
  const gesture = createLongPress({
    delay,
    slop,
    onTrigger: (p) => triggers.push(p),
  });
  return {
    triggers,
    gesture,
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    done: () => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    },
  };
}

describe("long press", () => {
  it("triggers after the delay and reports where the finger was", () => {
    const h = harness();
    h.gesture.onPress(120, 340);
    h.advance(499);
    expect(h.triggers).toHaveLength(0);
    h.advance(1);
    expect(h.triggers).toEqual([{ x: 120, y: 340 }]);
    h.done();
  });

  it("swallows exactly the click that follows the trigger", () => {
    const h = harness();
    h.gesture.onPress(1, 1);
    h.advance(500);
    expect(h.gesture.consumeClick()).toBe(true);
    // The browser sends one click; a second one is a real click.
    expect(h.gesture.consumeClick()).toBe(false);
    h.done();
  });

  it("never triggers once the finger has travelled past the slop", () => {
    // The gesture dies for good: no menu on release either, which is the whole
    // point — a swipe must never open a menu.
    const h = harness();
    h.gesture.onPress(100, 100);
    h.gesture.onMove(105, 100);
    h.gesture.onMove(100, 140);
    h.advance(2000);
    h.gesture.onRelease();
    expect(h.triggers).toHaveLength(0);
    expect(h.gesture.consumeClick()).toBe(false);
    h.done();
  });

  it("ignores a lift before the delay", () => {
    const h = harness();
    h.gesture.onPress(10, 10);
    h.advance(300);
    h.gesture.onRelease();
    h.advance(2000);
    expect(h.triggers).toHaveLength(0);
    h.done();
  });

  it("ignores a press the list stole by scrolling", () => {
    const h = harness();
    h.gesture.onPress(50, 50);
    h.advance(200);
    expect(h.gesture.armed()).toBe(true);
    h.gesture.cancel();
    h.advance(2000);
    expect(h.triggers).toHaveLength(0);
    expect(h.gesture.armed()).toBe(false);
    h.done();
  });

  it("arms again for the next press", () => {
    const h = harness();
    h.gesture.onPress(1, 1);
    h.gesture.cancel();
    h.gesture.onPress(2, 2);
    h.advance(500);
    expect(h.triggers).toEqual([{ x: 2, y: 2 }]);
    h.done();
  });

  it("treats movement inside the slop as still a press", () => {
    const h = harness(500, 10);
    h.gesture.onPress(100, 100);
    h.gesture.onMove(106, 104);
    h.advance(500);
    expect(h.triggers).toEqual([{ x: 100, y: 100 }]);
    h.done();
  });
});
