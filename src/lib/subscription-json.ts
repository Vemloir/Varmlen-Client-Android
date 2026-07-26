export function isJsonInput(value: string): boolean {
  const first = value.trimStart()[0];
  return first === "{" || first === "[";
}

export function formatJson(value: string): string {
  return JSON.stringify(JSON.parse(value), null, 2);
}

export function isRemoteSource(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}
