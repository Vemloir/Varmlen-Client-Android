/** Keep probes parallel without launching an unbounded number of temporary
 * Xray processes. HY2/QUIC handshakes are substantially heavier than raw TCP
 * probes, and on Android every probe is its own process: a burst covering a
 * large subscription made healthy locations exhaust their startup budget and
 * show up as n/a. The number is a setting now, but the default starts here
 * rather than at "no limit", because that burst was measured, not imagined. */
export const MAX_CONCURRENT_LOCATION_PINGS = 4;

export async function runPingsInParallel<T>(
  locations: readonly T[],
  ping: (location: T) => Promise<void>,
  limit: number = MAX_CONCURRENT_LOCATION_PINGS,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < locations.length) {
      const location = locations[next++];
      await ping(location);
    }
  };
  // `0` (and anything negative) means "no limit": every location gets its own
  // worker, so the whole subscription is probed at once. The user picks that
  // trade-off in settings; the default keeps bursts from spawning one xray
  // process per location.
  const workers = limit > 0 ? Math.min(limit, locations.length) : locations.length;
  await Promise.all(Array.from({ length: workers }, worker));
}
