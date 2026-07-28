import type { VlessServer } from "./api";

const PROTOCOL_LABELS: Record<string, string> = {
  vless: "VLESS",
  trojan: "Trojan",
  shadowsocks: "Shadowsocks",
  vmess: "VMess",
  wireguard: "WireGuard",
};

function hysteriaLabel(server: VlessServer): string {
  const outbound = server.raw_outbound as
    | { settings?: { version?: unknown } }
    | null;
  return Number(outbound?.settings?.version) === 2 ? "Hysteria2" : "Hysteria";
}

export function transportSummary(server: VlessServer): string {
  if (server.protocol.toLowerCase() === "hysteria") {
    return [hysteriaLabel(server), server.source_json ? "JSON" : null]
      .filter(Boolean)
      .join(" / ");
  }
  const protocol =
    PROTOCOL_LABELS[server.protocol] ?? server.protocol.toUpperCase();
  const parts = [protocol, server.transport.toUpperCase()];
  if (
    server.security &&
    server.security !== "none" &&
    server.security !== "reality"
  ) {
    parts.push(server.security.toUpperCase());
  }
  if (server.source_json) parts.push("JSON");
  return parts.join(" / ");
}
