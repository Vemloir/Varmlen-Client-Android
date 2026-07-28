import type { VlessServer } from "$lib/api";

export function isJsonInput(value: string): boolean {
  const first = value.trimStart()[0];
  return first === "{" || first === "[";
}

export function formatJson(value: string): string {
  return JSON.stringify(JSON.parse(value), null, 2);
}

export function isRemoteSource(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

type JsonObject = Record<string, unknown>;

const LOCATION_PROTOCOLS = new Set([
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "hysteria",
  "wireguard",
  "http",
  "socks",
]);

function objectValue(value: unknown, name: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as JsonObject;
}

function requiredString(object: JsonObject, name: string): string {
  const value = object[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(object: JsonObject, name: string): string | null {
  const value = object[name];
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string or null`);
  return value;
}

/** Pretty JSON shown in the location detail editor. */
export function formatLocationJson(server: VlessServer): string {
  return server.source_json
    ? formatJson(server.source_json)
    : JSON.stringify(server, null, 2);
}

/** Parse the editable location model into the exact structure consumed by the
 *  Rust config builder. Defaults are limited to fields that the URI parser also
 *  treats as optional; credentials, host, port and protocol remain mandatory. */
export function parseLocationJson(source: string): VlessServer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = objectValue(parsed, "location");
  const protocol = requiredString(object, "protocol").toLowerCase();
  if (!LOCATION_PROTOCOLS.has(protocol)) {
    throw new Error(
      "protocol must be vless, vmess, trojan, shadowsocks, hysteria, wireguard, http or socks",
    );
  }
  const host = requiredString(object, "host");
  const port = object.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error("port must be an integer from 1 to 65535");
  }

  const uuid = optionalString(object, "uuid") ?? "";
  const password = optionalString(object, "password");
  const method = optionalString(object, "method");
  if ((protocol === "vless" || protocol === "vmess") && !uuid.trim()) {
    throw new Error("uuid must be a non-empty string for this protocol");
  }
  if ((protocol === "trojan" || protocol === "shadowsocks") && !password?.trim()) {
    throw new Error("password must be a non-empty string for this protocol");
  }
  if (protocol === "shadowsocks" && !method?.trim()) {
    throw new Error("method must be a non-empty string for shadowsocks");
  }

  const rawParamsValue = object.raw_params ?? {};
  const rawParamsObject = objectValue(rawParamsValue, "raw_params");
  const raw_params: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawParamsObject)) {
    if (typeof value !== "string") throw new Error(`raw_params.${key} must be a string`);
    raw_params[key] = value;
  }

  return {
    id: optionalString(object, "id") ?? "",
    protocol,
    uuid,
    password,
    method,
    host,
    port: port as number,
    label: optionalString(object, "label")?.trim() || host,
    transport: optionalString(object, "transport")?.trim().toLowerCase() || "tcp",
    security: optionalString(object, "security")?.trim().toLowerCase() || "none",
    sni: optionalString(object, "sni"),
    fingerprint: optionalString(object, "fingerprint"),
    public_key: optionalString(object, "public_key"),
    short_id: optionalString(object, "short_id"),
    flow: optionalString(object, "flow"),
    path: optionalString(object, "path"),
    mode: optionalString(object, "mode"),
    packet_encoding: optionalString(object, "packet_encoding"),
    raw_params,
    source_json: null,
    raw_outbound: null,
    raw_profile: null,
  };
}
