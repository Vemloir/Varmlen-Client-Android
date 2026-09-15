/**
 * Scroll position per tab.
 *
 * Each page owns its own scroll container, and that container is destroyed when
 * the route changes, so a tab switch threw the reader at the top of the next tab
 * and back to the top of this one. Remembering the offset per path is the whole
 * feature; the bound is here so that a long session with deep links cannot grow
 * a map forever.
 */

const MAX_REMEMBERED = 8;
const offsets = new Map<string, number>();

export function rememberScroll(path: string, top: number): void {
  offsets.delete(path); // re-insert, so the recency order is the real one
  offsets.set(path, Math.max(0, Number.isFinite(top) ? top : 0));
  while (offsets.size > MAX_REMEMBERED) {
    const oldest = offsets.keys().next();
    if (oldest.done) break;
    offsets.delete(oldest.value);
  }
}

export function savedScroll(path: string): number {
  return offsets.get(path) ?? 0;
}

/** Test seam. */
export function forgetAllScrolls(): void {
  offsets.clear();
}

/**
 * Use on a page's scroll container: `use:persistScroll={page.url.pathname}`.
 *
 * The offset is written on every scroll rather than only on teardown, because a
 * window closed mid-scroll never runs our destroy() and the position the user
 * stopped at is the one worth having.
 *
 * A path of null means "this scroller remembers nothing": an element that only stands
 * in for another one, like a page shown next to the finger mid-swipe, has no reading
 * position of its own and must not take one from the map.
 */
export function persistScroll(node: HTMLElement, path: string | null) {
  if (path === null) return { destroy() {} };
  const apply = () => {
    const top = savedScroll(path);
    if (top > 0) node.scrollTop = top;
  };
  apply();
  // Flags and card contents settle a frame after the markup, so one synchronous
  // restore can be measured against a page that is still too short.
  let frame = requestAnimationFrame(apply);
  const onScroll = () => rememberScroll(path, node.scrollTop);
  node.addEventListener("scroll", onScroll, { passive: true });

  return {
    destroy() {
      cancelAnimationFrame(frame);
      rememberScroll(path, node.scrollTop);
      node.removeEventListener("scroll", onScroll);
    },
  };
}