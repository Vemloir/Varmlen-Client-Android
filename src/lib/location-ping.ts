import type { VlessServer } from "$lib/api";

export type LocationPingMethod = "tcp" | "proxy";

type PingDependencies = {
  tcpPingHost: (host: string, port: number, timeoutMs: number) => Promise<number>;
  proxyGetPing: (server: VlessServer, timeoutMs: number) => Promise<number>;
};

const UDP_ONLY_PROTOCOLS = new Set(["hysteria", "hysteria2", "hy2", "wireguard"]);
const UDP_ONLY_TRANSPORTS = new Set(["hysteria", "hysteria2", "hy2", "kcp", "quic"]);
const UDP_PROXY_TIMEOUT_MS = 15_000;

export function supportsTcpEndpointPing(server: VlessServer): boolean {
  return !(
    UDP_ONLY_PROTOCOLS.has(server.protocol.trim().toLowerCase()) ||
    UDP_ONLY_TRANSPORTS.has(server.transport.trim().toLowerCase())
  );
}

/** Measure UDP-only locations through their working proxy path instead of
 * declaring them dead because their server port does not accept TCP. */
export async function measureLocationPing(
  server: VlessServer,
  method: LocationPingMethod,
  dependencies: PingDependencies,
): Promise<number> {
  const tcpEndpoint = supportsTcpEndpointPing(server);
  if (method === "proxy" || !tcpEndpoint) {
    return dependencies.proxyGetPing(server, tcpEndpoint ? 5000 : UDP_PROXY_TIMEOUT_MS);
  }

  const [tcpRtt] = await Promise.all([
    dependencies.tcpPingHost(server.host, server.port, 2500),
    dependencies.proxyGetPing(server, 5000),
  ]);
  return tcpRtt;
}
