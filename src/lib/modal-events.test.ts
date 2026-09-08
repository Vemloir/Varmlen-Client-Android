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

  it("resolves an icon button clicked on its own svg", () => {
    // The ✕ of a modal is an <svg> inside a <button data-modal-action="close">.
    // An SVGElement is not an HTMLElement, and treating that as "no target" made
    // the close button look broken.
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.dataset.modalAction = "close";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.append(path);
    button.append(svg);
    root.append(button);

    expect(modalActionFromTarget(svg, root)).toBe("close");
    expect(modalActionFromTarget(path, root)).toBe("close");
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
