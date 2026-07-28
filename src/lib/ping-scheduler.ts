/** Start every location immediately. The backend already keeps all concrete
 *  outbounds of one composite JSON location inside one temporary Xray process,
 *  so serialising locations here only multiplies the total wait time. */
export async function runPingsInParallel<T>(
  locations: readonly T[],
  ping: (location: T) => Promise<void>,
): Promise<void> {
  await Promise.all(locations.map((location) => ping(location)));
}
