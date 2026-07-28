import { describe, expect, it } from "vitest";
import type { ServerEntry } from "./subs.svelte";
import { groupLocations } from "./location-groups";

function server(name: string, id: string): ServerEntry {
  return {
    id,
    flag: name.includes("Netherlands") ? "nl" : "",
    name,
    transport: "VLESS / TCP / REALITY",
    raw: {
      id,
      protocol: "vless",
      uuid: "uuid",
      password: null,
      method: null,
      host: `${id}.example.com`,
      port: 443,
      label: name,
      transport: "tcp",
      security: "reality",
      sni: null,
      fingerprint: null,
      public_key: null,
      short_id: null,
      flow: null,
      path: null,
      mode: null,
      packet_encoding: null,
      raw_params: {},
      source_json: null,
      raw_outbound: null,
    },
  };
}

describe("location grouping", () => {
  it("groups a Proxen backup under its primary without changing list order", () => {
    const groups = groupLocations([
      server("Auto-select", "auto"),
      server("Netherlands", "nl-primary"),
      server("Germany #2", "de-only"),
      server("Netherlands [Backup]", "nl-backup"),
    ]);

    expect(groups.map((group) => group.name)).toEqual([
      "Auto-select",
      "Netherlands",
      "Germany #2",
    ]);
    expect(groups[1].servers.map((entry) => entry.id)).toEqual([
      "nl-primary",
      "nl-backup",
    ]);
  });

  it("does not strip a variant suffix unless a matching primary exists", () => {
    const groups = groupLocations([
      server("Poland [Backup]", "pl"),
      server("Japan #2", "jp"),
    ]);

    expect(groups.map((group) => group.name)).toEqual([
      "Poland [Backup]",
      "Japan #2",
    ]);
    expect(groups.every((group) => group.servers.length === 1)).toBe(true);
  });
});
