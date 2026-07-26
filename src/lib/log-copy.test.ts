import { describe, expect, it } from "vitest";
import { copyDisplayedLog } from "./log-copy";

describe("copyDisplayedLog", () => {
  it("copies the exact displayed text", async () => {
    let written = "";
    const result = await copyDisplayedLog(
      "[1] first\n[2] second\n",
      async (text) => {
        written = text;
      },
    );

    expect(result).toBe("copied");
    expect(written).toBe("[1] first\n[2] second\n");
  });

  it("does not write an empty log", async () => {
    let writes = 0;
    const result = await copyDisplayedLog("", async () => {
      writes += 1;
    });

    expect(result).toBe("empty");
    expect(writes).toBe(0);
  });

  it("reports clipboard failure without changing the text", async () => {
    const text = "diagnostic";
    const result = await copyDisplayedLog(text, async () => {
      throw new Error("clipboard denied");
    });

    expect(result).toBe("failed");
    expect(text).toBe("diagnostic");
  });
});
