import { setLongPressHaptics } from "$lib/api";

/**
 * The long-press buzz, on Android.
 *
 * The WebView plays the system LONG_PRESS haptic on every long press, whether or not
 * anything comes of it, so a thumb resting anywhere in the app buzzed. The buzz means
 * "you can select this", and the only things here that can be selected are text
 * fields and text marked `.selectable` (app.css), so the haptic is allowed while a
 * finger is down on one of those and off everywhere else. MainActivity starts it off.
 */

/** Everything a long press can select text in: the same list app.css makes selectable. */
export const COPYABLE =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select, [contenteditable], .selectable';

export function isCopyable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COPYABLE) !== null;
}

/** Tell the WebView at every touch-down, before a long press can happen, and only
 *  when the answer changes. */
export function watchLongPressHaptics(): () => void {
  let allowed = false;
  const onDown = (event: PointerEvent) => {
    const copyable = isCopyable(event.target);
    if (copyable === allowed) return;
    allowed = copyable;
    void setLongPressHaptics(copyable).catch(() => {});
  };
  document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  return () => document.removeEventListener("pointerdown", onDown, true);
}
