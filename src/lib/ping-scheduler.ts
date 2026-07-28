import type { PingMethod } from "$lib/settings.svelte";

/** Proxy probes may fan one UI location out to several concrete outbounds. */
export function pingWorkerLimit(method: PingMethod): number {
  return method === "proxy" ? 2 : 32;
}
