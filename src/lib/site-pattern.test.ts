import { describe, expect, it } from "vitest";
import {
  isSitePattern,
  migrateSitePatterns,
  normalizeSitePattern,
  siteKindLabelKey,
  siteRuleKind,
} from "./site-pattern";

describe("normalizeSitePattern", () => {
  it("writes one meaning as one spelling", () => {
    expect(normalizeSitePattern("example.com")).toBe("example.com");
    // The legacy asterisk spelling means the same thing, so it is written away.
    expect(normalizeSitePattern("*.example.com")).toBe("example.com");
    // A dotted name that is a whole domain is a host, not a zone.
    expect(normalizeSitePattern(".google.com")).toBe("google.com");
    // Only a single-label zone keeps its leading dot.
    expect(normalizeSitePattern(".ru")).toBe(".ru");
    expect(normalizeSitePattern("ru")).toBe(".ru");
    expect(normalizeSitePattern("=google.com")).toBe("=google.com");
    expect(normalizeSitePattern("=*.google.com")).toBe("=google.com");
  });

  it("strips what a pasted URL carries around the host", () => {
    expect(normalizeSitePattern("https://example.com/vpn")).toBe("example.com");
    expect(normalizeSitePattern("http://www.example.com:8080/a?b=c#d")).toBe("www.example.com:8080");
    expect(normalizeSitePattern("  Example.COM.  ")).toBe("example.com");
    expect(normalizeSitePattern("user@example.com")).toBe("example.com");
  });

  it("returns an empty string for nothing", () => {
    expect(normalizeSitePattern("   ")).toBe("");
    expect(normalizeSitePattern(".")).toBe("");
  });
});

describe("isSitePattern", () => {
  it("accepts hosts, zones and explicit exact hosts", () => {
    for (const value of [
      "example.com",
      "*.example.com",
      ".ru",
      "ru",
      "=example.com",
      "sub.example.co.uk",
    ]) {
      expect(isSitePattern(value), value).toBe(true);
    }
  });

  it("rejects anything the router could not match", () => {
    for (const value of [
      "",
      "   ",
      "example",
      "=example",
      "example.c",
      "*.",
      "exa mple.com",
      "-bad.com",
      "a..b.com",
      ".",
    ]) {
      expect(isSitePattern(value), value).toBe(false);
    }
  });

  it("refuses a port instead of silently dropping it", () => {
    expect(isSitePattern("example.com:8080")).toBe(false);
  });
});

describe("siteRuleKind", () => {
  it("names the three meanings", () => {
    expect(siteRuleKind("google.com")).toBe("suffix");
    expect(siteRuleKind(".ru")).toBe("zone");
    expect(siteRuleKind("=google.com")).toBe("exact");
  });

  it("has a wording key for every meaning", () => {
    const keys = (["suffix", "zone", "exact"] as const).map((kind) => siteKindLabelKey(kind));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key.startsWith("split.")).toBe(true);
  });
});

describe("migrateSitePatterns", () => {
  it("rewrites the old spelling without changing what it means", () => {
    const { sites, changed } = migrateSitePatterns([
      { id: "a", pattern: "*.example.com" },
      { id: "b", pattern: ".ru" },
      { id: "c", pattern: "=exact.test" },
    ]);
    expect(sites.map((s) => s.pattern)).toEqual(["example.com", ".ru", "=exact.test"]);
    expect(changed).toBe(true);
  });

  it("reports no change when everything is already written the current way", () => {
    const { sites, changed } = migrateSitePatterns([{ id: "a", pattern: "example.com" }]);
    expect(sites[0].pattern).toBe("example.com");
    expect(changed).toBe(false);
  });

  it("leaves a pattern it cannot understand alone", () => {
    const { sites } = migrateSitePatterns([{ id: "a", pattern: "   " }]);
    expect(sites[0].pattern).toBe("   ");
  });
});