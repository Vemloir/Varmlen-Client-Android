/** The MTU of the tunnel interface, as a user setting.
 *
 *  The client used to hardcode 1500 -- Ethernet's default -- and that is the one
 *  value a tunnel cannot always use: under WireGuard, Hysteria or a provider that
 *  encapsulates again, 1500 on the inner interface means the outer packet exceeds
 *  what the path carries, and the connection dies exactly on the large responses
 *  the user cares about (small requests still work, which is why such a network
 *  looks "half alive"). Making it a setting is also what keeps it out of the
 *  location editor, where a per-location MTU would fight the interface.
 *
 *  1280 is the floor because that is the minimum IPv6 link MTU (RFC 8200) -- below
 *  it xray's interface stops being able to carry IPv6 at all. 9000 is a ceiling
 *  worth naming: jumbo frames are fine to ask for on a tunnel, and a typo should
 *  not produce a 65535 interface that black-holes everything.
 */
export const MTU_DEFAULT = 1500;
export const MTU_MIN = 1280;
export const MTU_MAX = 9000;

/** Keep a value inside the usable range.
 *
 *  Out-of-range numbers are CLAMPED rather than reset: someone who typed 1100
 *  meant "smaller than default", and silently handing back 1500 -- the value that
 *  does not work on his network -- is the worse lie. Only something that is not a
 *  number at all falls back to the default. */
export function normalizeMtu(value: unknown): number {
  // An emptied number input gives "" -- that is "I removed the value", not "set it
  // to zero", so it becomes the default rather than the floor.
  if (value === null || value === undefined || value === "") return MTU_DEFAULT;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return MTU_DEFAULT;
  const rounded = Math.floor(n);
  if (rounded < MTU_MIN) return MTU_MIN;
  if (rounded > MTU_MAX) return MTU_MAX;
  return rounded;
}