export const SUBSCRIPTION_USER_AGENTS = [
  "varmlen",
  "happ",
  "incy",
  "v2raytun",
] as const;

export type SubscriptionUserAgent = (typeof SUBSCRIPTION_USER_AGENTS)[number];

export function normalizeSubscriptionUserAgent(
  value: unknown,
): SubscriptionUserAgent {
  return typeof value === "string" &&
    SUBSCRIPTION_USER_AGENTS.includes(value as SubscriptionUserAgent)
    ? (value as SubscriptionUserAgent)
    : "varmlen";
}

/** How each identity is spelled to the user -- the same brand spelling the core
 *  puts in the header (`subscription_headers` in `src-tauri/src/lib.rs`).
 *
 *  `v2raytun` is listed here and in the picker even though other platforms
 *  dropped it: Android shipped it, so a stored preference can hold it, and a
 *  provider that gates on that User-Agent stops serving the subscription the
 *  moment the choice is quietly rewritten. A choice the store can hold is a
 *  choice the picker has to show. */
export const SUBSCRIPTION_USER_AGENT_LABELS: Record<SubscriptionUserAgent, string> =
  {
    varmlen: "Varmlen",
    happ: "Happ",
    incy: "INCY",
    v2raytun: "v2rayTun",
  };

/** The picker's options, derived from the choices themselves so the two cannot
 *  drift apart and leave a stored value with no entry to display. */
export function subscriptionUserAgentOptions(): {
  value: SubscriptionUserAgent;
  label: string;
}[] {
  return SUBSCRIPTION_USER_AGENTS.map((value) => ({
    value,
    label: SUBSCRIPTION_USER_AGENT_LABELS[value],
  }));
}
