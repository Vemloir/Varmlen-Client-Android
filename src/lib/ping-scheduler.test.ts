import { describe, expect, it } from "vitest";
import { pingWorkerLimit } from "./ping-scheduler";

describe("ping scheduler", () => {
  it("limits composite proxy probes to two Xray processes at a time", () => {
    expect(pingWorkerLimit("proxy")).toBe(2);
    expect(pingWorkerLimit("tcp")).toBe(32);
  });
});
