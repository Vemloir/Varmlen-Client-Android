/**
 * The on-screen keyboard, as the page sees it on Android.
 *
 * The WebView is never told about the keyboard: MainActivity strips it from the
 * insets the WebView receives, because a WebView that knows shrinks its visual
 * viewport and pans it to the focused field -- the whole app slides off the top of
 * the screen. The activity sends the height here instead (`varmlen-ime`, and the
 * `--ime-height` property the sheets pad themselves with), and moving a covered
 * field into view is this module's job.
 */

/** Room left between a revealed field and the top of the keyboard. */
const MARGIN_PX = 12;
/** Past the sheets' own lift (a 140ms padding transition), so the field is
 *  measured where it ends up rather than where it starts. */
const SETTLE_MS = 200;

/** How far a scroller has to move for a field ending at `fieldBottom` to end above
 *  `visibleBottom`, or 0 when it already does. */
export function revealDelta(fieldBottom: number, visibleBottom: number): number {
  return Math.max(0, Math.ceil(fieldBottom + MARGIN_PX - visibleBottom));
}

function isScroller(element: HTMLElement): boolean {
  const overflow = getComputedStyle(element).overflowY;
  return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight;
}

/**
 * Scroll the field's nearest scroller so the field clears the keyboard. Only that
 * scroller: `scrollIntoView` would also scroll every `overflow: hidden` ancestor it
 * passes, and the app's content area is one -- that is the same slide off the top
 * this whole arrangement exists to prevent.
 */
export function revealAboveKeyboard(field: HTMLElement, keyboardHeight: number): void {
  let scroller = field.parentElement;
  while (scroller && !isScroller(scroller)) scroller = scroller.parentElement;
  if (!scroller) return;
  const visibleBottom = Math.min(
    scroller.getBoundingClientRect().bottom,
    window.innerHeight - keyboardHeight,
  );
  const delta = revealDelta(field.getBoundingClientRect().bottom, visibleBottom);
  if (delta > 0) scroller.scrollTop += delta;
}

const TEXT_FIELD = 'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable]';

/** Follow the keyboard: whenever it opens over a focused text field, reveal it. */
export function watchKeyboard(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onKeyboard = (event: Event) => {
    const height = (event as CustomEvent<number>).detail;
    clearTimeout(timer);
    if (!(height > 0)) return;
    timer = setTimeout(() => {
      const field = document.activeElement;
      if (field instanceof HTMLElement && field.matches(TEXT_FIELD)) revealAboveKeyboard(field, height);
    }, SETTLE_MS);
  };
  window.addEventListener("varmlen-ime", onKeyboard);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("varmlen-ime", onKeyboard);
  };
}
