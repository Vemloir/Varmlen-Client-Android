import type { ServerEntry } from "./subs.svelte";

export interface LocationGroup {
  id: string;
  name: string;
  flag: string;
  servers: ServerEntry[];
}

const VARIANT_WORD =
  String.raw`(?:backup|reserve|reserved|alt(?:ernative)?|резерв(?:ный|ная)?|запасн(?:ой|ая))`;
const VARIANT_SUFFIXES = [
  new RegExp(
    String.raw`\s*[\[(]\s*${VARIANT_WORD}(?:\s*\d+)?\s*[\])]\s*$`,
    "iu",
  ),
  new RegExp(
    String.raw`\s+(?:[-–—]\s*)?${VARIANT_WORD}(?:\s*\d+)?\s*$`,
    "iu",
  ),
  /\s*(?:#\s*\d+|\[\s*\d+\s*\]|\(\s*\d+\s*\))\s*$/u,
];

function variantBase(name: string): { base: string; stripped: boolean } {
  for (const suffix of VARIANT_SUFFIXES) {
    const base = name.replace(suffix, "").trim();
    if (base && base !== name.trim()) return { base, stripped: true };
  }
  return { base: name.trim(), stripped: false };
}

/**
 * Collapse only proven primary/variant pairs. A lone "Server #2" or
 * "Poland [Backup]" remains untouched until another row shares its base.
 */
export function groupLocations(servers: ServerEntry[]): LocationGroup[] {
  const meta = servers.map((server) => ({
    server,
    ...variantBase(server.name),
  }));
  const counts = new Map<string, number>();
  const hasVariant = new Set<string>();
  for (const item of meta) {
    const key = item.base.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (item.stripped) hasVariant.add(key);
  }

  const groups: LocationGroup[] = [];
  const groupedByBase = new Map<string, LocationGroup>();
  for (const item of meta) {
    const baseKey = item.base.toLocaleLowerCase();
    const shouldGroup = (counts.get(baseKey) ?? 0) > 1 && hasVariant.has(baseKey);
    if (!shouldGroup) {
      groups.push({
        id: item.server.id,
        name: item.server.name,
        flag: item.server.flag,
        servers: [item.server],
      });
      continue;
    }

    let group = groupedByBase.get(baseKey);
    if (!group) {
      group = {
        id: item.server.id,
        name: item.base,
        flag: item.server.flag,
        servers: [],
      };
      groupedByBase.set(baseKey, group);
      groups.push(group);
    }
    group.servers.push(item.server);
  }
  return groups;
}
