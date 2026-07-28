import { describe, expect, it } from "vitest";
import { runPingsInParallel } from "./ping-scheduler";

describe("ping scheduler", () => {
  it("starts every location without waiting for an earlier location", async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const pending = runPingsInParallel([1, 2, 3, 4], async (location) => {
      started.push(location);
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    await Promise.resolve();
    expect(started).toEqual([1, 2, 3, 4]);

    for (const release of releases) release();
    await pending;
  });
});
