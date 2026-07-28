// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { releaseActiveControl } from "./modal-lifecycle";

afterEach(() => {
  document.body.replaceChildren();
});

describe("modal lifecycle", () => {
  it("ends an active textarea session before modal content is replaced", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    releaseActiveControl();

    expect(document.activeElement).not.toBe(textarea);
  });

  it("is safe when no form control owns focus", () => {
    expect(() => releaseActiveControl()).not.toThrow();
  });
});
