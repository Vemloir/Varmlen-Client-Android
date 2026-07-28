// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { modalActionFromTarget } from "./modal-events";

describe("permanent modal event boundary", () => {
  it("resolves action nodes added after the boundary was mounted", () => {
    const root = document.createElement("div");
    const first = document.createElement("button");
    first.dataset.modalAction = "close";
    root.append(first);
    expect(modalActionFromTarget(first, root)).toBe("close");
    first.remove();

    const replacement = document.createElement("button");
    replacement.dataset.modalAction = "save-location";
    root.append(replacement);
    expect(modalActionFromTarget(replacement, root)).toBe("save-location");
  });

  it("does not treat clicks inside a modal surface as backdrop actions", () => {
    const root = document.createElement("div");
    const backdrop = document.createElement("div");
    backdrop.dataset.modalAction = "close";
    const surface = document.createElement("div");
    surface.dataset.modalSurface = "";
    const content = document.createElement("span");
    surface.append(content);
    backdrop.append(surface);
    root.append(backdrop);

    expect(modalActionFromTarget(content, root)).toBeNull();
  });
});
