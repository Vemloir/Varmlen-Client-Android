import { NAV } from "$lib/nav";
import {
  neighbourPath,
  pageTravel,
  swipeDirection,
  velocityOver,
  type SwipeDirection,
} from "$lib/swipe";

/**
 * The pointer side of tab swiping. The decision itself lives in `swipe.ts`; this
 * file decides which gestures are ours to take and what the page does while the
 * finger is still down.
 *
 * A gesture that begins on a control is not ours. A row in the location list is a
 * button, so a long press there -- or a tap that drifted sideways -- never turns
 * into a page change underneath the menu it just opened.
 */

/* Anything that takes text, and any window that is already open: a swipe over a
   half-typed form would change the tab and take the draft with it. */
const REFUSED =
  'input, textarea, select, [contenteditable], [data-no-swipe], .modal-backdrop, .loc-menu';

/* A control owns the gesture only until the finger says otherwise. The location
   list is a wall of buttons, so refusing a gesture that starts on one makes the
   first tab unsweipeable -- the page is nothing but rows. What the row actually
   wants is a tap or a long press, and neither of those is sideways. */
const CONTROL = "button, a";

/** Sideways travel before we commit to "this is a swipe" and start dragging. */
const DRAG_START_PX = 10;
/** Sideways travel at which the neighbour is mounted instead: rendering a page costs
 *  60-145ms measured, and paying that after the page has started moving is the jerk
 *  that reads as "nothing happens, then it jumps". Inside the slop the page is still
 *  at rest, so the cost lands where there is nothing to notice. */
const PREVIEW_START_PX = 4;
/** How long a released gesture keeps its neighbour mounted. A second attempt in the
 *  same direction is then free; after this the strip is not held in memory for a
 *  reader who went back to reading the list. */
const WARM_MS = 1200;
/** How far the page will ever slide at the end of the list, approached but not
 *  reached: see wallOffset(). */
const WALL_LIMIT_PX = 96;
/** The window the flick speed is measured over. */
const FLICK_WINDOW_MS = 100;
/** The way back when the drag did not reach the threshold. */
const SETTLE = "transform 160ms cubic-bezier(0.2, 0, 0, 1)";
/** The way forward when a frame was missed. Rendering the neighbour page costs
 *  60-145ms measured; the finger keeps moving while that runs, and the page has to
 *  cover the missed distance in one frame or the gesture reads as a jump. Over
 *  70ms it reads as the sheet catching up. */
const CATCH_UP = "transform 70ms linear";
/** Two missed frames of pointer events: past this the gap is a stall, not jitter. */
const STALL_MS = 32;
/** How long the released page takes to land on the neighbour it was dragged to. */
const COMMIT_MS = 180;
const COMMIT = `transform ${COMMIT_MS}ms cubic-bezier(0.2, 0, 0, 1)`;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SwipeNavOptions {
  /** Read at the moment of the gesture, so the action never holds a stale path. */
  path: () => string;
  /** Resolves once the new page is in the DOM. */
  go: (path: string) => Promise<void> | void;
  /** The element that rides with the pointer: the track carrying the current page
   *  and the neighbour mounted beside it. */
  track?: () => HTMLElement | null;
  /** The neighbour to mount beside the page while the finger is down, and null
   *  when the gesture ends. Without it a swipe reveals a strip of background
   *  instead of the tab it is heading for. */
  preview?: (path: string | null) => void;
  /** The strip, read at the moment of the gesture: the split page is two places
   *  wide, and whether the applications one of them exists depends on the VPN mode. */
  order?: () => readonly string[];
  /** Which page a place belongs to. Two places on one page are two halves of it, and
   *  those do not travel through the window -- see `panes`. */
  route?: (zone: string) => string;
  /** The sideways finger, for a page that carries two halves: the pixels while it is
   *  down, and null when it is gone, which is when the page's own transition takes
   *  over from exactly there. */
  panes?: (offset: number | null) => void;
  /** Where a gesture arriving at a place really lands. The split page opens on the half
   *  that was left selected there, and the neighbour standing beside the finger has to
   *  stand for that same half -- otherwise the page arrives on one half and slides to the
   *  other the moment it lands, which is the jerk a returning reader sees. */
  landing?: (zone: string) => string;
}

export function swipeNav(node: HTMLElement, options: SwipeNavOptions) {
  const routes = NAV.map((item) => item.path);
  const order = () => options.order?.() ?? routes;
  let startX = 0;
  let startY = 0;
  let pointerId: number | null = null;
  /** The recent finger, for the speed at release. */
  let samples: { x: number; t: number }[] = [];
  /** When the last pointer event arrived: a gap of more than two frames is a stall. */
  let lastMoveAt = 0;
  let dragging = false;
  let offset = 0;
  let previewTo: string | null = null;
  let committing = false;
  /** The control the finger landed on, if any, until the gesture takes it away. */
  let control: HTMLElement | null = null;
  /** Whether the finger is currently moving halves of this page rather than pages. */
  let paneGesture = false;

  const track = () => options.track?.() ?? null;

  /** Mount -- or keep mounted -- the neighbour the finger is heading for. */
  const showPreview = (to: string | null) => {
    if (to === previewTo) return;
    previewTo = to;
    options.preview?.(to);
  };

  /** Two places, one page: the neighbour is a half of what is already on screen. */
  const sameRoute = (zone: string) =>
    options.route !== undefined && options.route(zone) === options.route(options.path());

  /** Hand the finger back to the page and let its own transition finish the pan. */
  const endPaneGesture = () => {
    if (!paneGesture) return;
    paneGesture = false;
    options.panes?.(null);
  };

  /** The neighbour in a direction, as the place the gesture will actually land on. */
  const neighbourTo = (from: string, direction: "next" | "prev"): string | null => {
    const zone = neighbourPath(from, direction, order());
    return zone === null ? null : (options.landing?.(zone) ?? zone);
  };

  const move = (dx: number, transition: "settle" | "none" | "catch" = "none") => {
    const element = track();
    if (!element) return;
    element.style.transition =
      transition === "settle" ? SETTLE : transition === "catch" ? CATCH_UP : "none";
    element.style.transform = dx === 0 ? "" : `translateX(${dx}px)`;
  };

  /**
   * The gesture belongs to the page now, so the control under the finger has to
   * be let go. It cannot be left to notice on its own: once this element holds
   * the pointer capture the row stops receiving pointermove, and its long press
   * would fire a menu in the middle of the swipe. So it is told out loud, and the
   * click the browser delivers afterwards never reaches it -- a swipe is not a way
   * of choosing a location.
   */
  const releaseControl = () => {
    const element = control;
    control = null;
    if (!element) return;
    // Not bubbling: the hand-off is addressed to this control, and an event that
    // reached the content area would be read as the platform taking the pointer
    // away -- our own cancel handler would then drop the gesture and spring the
    // page back, which is exactly what a swipe over a location row did.
    element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: false }));
    // Scoped to the control that was let go: a tap somewhere else, a moment
    // later, is a tap and not a leftover of this gesture.
    const swallow = (event: MouseEvent) => {
      const node = event.target as Node | null;
      if (!node || !element.contains(node)) return;
      event.stopPropagation();
      event.preventDefault();
    };
    document.addEventListener("click", swallow, { capture: true });
    setTimeout(() => document.removeEventListener("click", swallow, true), 800);
  };

  const release = () => {
    node.classList.remove("swiping");
    if (pointerId === null) return;
    if (node.hasPointerCapture?.(pointerId)) node.releasePointerCapture(pointerId);
    pointerId = null;
    dragging = false;
  };

  /**
   * Land the released page on its neighbour, then swap the route underneath it.
   * The route changes only after the animation and the preview is dropped in the
   * same frame the track returns to rest: do it the other way round and the old
   * page flashes back at full width while the new one mounts.
   */
  const commit = async (to: string, direction: SwipeDirection) => {
    committing = true;
    const element = track();
    const width = element?.clientWidth ?? 0;
    control = null;
    if (element && width > 0) {
      element.style.transition = COMMIT;
      element.style.transform = `translateX(${direction === "next" ? -width : width}px)`;
      await wait(COMMIT_MS);
    }
    await options.go(to);
    showPreview(null);
    offset = 0;
    if (element) {
      element.style.transition = "none";
      element.style.transform = "";
    }
    committing = false;
  };

  const onDown = (event: PointerEvent) => {
    if (committing) return;
    // A second finger does not replace the one that is already dragging.
    if (pointerId !== null) return;
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(REFUSED)) return;
    control = target?.closest(CONTROL) ?? null;
    startX = event.clientX;
    startY = event.clientY;
    samples = [{ x: startX, t: event.timeStamp }];
    lastMoveAt = event.timeStamp;
    pointerId = event.pointerId;
    dragging = false;
  };

  /**
   * The other half of the same page: the window does not move for it, because the
   * pill over there is chrome and travels with the window. The finger is handed to
   * the page instead, over the same distance the wall would allow a page.
   */
  const movePanes = (dx: number) => {
    paneGesture = true;
    showPreview(null);
    const span = node.getBoundingClientRect().width;
    offset = pageTravel(dx, span, WALL_LIMIT_PX);
    options.panes?.(offset);
  };

  const onMove = (event: PointerEvent) => {
    // Only the pointer that started this gesture. A mouse moving while a finger is
    // down, or a second finger, would otherwise move the page from a start point it
    // never touched.
    if (pointerId === null || event.pointerId !== pointerId) return;
    let dx = event.clientX - startX;
    let dy = event.clientY - startY;
    samples.push({ x: event.clientX, t: event.timeStamp });
    while (samples.length > 2 && event.timeStamp - samples[0].t > FLICK_WINDOW_MS) samples.shift();
    if (!dragging) {
      // Not committed yet: a vertical drag belongs to the list underneath, and
      // stealing it would make the app unreadable by touch.
      if (Math.abs(dx) < DRAG_START_PX || Math.abs(dx) < 2 * Math.abs(dy)) {
        // Still inside the slop. If the finger is going sideways, this is where the
        // neighbour is paid for -- see PREVIEW_START_PX.
        if (Math.abs(dx) >= PREVIEW_START_PX && Math.abs(dx) >= 2 * Math.abs(dy)) {
          showPreview(neighbourTo(options.path(), dx < 0 ? "next" : "prev"));
        }
        return;
      }
      dragging = true;
      // The gesture is anchored here, at the finger, and not at the press. The
      // finger had already travelled the slop by the time this was a swipe, and
      // carrying that into the page is the jump this removes: the page starts
      // moving from rest, from wherever the finger happens to be.
      startX = event.clientX;
      startY = event.clientY;
      // And the travel starts from nothing in this same frame, or the slop the
      // finger already covered would be paid back as a jump.
      dx = 0;
      dy = 0;
      samples = [{ x: startX, t: event.timeStamp }];
      // The thumb of the list gets out of the way for the length of the gesture.
      node.classList.add("swiping");
      try {
        node.setPointerCapture?.(event.pointerId);
      } catch {
        // A pointer that is already gone cannot be captured. The gesture is still
        // worth tracking from the events that do arrive.
      }
      releaseControl();
    }
    const direction: SwipeDirection = dx < 0 ? "next" : "prev";
    const neighbour = neighbourTo(options.path(), direction);
    // Whether this frame arrives late is decided before the clock is moved.
    const stalled = event.timeStamp - lastMoveAt > STALL_MS;
    lastMoveAt = event.timeStamp;
    if (neighbour && sameRoute(neighbour)) {
      movePanes(dx);
      return;
    }
    // The finger turned round and is heading for a different page after all: the
    // halves stop where they are and the window takes over.
    endPaneGesture();
    showPreview(neighbour);
    // The page follows the finger one for one where there is a page to follow, and
    // meets the wall where there is none.
    const span = neighbour ? node.getBoundingClientRect().width : 0;
    offset = pageTravel(dx, span, WALL_LIMIT_PX);
    move(offset, stalled ? "catch" : "none");
  };

  const onUp = (event: PointerEvent) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    const wasDragging = dragging;
    release();
    const dx = event.clientX - startX;
    samples.push({ x: event.clientX, t: event.timeStamp });
    while (samples.length > 2 && event.timeStamp - samples[0].t > FLICK_WINDOW_MS) samples.shift();
    const direction = swipeDirection(
      dx,
      event.clientY - startY,
      velocityOver(samples),
      node.getBoundingClientRect().width,
    );
    const target = direction ? neighbourTo(options.path(), direction) : null;
    if (target && wasDragging && sameRoute(target)) {
      // Nothing to land: the window never moved. Let go of the finger, and the
      // sections travel the rest of the way under their own transition.
      endPaneGesture();
      offset = 0;
      void options.go(target);
      return;
    }
    endPaneGesture();
    if (target && wasDragging) {
      void commit(target, direction === "next" ? "next" : "prev");
      return;
    }
    offset = 0;
    if (wasDragging) move(0, "settle");
    // Kept warm for a moment: an attempt that was refused is usually tried again.
    const token = previewTo;
    if (token) {
      setTimeout(() => {
        if (pointerId === null && !committing && previewTo === token) showPreview(null);
      }, WARM_MS);
    }
  };

  const onCancel = (event: Event) => {
    // Only the platform may take a gesture away from underneath it.
    if (!event.isTrusted) return;
    if (pointerId === null) return;
    release();
    control = null;
    showPreview(null);
    endPaneGesture();
    move(0, "settle");
  };

  // A drag over a picture would otherwise start the browser's own image drag and
  // swallow the gesture.
  const onDragStart = (event: Event) => event.preventDefault();

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onCancel);
  node.addEventListener("lostpointercapture", onCancel);
  node.addEventListener("dragstart", onDragStart);

  return {
    destroy() {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onCancel);
      node.removeEventListener("lostpointercapture", onCancel);
      node.removeEventListener("dragstart", onDragStart);
    },
  };
}