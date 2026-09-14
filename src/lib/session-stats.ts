/**
 * Number formatting and session arithmetic for the pill under the power button.
 *
 * Pure on purpose: the thresholds below are the whole behaviour of that pill,
 * and they are the kind of thing that reads fine while you type it and looks
 * wrong at 09:00 with 59 seconds on the clock.
 */

export interface SessionCounters {
  /** Bytes sent. */
  up: number;
  /** Bytes received. */
  down: number;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** A byte count as the shortest string that still says how big it is. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal only while it still buys information: "1.5 GB" yes,
  // "977.4 MB" no, that is just 977 MB read slowly.
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${BYTE_UNITS[unit]}`;
}

/** Throughput, in the shape the pill wants: "1.5 MB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export type DurationUnit = "s" | "min" | "h" | "d";

/**
 * Session length in the one unit that fits it: seconds until a minute, minutes
 * until an hour, hours until a day, days from there. Never a compound "1 h 5
 * min" -- the pill is three characters wide, not a timetable.
 */
export function sessionDuration(seconds: number): { value: number; unit: DurationUnit } {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (total < 60) return { value: total, unit: "s" };
  if (total < 3600) return { value: Math.floor(total / 60), unit: "min" };
  if (total < 86400) return { value: Math.floor(total / 3600), unit: "h" };
  return { value: Math.floor(total / 86400), unit: "d" };
}

/**
 * Turns raw interface counters into bytes per second.
 *
 * The rate is measured between two samples rather than assumed to be one
 * second: the tick is async, and a tick that came back after 1.6 s of a busy
 * main thread would otherwise report 60% too much.
 */
export class SessionThroughput {
  private last: (SessionCounters & { at: number }) | null = null;

  reset(): void {
    this.last = null;
  }

  sample(now: SessionCounters, atMs: number): SessionCounters {
    const previous = this.last;
    this.last = { at: atMs, up: now.up, down: now.down };
    if (previous === null) return { up: 0, down: 0 };
    const seconds = (atMs - previous.at) / 1000;
    if (seconds <= 0) return { up: 0, down: 0 };
    // A device recreated underneath us restarts its counters, which would read
    // as a negative rate. A quiet second is the honest answer for that tick.
    const up = now.up >= previous.up ? now.up - previous.up : 0;
    const down = now.down >= previous.down ? now.down - previous.down : 0;
    return { up: up / seconds, down: down / seconds };
  }
}