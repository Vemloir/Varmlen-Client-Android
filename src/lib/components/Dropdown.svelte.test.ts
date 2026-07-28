// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Dropdown from "./Dropdown.svelte";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function rect({
  top,
  right,
  bottom,
  left,
  width,
  height,
}: Partial<DOMRect>): DOMRect {
  return {
    x: left ?? 0,
    y: top ?? 0,
    top: top ?? 0,
    right: right ?? 0,
    bottom: bottom ?? 0,
    left: left ?? 0,
    width: width ?? 0,
    height: height ?? 0,
    toJSON: () => ({}),
  };
}

describe("Dropdown placement", () => {
  it("uses the rendered panel height when opening above its trigger", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("trigger")) {
        return rect({
          top: 500,
          right: 360,
          bottom: 540,
          left: 60,
          width: 300,
          height: 40,
        });
      }
      if (this.classList.contains("panel")) {
        return rect({ width: 300, height: 54 });
      }
      return rect({});
    });
    const view = render(Dropdown, {
      value: "vless",
      options: [
        { value: "vless", label: "VLESS" },
        { value: "vmess", label: "VMess" },
      ],
      onChange: vi.fn(),
      field: true,
    });

    await fireEvent.click(view.getByRole("button", { name: "Select" }));
    const panel = view.getByRole("listbox");

    expect(panel.style.top).toBe("442px");
  });
});
