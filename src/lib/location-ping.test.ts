import { describe, expect, it, vi } from "vitest";
import type { VlessServer } from "$lib/api";
import { measureLocationPing, supportsTcpEndpointPing } from "./location-ping";

const server = (protocol: string, transport: string): VlessServer =>
  ({ protocol, transport, host: "vpn.example", port: 443 }) as VlessServer;

describe("location ping transport selection", () => {
  it.each([
    ["hysteria", "hysteria"],
    ["hysteria2", "hysteria2"],
    ["hy2", "hy2"],
    ["wireguard", "wireguard"],
    ["vless", "kcp"],
    ["vless", "quic"],
  ])("does not TCP-probe UDP-only %s/%s endpoints", async (protocol, transport) => {
    const tcpPingHost = vi.fn().mockResolvedValue(11);
    const proxyGetPing = vi.fn().mockResolvedValue(87);
    const location = server(protocol, transport);

    expect(supportsTcpEndpointPing(location)).toBe(false);
    await expect(
      measureLocationPing(location, "tcp", { tcpPingHost, proxyGetPing }),
    ).resolves.toBe(87);
    expect(tcpPingHost).not.toHaveBeenCalled();
    expect(proxyGetPing).toHaveBeenCalledWith(location, 8000);
  });

  it("keeps TCP RTT only after a TCP location passes the proxy probe", async () => {
    const tcpPingHost = vi.fn().mockResolvedValue(23);
    const proxyGetPing = vi.fn().mockResolvedValue(71);
    const location = server("vless", "tcp");

    await expect(
      measureLocationPing(location, "tcp", { tcpPingHost, proxyGetPing }),
    ).resolves.toBe(23);
    expect(tcpPingHost).toHaveBeenCalledWith("vpn.example", 443, 2500);
    expect(proxyGetPing).toHaveBeenCalledWith(location, 5000);
  });
});
