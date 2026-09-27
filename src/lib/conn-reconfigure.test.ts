import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./conn.svelte.ts", import.meta.url), "utf8");

/**
 * A connect while the tunnel is up is a reconfigure: the service swaps the interface
 * without dropping the session. Whether the power button says so depends on what
 * changed -- a split edit is silent, a new location is a connection the reader asked
 * to watch.
 */
describe("reconfiguring a running tunnel", () => {
  it("shows connecting for a new location and nothing for anything else", () => {
    expect(source).toMatch(/const newLocation = reconfigure && this\.appliedServer !== subs\.selectedKey;/);
    expect(source).toMatch(/const quiet = reconfigure && !newLocation;/);
    expect(source).toMatch(/if \(!quiet\) this\.status = "connecting";/);
    expect(source).toMatch(/this\.appliedServer = subs\.selectedKey;/);
  });

  it("still asks the service for a swap, not a teardown, when it shows connecting", () => {
    // The flag handed to vpnConnect is the tunnel's state, not the button's.
    expect(source).toMatch(/settings\.mtu,\s*reconfigure,\s*\);/);
  });
});
