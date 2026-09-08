/** Long-press detection that does not fight scrolling.
 *
 *  On Android the location menu opens on a long press, but a long press starts
 *  exactly like a scroll: finger down, finger moves, list scrolls. A naive timer
 *  therefore pops a menu in the middle of a swipe. The rule the user asked for is
 *  "if this same press already scrolled the list, no menu", which is what this
 *  implements: any movement past the slop, any scroll event, or a lift before the
 *  delay kills the gesture for good — not just for the timer, but for the release
 *  too, so a slow swipe cannot trigger a menu on finger-up.
 *
 *  Browsers also deliver a `click` after a long press. `consumeClick()` reports
 *  that click once so the caller can swallow it instead of selecting the location
 *  the user meant to open a menu on.
 */

export const DEFAULT_LONG_PRESS_MS = 500;
/** How far the finger may wander before the press stops being a press. */
export const DEFAULT_LONG_PRESS_SLOP = 10;

export interface LongPressOptions {
  delay?: number;
  slop?: number;
  onTrigger: (point: { x: number; y: number }) => void;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface LongPressGesture {
  onPress(x: number, y: number): void;
  onMove(x: number, y: number): void;
  onRelease(): void;
  /** The gesture died somewhere else (the list scrolled, the touch was taken by
   *  the system, another element captured the pointer). */
  cancel(): void;
  /** Swallow the click that follows a long press. */
  consumeClick(): boolean;
  /** True while a press is still armed (used to attach scroll listeners). */
  armed(): boolean;
}

export function createLongPress(options: LongPressOptions): LongPressGesture {
  const delay = options.delay ?? DEFAULT_LONG_PRESS_MS;
  const slop = options.slop ?? DEFAULT_LONG_PRESS_SLOP;
  const schedule =
    options.schedule ?? ((fn, ms) => setTimeout(fn, ms as number));
  const unschedule = options.unschedule ?? ((handle) => clearTimeout(handle));

  let handle: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let isArmed = false;
  let didTrigger = false;
  let swallowClick = false;

  const disarm = () => {
    isArmed = false;
    if (handle !== null) {
      unschedule(handle);
      handle = null;
    }
  };

  return {
    onPress(x, y) {
      disarm();
      startX = x;
      startY = y;
      didTrigger = false;
      isArmed = true;
      handle = schedule(() => {
        if (!isArmed) return;
        isArmed = false;
        handle = null;
        didTrigger = true;
        swallowClick = true;
        options.onTrigger({ x, y });
      }, delay);
    },
    onMove(x, y) {
      if (!isArmed) return;
      if (Math.abs(x - startX) > slop || Math.abs(y - startY) > slop) disarm();
    },
    onRelease() {
      disarm();
      didTrigger = false;
    },
    cancel() {
      disarm();
      didTrigger = false;
    },
    consumeClick() {
      if (!swallowClick) return false;
      swallowClick = false;
      return true;
    },
    armed() {
      return isArmed;
    },
  };
}
