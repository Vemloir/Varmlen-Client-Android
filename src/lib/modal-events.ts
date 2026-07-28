/** Resolve an action from a click without attaching lifecycle-sensitive
 * listeners to modal nodes that Svelte repeatedly creates and destroys. */
export function modalActionFromTarget(
  initialTarget: EventTarget | null,
  boundary: HTMLElement,
): string | null {
  let target = initialTarget instanceof HTMLElement ? initialTarget : null;
  while (target && target !== boundary) {
    if (target.hasAttribute("data-modal-surface")) return null;
    const action = target.dataset.modalAction;
    if (action && !target.matches(":disabled")) return action;
    target = target.parentElement;
  }
  return null;
}
