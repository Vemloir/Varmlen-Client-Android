import { describe, expect, it } from "vitest";
import { includeCurrentOption } from "./location-editor-options";

describe("location editor option handling", () => {
  it("preserves a provider value that a newer core may add", () => {
    expect(
      includeCurrentOption(
        [{ value: "tcp", label: "RAW / TCP" }],
        "future-transport",
      ),
    ).toEqual([
      { value: "tcp", label: "RAW / TCP" },
      { value: "future-transport", label: "future-transport" },
    ]);
  });

  it("does not duplicate an option already supplied by the backend", () => {
    const options = [{ value: "tls", label: "TLS" }];
    expect(includeCurrentOption(options, "tls")).toBe(options);
  });

  it("does not turn an empty optional value into a blank menu row", () => {
    const options = [{ value: "", label: "None" }];
    expect(includeCurrentOption(options, "")).toBe(options);
  });
});
