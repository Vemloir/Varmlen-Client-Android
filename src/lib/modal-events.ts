/** Resolve an action from a click without attaching lifecycle-sensitive
 * listeners to modal nodes that Svelte repeatedly creates and destroys. */
export function modalActionFromTarget(
  initialTarget: EventTarget | null,
  boundary: HTMLElement,
): string | null {
  // An icon-only button is clicked on its <svg>/<path>, and an SVGElement is NOT
  // an HTMLElement. Filtering on HTMLElement therefore made every icon button --
  // the ✕ of a modal, for one -- answer only when the user happened to hit the
  // button's own padding instead of the icon.
  let target = initialTarget instanceof Element ? initialTarget : null;
  while (target && target !== boundary) {
    if (target.hasAttribute("data-modal-surface")) return null;
    const action = target.getAttribute("data-modal-action");
    if (action && !target.matches(":disabled")) return action;
    target = target.parentElement;
  }
  return null;
}
