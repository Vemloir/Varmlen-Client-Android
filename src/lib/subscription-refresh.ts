export function nextFutureRefresh(
  lastSuccessIso: string,
  intervalHours: number,
  nowMs: number,
): number {
  const last = Date.parse(lastSuccessIso);
  const intervalMs = intervalHours * 3_600_000;
  if (
    !Number.isFinite(last) ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isFinite(nowMs)
  ) {
    throw new Error("invalid subscription refresh schedule");
  }
  const elapsed = Math.max(0, nowMs - last);
  return last + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
}
