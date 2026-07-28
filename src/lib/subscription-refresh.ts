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

export interface SubscriptionRefreshCandidate {
  id: string;
  lastSuccessIso: string;
  intervalHours: number | null;
}

export interface SubscriptionRefreshBatch {
  at: number;
  ids: string[];
}

/** Find the next future boundary and every subscription due on that boundary. */
export function nextRefreshBatch(
  candidates: SubscriptionRefreshCandidate[],
  nowMs: number,
): SubscriptionRefreshBatch | null {
  let at = Number.POSITIVE_INFINITY;
  let ids: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.intervalHours || candidate.intervalHours <= 0) continue;
    let candidateAt: number;
    try {
      candidateAt = nextFutureRefresh(
        candidate.lastSuccessIso,
        candidate.intervalHours,
        nowMs,
      );
    } catch {
      continue;
    }
    if (candidateAt < at) {
      at = candidateAt;
      ids = [candidate.id];
    } else if (candidateAt === at) {
      ids.push(candidate.id);
    }
  }
  return Number.isFinite(at) ? { at, ids } : null;
}
