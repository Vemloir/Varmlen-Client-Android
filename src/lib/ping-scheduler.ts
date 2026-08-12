/** Probe locations in parallel without launching an unbounded number of
 * throwaway Xray processes. HY2/QUIC handshakes are substantially heavier than
 * raw TCP probes; flooding Android with a process per location made healthy
 * locations exhaust their startup budget and appear as n/a. */
export const MAX_CONCURRENT_LOCATION_PINGS = 4;

export async function runPingsInParallel<T>(
  locations: readonly T[],
  ping: (location: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < locations.length) {
      const location = locations[next++];
      await ping(location);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_LOCATION_PINGS, locations.length) },
      worker,
    ),
  );
}
