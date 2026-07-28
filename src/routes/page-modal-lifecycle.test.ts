// @vitest-environment happy-dom

import { fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { cleanup } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const raw = {
    id: "raw",
    protocol: "vless",
    uuid: "00000000-0000-0000-0000-000000000001",
    password: null,
    method: null,
    host: "example.com",
    port: 443,
    label: "Estonia",
    transport: "tcp",
    security: "reality",
    sni: "example.com",
    fingerprint: "chrome",
    public_key: "key",
    short_id: "01",
    flow: null,
    path: null,
    mode: null,
    packet_encoding: null,
    raw_params: {},
    source_json: null,
    raw_outbound: null,
    raw_profile: null,
  };
  const servers = [
    {
      id: "00000000-0000-0000-0000-000000000011",
      flag: "🇪🇪",
      name: "JSON location",
      transport: "VLESS / TCP / JSON",
      raw: { ...raw, source_json: "{}" },
      editDraft: { kind: "json", source: "{}" },
    },
    {
      id: "00000000-0000-0000-0000-000000000012",
      flag: "🇩🇪",
      name: "Field location",
      transport: "VLESS / TCP",
      raw: { ...raw, id: "raw-fields", label: "Germany" },
      editDraft: null,
    },
  ];
  const subscription = {
    id: "00000000-0000-0000-0000-000000000021",
    name: "Test",
    description: null,
    url: "https://example.com/sub",
    importedAt: "2026-01-01T00:00:00.000Z",
    updateIntervalHours: null,
    usedBytes: 0,
    totalBytes: 0,
    expiresAtUnix: null,
    supportUrl: null,
    webPageUrl: null,
    sourceJson: "{}",
    jsonEdited: false,
    servers,
    collapsed: false,
    pinned: false,
  };
  return { servers, subscription };
});
const modalSpies = vi.hoisted(() => ({
  releaseActiveControl: vi.fn(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }),
}));

vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));
vi.mock("$lib/platform", () => ({ isAndroid: false }));
vi.mock("$lib/modal-lifecycle", () => modalSpies);
vi.mock("$lib/popup", () => ({
  placePopup: vi.fn(() => ({ top: 0, right: 0 })),
  portal: vi.fn(() => ({ destroy: vi.fn() })),
}));
vi.mock("$lib/conn.svelte", () => ({
  conn: {
    status: "disconnected",
    error: null,
    toggle: vi.fn(),
    clearDrop: vi.fn(),
  },
}));
vi.mock("$lib/i18n.svelte", () => ({
  t: (key: string) =>
    ({
      "common.cancel": "Cancel",
      "common.save": "Save",
      "common.close": "Close",
    })[key] ?? key,
}));
vi.mock("$lib/api", () => ({
  readClipboard: vi.fn(),
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
vi.mock("$lib/subs.svelte", () => ({
  subs: {
    list: [fixtures.subscription],
    ordered: [fixtures.subscription],
    selectedServerId: fixtures.servers[0].id,
    pings: {},
    importing: false,
    hasTraffic: vi.fn(() => false),
    expiresText: vi.fn(() => null),
    trafficText: vi.fn(() => ""),
    isSubPinging: vi.fn(() => false),
    toggleCollapse: vi.fn(),
    refresh: vi.fn(),
    pingSub: vi.fn(),
    selectServer: vi.fn(),
    togglePin: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    updateJson: vi.fn(),
    saveServerDraft: vi.fn(),
    importFromUrl: vi.fn(),
  },
}));

import Page from "./+page.svelte";

afterEach(cleanup);

describe("home modal controller", () => {
  it("closes a field editor after a JSON editor was focused and closed", async () => {
    const view = render(Page);
    const detailButtons = view.getAllByRole("button", {
      name: "Location details",
    });

    await fireEvent.click(detailButtons[0]);
    let dialog = view.getByRole("dialog", { name: "Location details" });
    const textarea = within(dialog).getByRole("textbox");
    textarea.focus();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "Location details" })).toBeNull(),
    );
    expect(document.activeElement).not.toBe(textarea);

    await fireEvent.click(detailButtons[1]);
    dialog = view.getByRole("dialog", { name: "Location details" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "Location details" })).toBeNull(),
    );
    expect(document.querySelectorAll(".modal-backdrop")).toHaveLength(0);
    expect(modalSpies.releaseActiveControl).toHaveBeenCalled();
  });
});
