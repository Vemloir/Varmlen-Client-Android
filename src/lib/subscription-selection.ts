/** Pure selection identity for the location list.
 *
 *  A refresh regenerates every `ServerEntry.id`, so the chosen location has to be
 *  re-found after each fetch. Keying only on the endpoint (`host:port:uuid`) was
 *  not enough: a provider rotates the addresses inside a profile, and a composite
 *  JSON profile exposes its FIRST proxy outbound as its host. When Proxen moved
 *  the primary of «США» to another machine, the stored key matched nothing and
 *  the client silently fell back to the first location of the first subscription
 *  — the user watched the app switch countries by itself.
 *
 *  Resolution therefore ends at "the chosen location is gone" and reports that,
 *  instead of choosing a different one.
 */
import { stripLeadingFlag } from "$lib/api";

/** Minimal structural view of `Subscription`/`ServerEntry`, so this module stays
 *  free of the Svelte store (and testable in isolation). */
export interface SelectableServer {
  id: string;
  name: string;
  raw: {
    protocol: string;
    host: string;
    port: number;
    uuid: string;
    password?: string | null;
    method?: string | null;
  } | null;
}

export interface SelectableSubscription {
  id: string;
  servers: SelectableServer[];
}

export interface SelectionIdentity {
  serverId: string | null;
  /** Stable endpoint key of the selection, see `serverKey`. */
  key: string | null;
  subId: string | null;
  /** Location label as the user saw it — survives endpoint rotation. */
  label: string | null;
}

export interface ResolvedSelection extends SelectionIdentity {
  /** The chosen location is missing from the subscription right now. */
  lost: boolean;
}

/** Stable identity of a location entry. Composite JSON profiles key on their
 *  first proxy outbound, which is exactly what a provider rotates, so callers
 *  must not trust this key alone. */
export function serverKey(srv: SelectableServer): string {
  return srv.raw
    ? [
        srv.raw.protocol,
        srv.raw.host,
        srv.raw.port,
        srv.raw.uuid,
        srv.raw.password ?? "",
        srv.raw.method ?? "",
      ].join("\u0000")
    : srv.id;
}

/** Labels compare ignoring their flag emoji, surrounding space and case: a
 *  refresh re-derives the entry name from the provider's label. */
export function normalizeLocationLabel(name: string): string {
  return stripLeadingFlag(name).trim().toLowerCase();
}

/** Re-find the chosen location: exact entry id → stable endpoint key (same
 *  subscription first) → the same label inside the same subscription.
 *
 *  Never returns a different location than the one that was chosen. When nothing
 *  matches, the identity is passed through untouched, so a later refresh that
 *  brings the location back restores the choice by itself. Adopting the first
 *  location is reserved for a client that never picked anything. */
export function resolveSelection(
  subs: SelectableSubscription[],
  current: SelectionIdentity,
): ResolvedSelection {
  const entries = subs.flatMap((sub) =>
    sub.servers.map((srv) => ({ sub, srv })),
  );
  if (entries.length === 0) {
    return { serverId: null, key: null, subId: null, label: null, lost: false };
  }

  const chosen = (sub: SelectableSubscription, srv: SelectableServer) => ({
    serverId: srv.id,
    key: serverKey(srv),
    subId: sub.id,
    label: srv.name,
    lost: false,
  });

  const byId = entries.find(({ srv }) => srv.id === current.serverId);
  if (byId) return chosen(byId.sub, byId.srv);

  if (current.key) {
    const sameSub =
      current.subId === null
        ? undefined
        : entries.find(
            ({ sub, srv }) =>
              sub.id === current.subId && serverKey(srv) === current.key,
          );
    const match =
      sameSub ?? entries.find(({ srv }) => serverKey(srv) === current.key);
    if (match) return chosen(match.sub, match.srv);
  }

  if (current.subId && current.label) {
    const wanted = normalizeLocationLabel(current.label);
    const match = entries.find(
      ({ sub, srv }) =>
        sub.id === current.subId && normalizeLocationLabel(srv.name) === wanted,
    );
    if (match) return chosen(match.sub, match.srv);
  }

  if (!current.key && !current.label) {
    const first = entries[0];
    return chosen(first.sub, first.srv);
  }

  return {
    serverId: null,
    key: current.key,
    subId: current.subId,
    label: current.label,
    lost: true,
  };
}
