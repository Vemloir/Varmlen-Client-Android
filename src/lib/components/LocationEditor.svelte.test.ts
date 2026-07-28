// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/svelte";
import { cleanup } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import LocationEditor from "./LocationEditor.svelte";
import type { LocationEditDraft } from "$lib/location-draft";
import type { ServerEntry } from "$lib/subs.svelte";

vi.mock("$lib/api", () => ({
  getLocationEditorOptions: vi.fn().mockResolvedValue({
    protocols: [],
    transports: [],
    securities: [],
    fingerprints: [],
    flows: [],
    packetEncodings: [],
    shadowsocksMethods: [],
    xhttpModes: [],
    grpcModes: [],
    wireguardDomainStrategies: [],
  }),
}));

afterEach(cleanup);

function serverWith(draft: LocationEditDraft): ServerEntry {
  return {
    id: crypto.randomUUID(),
    flag: "🇪🇪",
    name: "Estonia",
    transport: "VLESS / TCP / JSON",
    raw: {} as ServerEntry["raw"],
    editDraft: draft,
  };
}

describe("Android location editor actions", () => {
  it("cancels after mounting a persisted reactive draft", async () => {
    const onCancel = vi.fn();
    const view = render(LocationEditor, {
      server: serverWith({ kind: "json", source: "{}" }),
      onSave: vi.fn(),
      onCancel,
    });
    const cancel = view.getByRole("button", { name: "Cancel" });

    await fireEvent.click(cancel);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("releases a JSON textarea before cancelling the editor", async () => {
    const onCancel = vi.fn();
    const view = render(LocationEditor, {
      server: serverWith({ kind: "json", source: "{}" }),
      onSave: vi.fn(),
      onCancel,
    });
    const textarea = view.getByRole("textbox");
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    await fireEvent.click(view.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).not.toBe(textarea);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("saves a reactive draft without a DataCloneError", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(LocationEditor, {
      server: serverWith({ kind: "json", source: "{}" }),
      onSave,
      onCancel: vi.fn(),
    });
    const save = view.getByRole("button", { name: "Save" });

    await fireEvent.click(save);

    expect(onSave).toHaveBeenCalledOnce();
  });
});
