import type { VlessServer } from "./api";

export type LocationField =
  | "label"
  | "protocol"
  | "host"
  | "port"
  | "uuid"
  | "password"
  | "method"
  | "transport"
  | "security"
  | "sni"
  | "fingerprint"
  | "public_key"
  | "short_id"
  | "flow"
  | "path"
  | "mode"
  | "packet_encoding"
  | "local_address"
  | "pre_shared_key"
  | "reserved"
  | "mtu"
  | "domain_strategy";

export interface FieldLocationDraft {
  kind: "fields";
  values: Record<LocationField, string>;
  rawParams: Array<{ id: string; key: string; value: string }>;
}

export interface JsonLocationDraft {
  kind: "json";
  source: string;
}

export type LocationEditDraft = FieldLocationDraft | JsonLocationDraft;

export type DraftCompileResult =
  | { ok: true; server: VlessServer }
  | { ok: false; error: string };

function text(value: string | null): string {
  return value ?? "";
}

function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatJsonForEditing(source: string): string {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

const STRUCTURED_RAW_PARAMS = new Set([
  "localAddress",
  "preSharedKey",
  "reserved",
  "mtu",
  "domainStrategy",
]);

export function createLocationDraft(server: VlessServer): LocationEditDraft {
  if (server.source_json !== null) {
    return { kind: "json", source: formatJsonForEditing(server.source_json) };
  }
  return {
    kind: "fields",
    values: {
      label: server.label,
      protocol: server.protocol,
      host: server.host,
      port: String(server.port),
      uuid: server.uuid,
      password: text(server.password),
      method: text(server.method),
      transport: server.transport,
      security: server.security,
      sni: text(server.sni),
      fingerprint: text(server.fingerprint),
      public_key: text(server.public_key),
      short_id: text(server.short_id),
      flow: text(server.flow),
      path: text(server.path),
      mode: text(server.mode),
      packet_encoding: text(server.packet_encoding),
      local_address: server.raw_params.localAddress ?? "",
      pre_shared_key: server.raw_params.preSharedKey ?? "",
      reserved: server.raw_params.reserved ?? "",
      mtu: server.raw_params.mtu ?? "",
      domain_strategy: server.raw_params.domainStrategy ?? "",
    },
    rawParams: Object.entries(server.raw_params)
      .filter(([key]) => !STRUCTURED_RAW_PARAMS.has(key))
      .map(([key, value]) => ({
        id: crypto.randomUUID(),
        key,
        value,
      })),
  };
}

export function compileFieldDraft(
  draft: FieldLocationDraft,
  previous: VlessServer,
): DraftCompileResult {
  const protocol = draft.values.protocol.trim().toLowerCase();
  if (!protocol) return { ok: false, error: "protocol is required" };
  const host = draft.values.host.trim();
  if (!host) return { ok: false, error: "host is required" };
  const port = Number(draft.values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, error: "port must be an integer from 1 to 65535" };
  }
  const uuid = draft.values.uuid.trim();
  const password = optional(draft.values.password);
  const method = optional(draft.values.method);
  if ((protocol === "vless" || protocol === "vmess") && !uuid) {
    return { ok: false, error: "UUID is required for this protocol" };
  }
  if ((protocol === "trojan" || protocol === "shadowsocks") && !password) {
    return { ok: false, error: "password is required for this protocol" };
  }
  if (protocol === "shadowsocks" && !method) {
    return { ok: false, error: "method is required for Shadowsocks" };
  }
  if (protocol === "hysteria" && !uuid) {
    return { ok: false, error: "authentication is required for Hysteria2" };
  }
  if (protocol === "wireguard" && !uuid) {
    return { ok: false, error: "private key is required for WireGuard" };
  }
  if (
    protocol === "wireguard" &&
    !draft.values.public_key.trim()
  ) {
    return { ok: false, error: "peer public key is required for WireGuard" };
  }
  const raw_params: Record<string, string> = {};
  for (const row of draft.rawParams) {
    const key = row.key.trim();
    if (key) raw_params[key] = row.value;
  }
  const setRaw = (key: string, value: string): void => {
    const trimmed = value.trim();
    if (trimmed) raw_params[key] = trimmed;
    else delete raw_params[key];
  };
  const isHysteria = protocol === "hysteria";
  const isWireGuard = protocol === "wireguard";
  if (isWireGuard) {
    setRaw("localAddress", draft.values.local_address);
    setRaw("preSharedKey", draft.values.pre_shared_key);
    setRaw("reserved", draft.values.reserved);
    setRaw("mtu", draft.values.mtu);
    setRaw(
      "domainStrategy",
      draft.values.domain_strategy || "ForceIP",
    );
  }
  return {
    ok: true,
    server: {
      ...previous,
      protocol,
      uuid,
      password,
      method,
      host,
      port,
      label: draft.values.label.trim() || host,
      transport: isHysteria
        ? "hysteria"
        : isWireGuard
          ? "wireguard"
          : draft.values.transport.trim().toLowerCase() || "tcp",
      security: isHysteria
        ? "tls"
        : isWireGuard
          ? "none"
          : draft.values.security.trim().toLowerCase() || "none",
      sni: optional(draft.values.sni),
      fingerprint: optional(draft.values.fingerprint),
      public_key: optional(draft.values.public_key),
      short_id: optional(draft.values.short_id),
      flow: optional(draft.values.flow),
      path: optional(draft.values.path),
      mode: optional(draft.values.mode),
      packet_encoding: optional(draft.values.packet_encoding),
      raw_params,
      source_json: null,
      raw_outbound: null,
      raw_profile: null,
    },
  };
}
