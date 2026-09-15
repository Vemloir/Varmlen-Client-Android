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
    /** Providers put several locations on ONE endpoint and separate them by
     *  transport, path, SNI or flow. A key without them cannot tell an ordinary
     *  location from the profile's "auto choice", so they are part of it. */
    transport?: string | null;
    security?: string | null;
    sni?: string | null;
    flow?: string | null;
    path?: string | null;
    public_key?: string | null;
    short_id?: string | null;
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
        srv.raw.transport ?? "",
        srv.raw.security ?? "",
        srv.raw.sni ?? "",
        srv.raw.flow ?? "",
        srv.raw.path ?? "",
        srv.raw.public_key ?? "",
        srv.raw.short_id ?? "",
      ].join("\u0000")
    : srv.id;
}

/** Labels compare ignoring their flag emoji, surrounding space and case: a
 *  refresh re-derives the entry name from the provider's label. */
export function normalizeLocationLabel(name: string): string {
  return stripLeadingFlag(name).trim().toLowerCase();
}

/** Re-find the chosen location: exact entry id → stable endpoint key → the same
 *  label, all of them INSIDE the card the user picked from while that card
 *  exists.
 *
 *  Scoping to the card is the whole point. The same endpoint can sit in two cards
 *  (a pasted configuration and a provider profile, or the same subscription
 *  imported twice), so resolving an endpoint or a label across every card is how
 *  refreshing one subscription moved the selection into another one -- the
 *  provider rotates the endpoint of the chosen location, the key no longer
 *  matches at home, and a global search happily finds that old endpoint living
 *  somewhere else.
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

  // The card the choice came from owns it. Only when that card is gone (the
  // user removed it) may the choice be re-found in another one.
  const home = current.subId
    ? subs.find((sub) => sub.id === current.subId)
    : undefined;
  const pool = home
    ? entries.filter(({ sub }) => sub.id === home.id)
    : entries;

  const byId = pool.find(({ srv }) => srv.id === current.serverId);
  if (byId) return chosen(byId.sub, byId.srv);

  const wanted = current.label ? normalizeLocationLabel(current.label) : null;

  if (current.key) {
    const matches = pool.filter(({ srv }) => serverKey(srv) === current.key);
    if (matches.length > 0) {
      // Several locations of one provider can share an endpoint exactly and be
      // told apart only by their label (an "auto choice" profile in front of the
      // same servers). Taking the first match in that case is how a refresh moved
      // the user from the location he picked onto the balancer.
      const match =
        matches.length === 1 || wanted === null
          ? matches[0]
          : (matches.find(({ srv }) => normalizeLocationLabel(srv.name) === wanted) ??
            matches[0]);
      return chosen(match.sub, match.srv);
    }
  }

  if (wanted !== null) {
    const match = pool.find(
      ({ srv }) => normalizeLocationLabel(srv.name) === wanted,
    );
    if (match) return chosen(match.sub, match.srv);
  }

  if (!current.serverId && !current.key && !current.label) {
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
