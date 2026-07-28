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
  | "packet_encoding";

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

export function createLocationDraft(server: VlessServer): LocationEditDraft {
  if (server.source_json !== null) {
    return { kind: "json", source: server.source_json };
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
    },
    rawParams: Object.entries(server.raw_params).map(([key, value]) => ({
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
  const raw_params: Record<string, string> = {};
  for (const row of draft.rawParams) {
    const key = row.key.trim();
    if (key) raw_params[key] = row.value;
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
      transport: draft.values.transport.trim().toLowerCase() || "tcp",
      security: draft.values.security.trim().toLowerCase() || "none",
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
