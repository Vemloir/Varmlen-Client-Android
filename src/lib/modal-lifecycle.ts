/** End the browser/WebView editing session before replacing modal DOM.
 * Android WebView may otherwise keep the removed input/textarea as its native
 * touch target, leaving the next modal visible but unable to receive taps. */
export function releaseActiveControl(doc: Document = document): void {
  const active = doc.activeElement;
  if (active instanceof HTMLElement) active.blur();
  doc.getSelection()?.removeAllRanges();
}
