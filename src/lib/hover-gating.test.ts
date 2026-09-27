import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A touch screen keeps :hover on the last element the finger lifted from, so a row or
 * a button stayed coloured until something else was touched -- in Settings, in the
 * app picker, everywhere a rule said :hover. Every hover rule therefore lives under
 * `@media (hover: hover)`; a touch screen gets the same look under `(hover: none)`
 * from :active, for exactly as long as the finger is down.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** A rule that only keeps a control from reacting to hover is harmless when it sticks. */
const ALLOWED = ["button.unavailable:hover"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(svelte|css)$/.test(name) ? [path] : [];
  });
}

function styles(path: string): string {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".css")) return text;
  const match = text.match(/<style[^>]*>([\s\S]*)<\/style>/);
  return match ? match[1] : "";
}

/** Selectors with :hover that no enclosing block gates on the kind of pointer. */
function ungatedHover(css: string): string[] {
  const found: string[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith("/*", i)) {
      i = css.indexOf("*/", i) + 1;
      start = i + 1;
      continue;
    }
    const c = css[i];
    if (c === "{") {
      const prelude = css.slice(start, i).trim();
      const gated = stack.some((p) => /hover:\s*(hover|none)/.test(p));
      if (prelude.includes(":hover") && !prelude.startsWith("@") && !gated) found.push(prelude);
      stack.push(prelude);
      start = i + 1;
    } else if (c === "}") {
      stack.pop();
      start = i + 1;
    } else if (c === ";") {
      start = i + 1;
    }
  }
  return found.filter((prelude) => !ALLOWED.some((allowed) => prelude.includes(allowed)));
}

describe("hover never sticks on a touch screen", () => {
  it("gates every :hover rule on a pointer that can hover", () => {
    const offenders = files(SRC)
      .filter((path) => !path.includes(".test."))
      .flatMap((path) => ungatedHover(styles(path)).map((sel) => `${path}: ${sel}`));
    expect(offenders).toEqual([]);
  });

  it("gives a touch screen the same look while the finger is down", () => {
    const settings = styles(join(SRC, "routes/settings/+page.svelte"));
    expect(settings).toMatch(/@media \(hover: none\) \{\s*\.row:active \{/);
    const split = styles(join(SRC, "routes/split/+page.svelte"));
    expect(split).toMatch(/@media \(hover: none\) \{\s*\.picker-row:active:not\(:disabled\):not\(\.selected\) \{/);
  });
});
