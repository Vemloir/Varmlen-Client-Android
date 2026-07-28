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
