import { describe, expect, it } from "vitest";

import {
  SessionThroughput,
  formatBytes,
  formatRate,
  sessionDuration,
} from "./session-stats";

/**
 * The pill under the power button is three numbers and nothing else, so the
 * thresholds ARE the interface: what "41 s" turns into next, how a byte count is
 * spoken, and what a throughput tick reports when the sample took longer than a
 * second or the device was recreated underneath us.
 */
describe("session pill numbers", () => {
  it("says a byte count in the one unit that fits it", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(999 * 1024)).toBe("999 KB");
    expect(formatBytes(1024 ** 2)).toBe("1 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    // Above 100 the decimal is noise: 977.4 MB is 977 MB read slowly.
    expect(formatBytes(977.4 * 1024 ** 2)).toBe("977 MB");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("says a rate as that byte count with a per-second tail", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(2 * 1024)).toBe("2 KB/s");
    expect(formatRate(1.5 * 1024 ** 2)).toBe("1.5 MB/s");
  });

  it("grows seconds into minutes, hours and days", () => {
    expect(sessionDuration(0)).toEqual({ value: 0, unit: "s" });
    expect(sessionDuration(59.9)).toEqual({ value: 59, unit: "s" });
    expect(sessionDuration(60)).toEqual({ value: 1, unit: "min" });
    expect(sessionDuration(3599)).toEqual({ value: 59, unit: "min" });
    expect(sessionDuration(3600)).toEqual({ value: 1, unit: "h" });
    expect(sessionDuration(86399)).toEqual({ value: 23, unit: "h" });
    expect(sessionDuration(86400)).toEqual({ value: 1, unit: "d" });
    expect(sessionDuration(7 * 86400 + 3600)).toEqual({ value: 7, unit: "d" });
    expect(sessionDuration(-1)).toEqual({ value: 0, unit: "s" });
    expect(sessionDuration(Number.NaN)).toEqual({ value: 0, unit: "s" });
  });
});

describe("throughput between two samples", () => {
  it("divides by the time that actually passed", () => {
    const rate = new SessionThroughput();
    // The first tick has nothing to compare with. A number here would be a
    // guess about traffic that happened before we were looking.
    expect(rate.sample({ up: 1000, down: 4000 }, 1_000)).toEqual({ up: 0, down: 0 });
    // Exactly one second later: the deltas are the rate.
    expect(rate.sample({ up: 3024, down: 8000 }, 2_000)).toEqual({
      up: 2024,
      down: 4000,
    });
    // A tick that came back late is not a second: 4048 bytes over 2 s is 2024
    // per second, and reporting 4048 would blame the network for a busy thread.
    expect(rate.sample({ up: 7072, down: 8000 }, 4_000)).toEqual({
      up: 2024,
      down: 0,
    });
  });

  it("reports a quiet second when the device restarts underneath it", () => {
    const rate = new SessionThroughput();
    rate.sample({ up: 5000, down: 5000 }, 1_000);
    // A fresh interface counts from zero again. The subtraction would be
    // negative, and a negative speed is not a thing.
    expect(rate.sample({ up: 10, down: 20 }, 2_000)).toEqual({ up: 0, down: 0 });
    // And the next tick measures from the new device, not from the old one.
    expect(rate.sample({ up: 110, down: 20 }, 3_000)).toEqual({ up: 100, down: 0 });
  });

  it("starts over after a reset, so a reconnect shows no old traffic", () => {
    const rate = new SessionThroughput();
    rate.sample({ up: 100, down: 100 }, 1_000);
    rate.reset();
    expect(rate.sample({ up: 900, down: 900 }, 2_000)).toEqual({ up: 0, down: 0 });
    expect(rate.sample({ up: 1900, down: 900 }, 3_000)).toEqual({ up: 1000, down: 0 });
  });
});