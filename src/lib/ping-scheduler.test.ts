import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_LOCATION_PINGS,
  runPingsInParallel,
} from "./ping-scheduler";

describe("ping scheduler", () => {
  it("keeps several probes parallel without flooding Android with Xray processes", async () => {
    const started: number[] = [];
    const locations = [1, 2, 3, 4, 5, 6];
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    const pending = runPingsInParallel(locations, async (location) => {
      started.push(location);
      if (location <= MAX_CONCURRENT_LOCATION_PINGS) await firstWave;
    });

    await Promise.resolve();
    expect(started).toEqual(locations.slice(0, MAX_CONCURRENT_LOCATION_PINGS));

    releaseFirstWave();
    await pending;
    expect(started).toEqual(locations);
  });
});
