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

  it("probes at the number the setting asked for", async () => {
    const started: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = runPingsInParallel(
      [1, 2, 3, 4, 5, 6],
      async (location) => {
        started.push(location);
        await gate;
      },
      2,
    );

    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    release();
    await pending;
    expect(started).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("treats 0 as no limit -- the choice the warning in Settings is about", async () => {
    const started: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = runPingsInParallel(
      [1, 2, 3, 4, 5, 6],
      async (location) => {
        started.push(location);
        await gate;
      },
      0,
    );

    await Promise.resolve();
    expect(started).toHaveLength(6);
    release();
    await pending;
  });
});
