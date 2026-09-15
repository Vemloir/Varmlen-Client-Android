/** Pure identity of a LOCATION ROW, as opposed to the identity of an endpoint.
 *
 *  Hiding and pinning are decisions about the row the user pointed at. Two rows
 *  can sit on one endpoint exactly: the "auto choice" balancer of a JSON profile
 *  exposes the same first proxy outbound as the location behind it, so AegisVPN's
 *  «Автовыбор» and «Finland | Helsinki» share every field of `serverKey`. Keyed by
 *  the endpoint alone, hiding one of them hid both -- which is what the user saw.
 *
 *  The label is what the row shows the user, so it joins the key. The cost is
 *  honest and matches the selection model: renaming a location brings back a
 *  hidden one and unpins a pinned one, because the thing the user acted on is
 *  gone and renamed, not hidden.
 */
import { normalizeLocationLabel, serverKey } from "$lib/subscription-selection";
import type { SelectableServer } from "$lib/subscription-selection";

/** Separator that cannot appear in a label or in an endpoint field. */
export const LOCATION_KEY_SEP = "\u0001";

export function locationKey(srv: SelectableServer): string {
  return `${serverKey(srv)}${LOCATION_KEY_SEP}${normalizeLocationLabel(srv.name)}`;
}

interface KeyedLocations {
  servers: SelectableServer[];
  hiddenKeys?: string[];
  pinnedLocations?: Record<string, number>;
}

/** Older builds keyed hidden and pinned locations by the ENDPOINT only. Rewrite
 *  such a key to the row it can only have meant. When several rows share that
 *  endpoint the intent is genuinely lost, so the key is dropped and the locations
 *  show again -- showing a location the user did not hide is a smaller harm than
 *  hiding a location he never touched. */
export function migrateLocationKeys<T extends KeyedLocations>(sub: T): T {
  const rowsOf = new Map<string, string[]>();
  for (const srv of sub.servers) {
    const endpoint = serverKey(srv);
    const list = rowsOf.get(endpoint) ?? [];
    list.push(locationKey(srv));
    rowsOf.set(endpoint, list);
  }
  const resolve = (key: string): string | null => {
    if (key.includes(LOCATION_KEY_SEP)) return key;
    const rows = rowsOf.get(key) ?? [];
    return rows.length === 1 ? rows[0] : null;
  };

  if (sub.hiddenKeys?.length) {
    sub.hiddenKeys = sub.hiddenKeys
      .map(resolve)
      .filter((k): k is string => k !== null);
  }
  if (sub.pinnedLocations && Object.keys(sub.pinnedLocations).length > 0) {
    const next: Record<string, number> = {};
    for (const [key, at] of Object.entries(sub.pinnedLocations)) {
      const row = resolve(key);
      if (row !== null) next[row] = at;
    }
    sub.pinnedLocations = next;
  }
  return sub;
}