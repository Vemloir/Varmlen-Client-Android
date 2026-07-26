import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatJson, isJsonInput, isRemoteSource } from "./subscription-json";

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
  });

  it("supports validated JSON edits and protects them from auto-refresh", () => {
    expect(source).toContain("async updateJson(");
    expect(source).toContain("if (s.jsonEdited) return false;");
  });
});
