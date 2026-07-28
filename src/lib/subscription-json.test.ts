import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatJson,
  formatLocationJson,
  isJsonInput,
  isRemoteSource,
  parseLocationJson,
} from "./subscription-json";
import { transportSummary } from "./subs.svelte";

describe("subscription JSON helpers", () => {
  it("detects JSON objects and arrays after whitespace", () => {
    expect(isJsonInput('  {"outbounds":[]}')).toBe(true);
    expect(isJsonInput('\n["vless://…"]')).toBe(true);
    expect(isJsonInput("https://example.com/sub")).toBe(false);
  });

  it("formats valid JSON and rejects invalid JSON", () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(() => formatJson("{")).toThrow();
  });

  it("recognises only HTTP subscription sources as remote", () => {
    expect(isRemoteSource("https://example.com/sub")).toBe(true);
    expect(isRemoteSource("HTTP://example.com/sub")).toBe(true);
    expect(isRemoteSource("vless://example")).toBe(false);
  });

  it("round-trips the editable location model without losing transport fields", () => {
    const source = JSON.stringify({
      id: "server-1",
      protocol: "vless",
      uuid: "16ddb21e-5342-4a82-a870-1038b01b8dbc",
      password: null,
      method: null,
      host: "vpn.example.com",
      port: 443,
      label: "Germany | Frankfurt",
      transport: "xhttp",
      security: "reality",
      sni: "gateway.icloud.com",
      fingerprint: "chrome",
      public_key: "public-key",
      short_id: "deadbeef",
      flow: null,
      path: "/",
      mode: "auto",
      packet_encoding: "xudp",
      raw_params: { spx: "/", host: "cdn.example.com" },
      source_json: null,
      raw_outbound: null,
      raw_profile: null,
    });

    const parsed = parseLocationJson(formatLocationJson(JSON.parse(source)));
    expect(parsed).toEqual(JSON.parse(source));
  });

  it("shows the provider JSON for a JSON-backed location", () => {
    const source_json = JSON.stringify({
      remarks: "Germany",
      outbounds: [{ protocol: "vless", settings: { vnext: [] } }],
    });
    const server = {
      protocol: "vless",
      transport: "xhttp",
      security: "reality",
      source_json,
    };

    expect(JSON.parse(formatLocationJson(server as never))).toEqual(
      JSON.parse(source_json),
    );
    expect(transportSummary(server as never)).toBe(
      "VLESS / XHTTP / REALITY / JSON",
    );
  });

  it("rejects location JSON that cannot produce a safe server config", () => {
    expect(() =>
      parseLocationJson('{"protocol":"vless","host":"","port":443,"uuid":"u"}'),
    ).toThrow("host");
    expect(() =>
      parseLocationJson('{"protocol":"vless","host":"vpn.example","port":70000,"uuid":"u"}'),
    ).toThrow("port");
    expect(() =>
      parseLocationJson('{"protocol":"unknown","host":"vpn.example","port":443}'),
    ).toThrow("protocol");
    expect(() =>
      parseLocationJson('{"protocol":"trojan","host":"vpn.example","port":443}'),
    ).toThrow("password");
  });
});

describe("subscription JSON store contract", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./subs.svelte.ts", import.meta.url)),
    "utf8",
  );

  it("persists JSON source and local edit state", () => {
    expect(source).toContain("sourceJson: string | null;");
    expect(source).toContain("jsonEdited: boolean;");
    expect(source).toContain("sourceJson: result.source_json");
    expect(source).toContain("srv.raw.source_json === undefined");
    expect(source).toContain("srv.raw.raw_outbound === undefined");
  });

  it("supports validated JSON edits and protects them from auto-refresh", () => {
    expect(source).toContain("async updateJson(");
    expect(source).toContain("if (s.jsonEdited) return false;");
  });

  it("rehydrates old cached JSON locations without downloading the URL", () => {
    expect(source).toContain("parseSubscriptionBody(sub.sourceJson)");
    expect(source).toContain("void this.rehydratePersistedJson()");
  });
});
