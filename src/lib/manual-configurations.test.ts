import { describe, expect, it } from "vitest";
import { mergeManualConfigurations } from "./manual-configurations";

const local = (id: string, servers: string[], sourceJson: string | null = null) => ({
  id,
  name: `Configuration ${id}`,
  url: `vless://${id}`,
  sourceJson,
  servers,
});

describe("mergeManualConfigurations", () => {
  it("merges legacy local cards and keeps remote subscriptions in place", () => {
    const remote = {
      id: "remote",
      name: "Proxen",
      url: "https://example.test/sub",
      sourceJson: null,
      servers: ["proxen"],
    };
    expect(mergeManualConfigurations([remote, local("1", ["a"]), local("2", ["b"])]))
      .toEqual([
        remote,
        {
          ...local("1", ["a"]),
          name: "Configurations",
          servers: ["a", "b"],
        },
      ]);
  });

  it("uses singular Configuration for one local logical location", () => {
    expect(mergeManualConfigurations([local("1", ["a"])])[0]).toMatchObject({
      name: "Configuration",
      servers: ["a"],
    });
  });

  it("does not invent JSON for URI-based entries", () => {
    expect(
      mergeManualConfigurations([
        local("1", ["a"], '{"remarks":"A"}'),
        local("2", ["b"]),
      ])[0].sourceJson,
    ).toBeNull();
  });
});
