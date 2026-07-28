export interface ManualConfigurationLike<TServer> {
  id: string;
  name: string;
  url: string;
  sourceJson: string | null;
  servers: TServer[];
}

export function isRemoteConfiguration(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

/** Merge legacy local Configuration N cards without fetching anything. */
export function mergeManualConfigurations<
  TServer,
  T extends ManualConfigurationLike<TServer>,
>(items: T[]): T[] {
  const manual = items.filter((item) => !isRemoteConfiguration(item.url));
  if (manual.length <= 1) {
    if (manual.length === 0) return items;
    return items.map((item) =>
      item === manual[0]
        ? {
            ...item,
            name: item.servers.length === 1 ? "Configuration" : "Configurations",
          }
        : item,
    );
  }

  const first = manual[0];
  const parsedSources: unknown[] = [];
  let completeJson = true;
  for (const item of manual) {
    if (item.sourceJson === null) {
      completeJson = false;
      break;
    }
    try {
      const parsed = JSON.parse(item.sourceJson);
      parsedSources.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      completeJson = false;
      break;
    }
  }
  const merged = {
    ...first,
    name:
      manual.reduce((count, item) => count + item.servers.length, 0) === 1
        ? "Configuration"
        : "Configurations",
    servers: manual.flatMap((item) => item.servers),
    sourceJson: completeJson ? JSON.stringify(parsedSources) : null,
  } as T;

  let inserted = false;
  return items.flatMap((item) => {
    if (isRemoteConfiguration(item.url)) return [item];
    if (inserted) return [];
    inserted = true;
    return [merged];
  });
}
