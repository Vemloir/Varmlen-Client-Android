/**
 * The arithmetic behind the strip that reports what a subscription has spent.
 *
 * The numbers come from a provider, and providers are the unreliable part of that
 * sentence: some send no quota, some send a quota and no usage, some send more spent
 * than the quota allows. All three have to end up as a strip that is drawn and a
 * figure that is honest, so the rules live here rather than in the page.
 */

/** How full the strip is, 0-100. An unknown total is not an infinite bar: it is a
 *  bar with nothing known about it, so it stays empty. */
export function trafficPercent(usedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0 || usedBytes <= 0) return 0;
  return Math.min(100, (usedBytes / totalBytes) * 100);
}

/** Whether the provider sent any figure at all. It no longer decides whether the
 *  strip is drawn -- it decides what the strip says. */
export function hasTraffic(usedBytes: number, totalBytes: number): boolean {
  return totalBytes > 0 || usedBytes > 0;
}
