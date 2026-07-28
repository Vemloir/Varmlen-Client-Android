import { describe, expect, it } from "vitest";
import type { VlessServer } from "./api";
import { transportSummary } from "./server-label";

const base: VlessServer = {
  id: "id",
  protocol: "vless",
  uuid: "uuid",
  password: null,
  method: null,
  host: "vpn.example",
  port: 443,
  label: "Example",
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
  raw_profile: null,
};

describe("location protocol labels", () => {
  it("omits the redundant Reality suffix", () => {
    expect(transportSummary(base)).toBe("VLESS / TCP");
  });

  it("retains useful non-Reality security", () => {
    expect(transportSummary({ ...base, security: "tls" })).toBe(
      "VLESS / TCP / TLS",
    );
  });

  it("shows Hysteria once and distinguishes version 2", () => {
    const hysteria = {
      ...base,
      protocol: "hysteria",
      transport: "hysteria",
      security: "tls",
    };
    expect(
      transportSummary({
        ...hysteria,
        raw_outbound: { protocol: "hysteria", settings: { version: 1 } },
      }),
    ).toBe("Hysteria");
    expect(
      transportSummary({
        ...hysteria,
        source_json: "{}",
        raw_outbound: { protocol: "hysteria", settings: { version: 2 } },
      }),
    ).toBe("Hysteria2 / JSON");
  });
});
