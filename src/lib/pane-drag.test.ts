import { describe, expect, it } from "vitest";

import { PaneDrag } from "./pane-drag.svelte";

/**
 * The shell owns the pointer and the split page owns its halves, so what crosses
 * between them is the sideways finger. Two things have to be true of it: the halves
 * sit exactly where the finger puts them while it is down, and letting go hands the
 * page a clean zero in the same frame the half is committed, or the transition starts
 * from a distance the finger has already covered and reads as a snap.
 */
describe("the finger, handed to a page with two halves", () => {
  it("says where the finger is while it is down", () => {
    const drag = new PaneDrag();
    expect(drag.live).toBe(false);
    expect(drag.offset).toBe(0);

    drag.drag(-40);
    expect(drag.live).toBe(true);
    expect(drag.offset).toBe(-40);

    drag.drag(-180);
    expect(drag.offset).toBe(-180);
  });

  it("lets go back to rest, not to where the finger stopped", () => {
    const drag = new PaneDrag();
    drag.drag(-180);
    drag.release();
    expect(drag.live).toBe(false);
    expect(drag.offset).toBe(0);
  });

  it("is quiet again after a gesture that never became a drag", () => {
    const drag = new PaneDrag();
    drag.release();
    expect(drag.live).toBe(false);
    expect(drag.offset).toBe(0);
  });
});
