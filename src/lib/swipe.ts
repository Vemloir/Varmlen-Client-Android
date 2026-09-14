/**
 * The gesture behind swiping between tabs, and the arithmetic of where a swipe
 * lands. Pure so the thresholds are a contract instead of a feeling: the same
 * numbers decide whether a horizontal drag is a tab change or the start of a
 * scroll, and that is exactly the kind of rule that feels obvious while typing
 * and feels awful on a phone.
 */

export type SwipeDirection = "next" | "prev";

/** The horizontal travel must beat the vertical by this much, or the user was
 *  scrolling and we would steal the gesture from the list. */
export const SWIPE_AXIS_RATIO = 2;
/** How much of the page has to end up past the finger for the release to switch.
 *  Less than half and a drag back and forth in a list starts changing tabs. */
export const COMMIT_FRACTION = 0.4;
/** How fast the finger has to be moving, in px per ms, for a flick to switch
 *  without reaching that line. Roughly 500 px per second. */
export const COMMIT_VELOCITY = 0.5;
/** Below this travel a fast flick is a twitch, not a swipe. */
export const FLING_MIN_PX = 24;

/**
 * Which way a release commits, decided the way a pager decides it.
 *
 * Either of two things, after the axis test: the page is dragged far enough that it
 * is the one under the reader's eye, or the finger is still moving that way when it
 * leaves. So a slow drag past the line switches, a short flick switches, and a slow
 * short drag in a list commits to nothing. There is no clock here: a drag taken
 * slowly across half the window is a deliberate swipe, and the page has been under
 * the finger the whole time to say so.
 */
export function swipeDirection(
  dx: number,
  dy: number,
  velocityX: number,
  width: number,
): SwipeDirection | null {
  if (Math.abs(dx) < SWIPE_AXIS_RATIO * Math.abs(dy)) return null;
  const far = width > 0 && Math.abs(dx) >= width * COMMIT_FRACTION;
  const fast =
    Math.abs(dx) >= FLING_MIN_PX &&
    Math.abs(velocityX) >= COMMIT_VELOCITY &&
    Math.sign(velocityX) === Math.sign(dx);
  if (!far && !fast) return null;
  return dx < 0 ? "next" : "prev";
}

/**
 * Speed over the recent finger, px per ms, measured across the window the samples
 * cover -- the last stretch of the drag rather than all of it, so a pause before the
 * release reads as the pause it was.
 */
export function velocityOver(samples: { x: number; t: number }[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.x - first.x) / dt;
}

/**
 * The tab a swipe opens. The ends are walls, not a carousel: pulling past the
 * first tab and arriving at the last one reads as a bug, and on a three-tab bar
 * there is nothing to loop for.
 */
export function neighbourPath(
  current: string,
  direction: SwipeDirection,
  order: readonly string[],
): string | null {
  const at = order.indexOf(current);
  if (at === -1) return null;
  const target = direction === "next" ? at + 1 : at - 1;
  if (target < 0 || target >= order.length) return null;
  return order[target];
}

/**
 * How far the page actually moves when the finger pulls past the first or the
 * last tab.
 *
 * At the wall the page follows the finger one to one, and every extra pixel of
 * finger buys proportionally less page: the pull slows down on its own and
 * approaches `limit` without ever reaching it. A fixed fraction with a hard cap
 * -- what this replaces -- stops dead at a number, which feels like hitting a bug
 * rather than the end of the app. The distance is in pixels of finger travel,
 * because that is the only thing the gesture knows.
 */
export function wallOffset(raw: number, limit: number): number {
  const distance = Math.abs(raw);
  const eased = (limit * distance) / (limit + distance);
  return raw < 0 ? -eased : eased;
}

/**
 * How far the page travels for a given travel of the finger.
 *
 * Under the finger the page answers one for one. Resistance in the middle of a swipe
 * is what makes a swipe feel dead: two hundred pixels of finger buying seventy of
 * page reads as a screen that is not listening. Resistance belongs to the ends, where
 * there is nothing to move into -- with `span` at zero the page meets the wall from
 * the first pixel -- and to past a full page, where the neighbour is already out
 * ahead and pulling further promises a jump the release never makes.
 */
export function pageTravel(raw: number, span: number, wallLimit: number): number {
  const distance = Math.abs(raw);
  const sign = raw < 0 ? -1 : 1;
  if (span <= 0) return sign * wallOffset(distance, wallLimit);
  if (distance <= span) return raw;
  return sign * (span + wallOffset(distance - span, wallLimit));
}

/**
 * Which way a route change should slide. Positive means the new page comes from
 * the right, which is where it is when you swipe left. Returns null when either
 * route is unknown (a modal, a deep link) -- no direction, no animation.
 */
export function slideDirection(
  from: string,
  to: string,
  order: readonly string[],
): SwipeDirection | null {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1 || a === b) return null;
  return b > a ? "next" : "prev";
}
