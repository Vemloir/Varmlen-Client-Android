import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/**
 * Two interfaces in one file, because both were found by the same thing: the
 * home screen reporting the state of the tunnel. The pill is the only place that
 * says whether traffic is moving; the latency label used to be a strip in the
 * middle of every location row that answered no click at all.
 */
describe("home: session pill under the power button", () => {
  const home = read("./+page.svelte");
  const i18n = read("../lib/i18n.svelte.ts");
  const conn = read("../lib/conn.svelte.ts");
  const start = home.indexOf('class="session-pill"');
  const pill = home.slice(start, home.indexOf("</div>", home.indexOf("formatRate(conn.sessionDown)")));
  const css = home.slice(home.indexOf("<style>"));

  it("shows upstream, connected-for and downstream, in that order", () => {
    const up = pill.indexOf("session.upload");
    const duration = pill.indexOf("connectedFor");
    const down = pill.indexOf("session.download");
    expect(up).toBeGreaterThan(-1);
    expect(duration).toBeGreaterThan(up);
    expect(down).toBeGreaterThan(duration);
    expect(pill.match(/class="session-part"/g)).toHaveLength(3);
    expect(pill.match(/class="session-sep"/g)).toHaveLength(2);
  });

  it("shows throughput, not the sum of the session", () => {
    expect(pill).toMatch(/formatRate\(conn\.sessionUp\)/);
    expect(pill).toMatch(/formatRate\(conn\.sessionDown\)/);
    expect(pill).not.toMatch(/formatBytes\(conn\./);
  });

  it("stays on screen when the tunnel is down, in grey", () => {
    // No {#if}: "not connected" is a state the pill reports, not an absence, so
    // the hero does not breathe when the tunnel changes. Fading the plate out
    // instead left its rounded ends painted behind.
    expect(home.slice(0, start).match(/\{#if[^}]*session-pill/)).toBe(null);
    expect(home).toMatch(/class:idle=\{conn\.status !== "connected"\}/);
    expect(css).toMatch(/\.session-pill\s*\{[^}]*color:\s*var\(--text\);/s);
    expect(css).toMatch(/\.session-pill\.idle\s*\{[^}]*color:\s*var\(--text-muted\);/s);
    expect(css).not.toMatch(/\.session-pill\s*\{[^}]*opacity:/s);
  });

  it("runs its separators the full height of the plate", () => {
    expect(css).toMatch(/\.session-pill\s*\{[^}]*align-items:\s*stretch;/s);
    // No height on the separator: it stretches, so it reaches both edges.
    expect(css.slice(css.indexOf(".session-sep"))).toMatch(/^\.session-sep\s*\{(?![^}]*height:)/s);
  });

  it("is the same idiom as the tab bar: raised plate, page showing through", () => {
    expect(css).toMatch(/\.session-pill\s*\{[^}]*background:\s*var\(--bg-elev\);/s);
    expect(css).toMatch(/\.session-sep\s*\{[^}]*width:\s*2px;[^}]*background:\s*var\(--bg\);/s);
  });

  it("has every duration unit in both languages", () => {
    for (const key of [
      "session.upload",
      "session.download",
      "session.duration",
      "session.seconds",
      "session.minutes",
      "session.hours",
      "session.days",
    ]) {
      expect(i18n.split(`"${key}"`).length - 1).toBe(2);
    }
    expect(home).toMatch(
      /\{\s*s: "session\.seconds",\s*min: "session\.minutes",\s*h: "session\.hours",\s*d: "session\.days",\s*\} as const/,
    );
  });

  it("measures the tunnel in the store and forgets it on disconnect", () => {
    // Nullable here: on a phone the interface belongs to VpnService and whether an
    // unprivileged app may read its sysfs counters is the device's policy. Zero is
    // what a meter reads when nothing moved; null is nobody being allowed to look,
    // and the pill renders them differently.
    expect(conn).toMatch(/sessionUp = \$state<number \| null>\(0\)/);
    expect(conn).toMatch(/sessionDown = \$state<number \| null>\(0\)/);
    expect(conn).toMatch(/sessionSeconds = \$state\(0\)/);
    expect(conn).toMatch(/stats = await tunnelStats\(\)/);
    // The age comes from the device when sysfs will say, so a restart of the
    // window does not turn a two-day tunnel into "12 s".
    expect(conn).toMatch(/const since = stats\.since_unix \?\?/);
    // Both places that end the tunnel close the session.
    expect(conn.match(/this\.closeSession\(\)/g)).toHaveLength(2);
  });
});

describe("location rows: no dead strip where the latency is shown", () => {
  const rows = read("../lib/components/ServerList.svelte");

  it("keeps the latency inside the row button", () => {
    const button = rows.indexOf('<button\n        class="srv-btn"');
    const closing = rows.indexOf("</button>", button);
    const ping = rows.indexOf('class="srv-ping"', button);
    expect(button).toBeGreaterThan(-1);
    expect(ping).toBeGreaterThan(button);
    expect(ping).toBeLessThan(closing);
    // It used to be a sibling of the button: 44px of row that took a click, a
    // long press and a right-click and did nothing with any of them.
    expect(rows.indexOf('class="srv-ping"')).toBe(ping);
  });
});