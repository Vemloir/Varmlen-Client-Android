/** Move a node to document.body for its lifetime. A `position: fixed` popup
 *  inside a transformed/masked/filtered ancestor (e.g. our `.fade-y` scroll
 *  panels) would otherwise be positioned relative to that ancestor, not the
 *  viewport — pinning it to the wrong edge. Portalling to body avoids that. */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}

/** Place a `position: fixed` popup next to its trigger, flipping to whichever
 *  side has room and clamping into the viewport. `width`/`height` are the
 *  popup's (estimated) size. Returns top + right (popups are right-aligned to
 *  the trigger, which sits on the right of its row). */
export function placePopup(
  trigger: DOMRect,
  width: number,
  height: number,
  gap = 4,
): { top: number; right: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;

  // Vertical: prefer opening below; if it would overflow the bottom, flip above
  // when there's more room there, otherwise clamp to the bottom.
  let top = trigger.bottom + gap;
  if (top + height > vh - margin) {
    const spaceAbove = trigger.top;
    const spaceBelow = vh - trigger.bottom;
    if (spaceAbove > spaceBelow) {
      top = Math.max(margin, trigger.top - gap - height);
    } else {
      top = Math.max(margin, vh - margin - height);
    }
  }

  // Horizontal: align the popup's right edge to the trigger's right edge, then
  // clamp so neither edge leaves the viewport.
  let right = vw - trigger.right;
  if (vw - right - width < margin) right = vw - width - margin;
  if (right < margin) right = margin;

  return { top, right };
}

/** Where a pointer-anchored popup ended up, and the corner it grows from. */
export interface PointPlacement {
  top: number;
  left: number;
  /** A `transform-origin`: the corner at the pointer, so an opening animation grows
   *  out of the finger rather than out of the popup's own top left. */
  origin: string;
}

/** Place a `position: fixed` popup with one top corner AT the pointer (a popup that
 *  follows the pointer belongs to the pointer, not to a trigger element). It extends
 *  `toward` the side asked for -- its right edge at the pointer when that is left --
 *  and to the other side when there is no room; below the pointer, or above it near
 *  the bottom edge. */
export function placeAtPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  gap = 6,
  toward: "left" | "right" = "right",
): PointPlacement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;

  const rightOfPointer = x + gap;
  const leftOfPointer = x - gap - width;
  let extends_ = toward;
  let left = toward === "right" ? rightOfPointer : leftOfPointer;
  if (toward === "right" && left + width > vw - margin) {
    left = leftOfPointer;
    extends_ = "left";
  } else if (toward === "left" && left < margin) {
    left = rightOfPointer;
    extends_ = "right";
  }
  // Still overflowing after the flip (a popup nearly as wide as the viewport):
  // pull it back rather than let it hang off the screen.
  if (left + width > vw - margin) left = vw - margin - width;
  if (left < margin) left = margin;

  let top = y + gap;
  let opensDown = true;
  if (top + height > vh - margin) {
    top = y - gap - height;
    opensDown = false;
  }
  if (top + height > vh - margin) top = vh - margin - height;
  if (top < margin) top = margin;

  const origin = `${opensDown ? "top" : "bottom"} ${extends_ === "right" ? "left" : "right"}`;
  return { top, left, origin };
}
