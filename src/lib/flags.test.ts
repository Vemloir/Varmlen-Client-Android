import { describe, expect, it } from "vitest";
import { countryCodeFromFlag } from "./flags";

describe("countryCodeFromFlag", () => {
  it("converts regional indicator flags to lowercase ISO codes", () => {
    expect(countryCodeFromFlag("🇩🇪")).toBe("de");
    expect(countryCodeFromFlag("🇺🇸")).toBe("us");
  });

  it("rejects non-country symbols", () => {
    expect(countryCodeFromFlag("📶")).toBeNull();
    expect(countryCodeFromFlag("")).toBeNull();
  });
});
