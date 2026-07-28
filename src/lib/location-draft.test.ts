import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { VlessServer } from "./api";
import {
  compileFieldDraft,
  createLocationDraft,
  type FieldLocationDraft,
} from "./location-draft";

const base: VlessServer = {
  id: "server-id",
  protocol: "vless",
  uuid: "user-id",
  password: null,
  method: null,
  host: "vpn.example",
  port: 443,
  label: "Example",
  transport: "tcp",
  security: "reality",
  sni: "cdn.example",
  fingerprint: "chrome",
  public_key: "public",
  short_id: "abcd",
  flow: "xtls-rprx-vision",
  path: null,
  mode: null,
  packet_encoding: "xudp",
  raw_params: { alpn: "h2" },
  source_json: null,
  raw_outbound: null,
  raw_profile: null,
};

describe("location edit drafts", () => {
  it("creates structured fields for a share-link location", () => {
    const draft = createLocationDraft(base);
    expect(draft.kind).toBe("fields");
    if (draft.kind !== "fields") throw new Error("wrong draft kind");
    expect(draft.values.host).toBe("vpn.example");
    expect(draft.values.port).toBe("443");
    expect(draft.rawParams).toEqual([
      expect.objectContaining({ key: "alpn", value: "h2" }),
    ]);
  });

  it("keeps the exact source for a JSON location", () => {
    const source = '{ "outbounds": [] }';
    expect(createLocationDraft({ ...base, source_json: source })).toEqual({
      kind: "json",
      source,
    });
  });

  it("compiles valid fields without losing extra parameters", () => {
    const draft = createLocationDraft(base) as FieldLocationDraft;
    draft.values.host = "edited.example";
    draft.values.port = "8443";
    const result = compileFieldDraft(draft, base);
    expect(result).toEqual({
      ok: true,
      server: expect.objectContaining({
        host: "edited.example",
        port: 8443,
        raw_params: { alpn: "h2" },
      }),
    });
  });

  it("returns an error while preserving invalid field text", () => {
    const draft = createLocationDraft(base) as FieldLocationDraft;
    draft.values.port = "not-a-port";
    const result = compileFieldDraft(draft, base);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("port") });
    expect(draft.values.port).toBe("not-a-port");
  });
});

describe("provider refresh authority", () => {
  it("does not skip edited subscriptions and resets server drafts", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./subs.svelte.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("if (s.jsonEdited) return false");
    expect(source).toContain("editDraft: null");
  });
});
