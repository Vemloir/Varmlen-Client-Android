// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/api", () => ({ setLongPressHaptics: vi.fn(() => Promise.resolve()) }));

import { isCopyable } from "./long-press-haptics";

describe("the long-press buzz", () => {
  it("is allowed over text that can be copied", () => {
    document.body.innerHTML = `
      <input id="field" type="text"><textarea id="json"></textarea>
      <pre class="selectable"><span id="log">log line</span></pre>`;
    for (const id of ["field", "json", "log"]) {
      expect(isCopyable(document.getElementById(id))).toBe(true);
    }
  });

  it("is not allowed over controls, rows and empty space", () => {
    document.body.innerHTML = `
      <input id="toggle" type="checkbox"><button id="row"><span id="label">Finland</span></button>
      <div id="space"></div>`;
    for (const id of ["toggle", "row", "label", "space"]) {
      expect(isCopyable(document.getElementById(id))).toBe(false);
    }
    expect(isCopyable(null)).toBe(false);
  });
});
