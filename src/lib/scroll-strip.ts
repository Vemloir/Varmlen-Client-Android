/**
 * Where the scrollbar belongs.
 *
 * The bar is drawn by the shell rather than by the page, because the page is the thing
 * a swipe moves: a bar inside it travelled across the screen with the page, and a strip
 * that slides sideways says nothing about where the reader has got to. Drawn here it can
 * also do the one thing a scrollbar pseudo-element cannot -- fade, since WebKit does not
 * animate the properties of `::-webkit-scrollbar-thumb`.
 *
 * The numbers are the ones a thumb uses: the whole travel maps onto the space the bar
 * has to move in, and its length is the share of the document that is on screen, with a
 * floor so a very long list still leaves something to see.
 */
export interface StripGeometry {
  /** Offset from the top of the scroller's own box. */
  top: number;
  height: number;
  visible: boolean;
}

const MIN_HEIGHT_PX = 24;

export function stripGeometry(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): StripGeometry {
  const room = clientHeight - MIN_HEIGHT_PX;
  if (clientHeight <= 0 || room <= 0 || scrollHeight <= clientHeight + 1) {
    return { top: 0, height: 0, visible: false };
  }
  const height = Math.max(MIN_HEIGHT_PX, (clientHeight * clientHeight) / scrollHeight);
  const span = scrollHeight - clientHeight;
  const ratio = span > 0 ? Math.min(1, Math.max(0, scrollTop / span)) : 0;
  return { top: ratio * (clientHeight - height), height, visible: true };
}