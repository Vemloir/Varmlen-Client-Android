// @vitest-environment happy-dom

/** The location menu on Android: it answers a LONG press, and a press that turns
 *  into a scroll or a quick lift must not open anything. Menu items are the same
 *  set the desktop menu shows — hide for a subscription location, a real delete
 *  for a location of a manually added configuration. */

import { fireEvent, render, within } from "@testing-library/svelte";
import { cleanup } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const raw = (label: string) => ({
    id: `raw-${label}`,
    protocol: "vless",
    uuid: "00000000-0000-0000-0000-000000000001",
    password: null,
    method: null,
    host: "example.com",
    port: 443,
    label,
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
  });
  const subServer = {
    id: "server-sub",
    flag: "🇪🇪",
    name: "Tallinn",
    transport: "VLESS / TCP",
    raw: raw("Tallinn"),
    editDraft: null,
  };
  const manualServer = {
    id: "server-manual",
    flag: "🇩🇪",
    name: "Berliner",
    transport: "VLESS / TCP",
    raw: raw("Berliner"),
    editDraft: null,
  };
  const card = (id: string, name: string, url: string, servers: unknown[]) => ({
    id,
    name,
    description: null,
    url,
    importedAt: "2026-01-01T00:00:00.000Z",
    updateIntervalHours: null,
    usedBytes: 0,
    totalBytes: 0,
    expiresAtUnix: null,
    supportUrl: null,
    webPageUrl: null,
    sourceJson: null,
    jsonEdited: false,
    servers,
    collapsed: false,
    pinned: false,
  });
  const subscription = card("sub-1", "Proxen", "https://sub.example/x", [
    subServer,
  ]);
  const configuration = card("cfg-1", "Configuration", "vless://x", [
    manualServer,
  ]);
  return {
    subscription,
    configuration,
    subServer,
    manualServer,
    isManualCard: (sub: { url: string }) => !/^https?:\/\//i.test(sub.url),
  };
});

const subsSpies = vi.hoisted(() => ({
  toggleHideLocation: vi.fn(),
  togglePinLocation: vi.fn(),
  deleteLocation: vi.fn(),
  pingServer: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ onBackButtonPress: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("$lib/platform", () => ({ isAndroid: true }));
vi.mock("$lib/modal-lifecycle", () => ({ releaseActiveControl: vi.fn() }));
vi.mock("$lib/popup", () => ({
  placePopup: vi.fn(() => ({ top: 0, right: 0 })),
  placeAtPoint: vi.fn(() => ({ top: 0, left: 0 })),
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
vi.mock("$lib/i18n.svelte", () => ({ t: (key: string) => key }));
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
    wireGuardDomainStrategies: [],
  }),
}));
vi.mock("$lib/subs.svelte", () => ({
  subs: {
    list: [fixtures.subscription, fixtures.configuration],
    ordered: [fixtures.subscription, fixtures.configuration],
    selectedServerId: null,
    selectionLost: false,
    pings: {},
    importing: false,
    hasTraffic: vi.fn(() => false),
    expiresText: vi.fn(() => null),
    trafficText: vi.fn(() => ""),
    isSubPinging: vi.fn(() => false),
    isManualCard: vi.fn(fixtures.isManualCard),
    visibleLocations: vi.fn((sub: { servers: unknown[] }) => sub.servers),
    hiddenLocationIds: vi.fn(() => []),
    locationPinnedIds: vi.fn(() => []),
    hiddenCount: vi.fn(() => 0),
    locationActionsFor: vi.fn((sub: { url: string }) =>
      fixtures.isManualCard(sub)
        ? ["ping", "rename", "pin", "delete"]
        : ["ping", "rename", "pin", "hide"],
    ),
    toggleHideLocation: subsSpies.toggleHideLocation,
    togglePinLocation: subsSpies.togglePinLocation,
    deleteLocation: subsSpies.deleteLocation,
    pingServer: subsSpies.pingServer,
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
import { subs } from "$lib/subs.svelte";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const cardOf = (title: HTMLElement): HTMLElement => {
  const card = title.closest("section");
  expect(card).not.toBeNull();
  return card as HTMLElement;
};

const rowOf = (card: HTMLElement, name: string): HTMLElement =>
  within(card).getByText(name).closest("button") as HTMLElement;

/** Finger down, hold past the long-press delay, finger up. */
async function longPress(row: HTMLElement): Promise<void> {
  vi.useFakeTimers();
  fireEvent.pointerDown(row, {
    pointerType: "touch",
    clientX: 120,
    clientY: 300,
  });
  vi.advanceTimersByTime(600);
  vi.useRealTimers();
  fireEvent.pointerUp(row, { pointerType: "touch", clientX: 120, clientY: 300 });
  await Promise.resolve();
}

describe("card header", () => {
  it("keeps refresh and the ⋮ menu on a real subscription", () => {
    const view = render(Page);
    const card = cardOf(view.getByText("Proxen") as HTMLElement);
    expect(within(card).getByLabelText("Refresh")).toBeTruthy();
    expect(within(card).getByLabelText("Subscription menu")).toBeTruthy();
  });

  it("gives a manually added configuration neither refresh nor ⋮", () => {
    const view = render(Page);
    const card = cardOf(view.getByText("Configuration") as HTMLElement);
    // Nothing fetches it, so a refresh would be a lie, and its locations are
    // deleted from the row menu instead.
    expect(within(card).queryByLabelText("Refresh")).toBeNull();
    expect(within(card).queryByLabelText("Subscription menu")).toBeNull();
    expect(within(card).getByLabelText("Ping")).toBeTruthy();
  });
});

describe("location menu (Android long press)", () => {
  it("opens on a long press and hides a subscription location", async () => {
    const view = render(Page);
    const card = cardOf(view.getByText("Proxen") as HTMLElement);
    await longPress(rowOf(card, "Tallinn"));

    const hide = view.queryByText("menu.hide");
    expect(hide).toBeTruthy();
    expect(view.queryByText("menu.deleteLocation")).toBeNull();
    await fireEvent.click(hide as HTMLElement);
    expect(subsSpies.toggleHideLocation).toHaveBeenCalledWith(
      "sub-1",
      fixtures.subServer,
    );
  });

  it("opens nothing for a lift before the delay", async () => {
    const view = render(Page);
    const card = cardOf(view.getByText("Proxen") as HTMLElement);
    const row = rowOf(card, "Tallinn");
    vi.useFakeTimers();
    fireEvent.pointerDown(row, {
      pointerType: "touch",
      clientX: 120,
      clientY: 300,
    });
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 120, clientY: 300 });
    await fireEvent.click(row);

    expect(view.queryByText("menu.hide")).toBeNull();
    // and the press was not swallowed either: it was a plain tap on the location
    expect(subs.selectServer).toHaveBeenCalledWith("server-sub");
  });

  it("opens nothing when the same press scrolled the list", async () => {
    const view = render(Page);
    const card = cardOf(view.getByText("Proxen") as HTMLElement);
    const row = rowOf(card, "Tallinn");
    vi.useFakeTimers();
    fireEvent.pointerDown(row, {
      pointerType: "touch",
      clientX: 120,
      clientY: 300,
    });
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 120, clientY: 300 });

    expect(view.queryByText("menu.hide")).toBeNull();
  });

  it("offers a real delete, never hide, for a manual location", async () => {
    const view = render(Page);
    const card = cardOf(view.getByText("Configuration") as HTMLElement);
    await longPress(rowOf(card, "Berliner"));

    expect(view.queryByText("menu.hide")).toBeNull();
    const del = view.queryByText("menu.deleteLocation");
    expect(del).toBeTruthy();
    await fireEvent.click(del as HTMLElement);
    expect(subsSpies.deleteLocation).toHaveBeenCalledWith(
      "cfg-1",
      "server-manual",
    );
  });

  it("keeps a single menu open across cards", async () => {
    const view = render(Page);
    const a = cardOf(view.getByText("Proxen") as HTMLElement);
    const b = cardOf(view.getByText("Configuration") as HTMLElement);
    await longPress(rowOf(a, "Tallinn"));
    expect(view.getAllByRole("menu")).toHaveLength(1);
    await longPress(rowOf(b, "Berliner"));

    expect(view.getAllByRole("menu")).toHaveLength(1);
    // The second request wins: it is the location the user just held.
    expect(view.queryByText("menu.deleteLocation")).toBeTruthy();
    expect(view.queryByText("menu.hide")).toBeNull();
  });

  it("marks a pinned location, like a pinned card does", () => {
    vi.mocked(subs.locationPinnedIds).mockReturnValueOnce(["server-sub"]);
    const view = render(Page);
    const card = cardOf(view.getByText("Proxen") as HTMLElement);
    expect(card.querySelector(".pin-mark")).not.toBeNull();
  });

  it("pings a single location from the menu", async () => {
    const view = render(Page);
    const card = cardOf(view.getByText("Proxen") as HTMLElement);
    await longPress(rowOf(card, "Tallinn"));
    await fireEvent.click(view.getByText("menu.ping") as HTMLElement);

    expect(subsSpies.pingServer).toHaveBeenCalledWith(fixtures.subServer);
  });
});