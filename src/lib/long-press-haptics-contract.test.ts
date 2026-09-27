import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("the long-press buzz, wired", () => {
  it("matches what app.css leaves selectable", () => {
    const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
    expect(css).toMatch(/input,\s*textarea,\s*select,\s*\[contenteditable\],\s*\.selectable\s*\{\s*user-select: text;/);
  });

  it("starts off in the WebView and is switched on per touch", () => {
    const activity = readFileSync(
      new URL("../../src-tauri/gen/android/app/src/main/java/app/varmlen/client/MainActivity.kt", import.meta.url),
      "utf8",
    );
    expect(activity).toMatch(/webView\.isHapticFeedbackEnabled = false/);
    const layout = readFileSync(new URL("../routes/+layout.svelte", import.meta.url), "utf8");
    expect(layout).toMatch(/onMount\(\(\) => \(isAndroid \? watchLongPressHaptics\(\) : undefined\)\);/);
  });
});
