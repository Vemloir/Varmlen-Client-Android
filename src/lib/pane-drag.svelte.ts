/**
 * The finger, while it is moving the halves of a page that has two of them.
 *
 * Split tunnelling is one route with two sections. A swipe between them must not
 * slide the window: the pill stays and the sections travel. So the shell, which owns
 * the pointer, hands the page how far the finger has gone sideways, and the page
 * decides what that means for its own halves.
 *
 * `live` is what tells the page to stop animating: while the finger is down the
 * halves are where the finger puts them, and the moment it is released the page's own
 * transition takes over from exactly that position.
 */
export class PaneDrag {
  live = $state(false);
  /** Sideways offset in pixels, in the direction the finger went. */
  offset = $state(0);

  drag(offset: number): void {
    this.live = true;
    this.offset = offset;
  }

  /** Let go. The offset returns to nothing in the same frame the section index is
   *  committed, so the transform continues from where the finger left it. */
  release(): void {
    this.live = false;
    this.offset = 0;
  }
}

export const paneDrag = new PaneDrag();