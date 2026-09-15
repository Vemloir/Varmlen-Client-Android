import { describe, expect, it } from "vitest";
import {
  normalizeLocationLabel,
  resolveSelection,
  serverKey,
  type SelectableSubscription,
  type SelectionIdentity,
} from "./subscription-selection";

const server = (id: string, name: string, host: string, port = 443) => ({
  id,
  name,
  raw: {
    protocol: "vless",
    host,
    port,
    uuid: `uuid-${host}`,
    password: null,
    method: null,
  },
});

const subs = (...groups: SelectableSubscription[][]): SelectableSubscription[] =>
  groups.flat();

const sub = (id: string, servers: SelectableSubscription["servers"]): SelectableSubscription => ({
  id,
  servers,
});

const identity = (overrides: Partial<SelectionIdentity> = {}): SelectionIdentity => ({
  serverId: null,
  key: null,
  subId: null,
  label: null,
  ...overrides,
});

describe("subscription location selection", () => {
  it("keeps the chosen location when the provider rotates the profile's endpoint", () => {
    // Proxen ships «США» as one composite profile whose host is its first proxy
    // outbound; that host moves between refreshes while the location stays.
    const before = sub("proxen", [
      server("old-1", "🇺🇸 США", "oanql1.proxen.pdevinfra.com"),
    ]);
    const chosen = resolveSelection(subs([before]), {
      serverId: "old-1",
      key: serverKey(before.servers[0]),
      subId: "proxen",
      label: "🇺🇸 США",
    });

    const after = sub("proxen", [
      server("new-1", "🇺🇸 США", "osj91a.proxen.pdevinfra.com"),
    ]);
    const next = resolveSelection(subs([after]), chosen);

    expect(next).toEqual({
      serverId: "new-1",
      key: serverKey(after.servers[0]),
      subId: "proxen",
      label: "🇺🇸 США",
      lost: false,
    });
  });

  it("leaves nothing selected instead of jumping to the first location", () => {
    // The provider dropped «США» entirely; only other countries remain.
    const after = sub("proxen", [
      server("new-1", "🇳🇱 Нидерланды", "pa82n3.proxen.pdevinfra.com"),
      server("new-2", "🇩🇪 Германия", "ksakj2.proxen.pdevinfra.com"),
    ]);
    const lost = resolveSelection(subs([after]), {
      serverId: "gone",
      key: "vless\u0000deleted.proxen.pdevinfra.com\u0000443\u0000uuid-deleted\u0000\u0000",
      subId: "proxen",
      label: "🇺🇸 США",
    });

    // The deleted location's identity survives untouched so a later refresh that
    // brings it back restores the user's choice.
    expect(lost.serverId).toBeNull();
    expect(lost.lost).toBe(true);
    expect(lost.label).toBe("🇺🇸 США");
    expect(lost.subId).toBe("proxen");
    expect(lost.key).toContain("deleted.proxen.pdevinfra.com");
  });

  it("adopts the first location only when nothing was ever selected", () => {
    const after = sub("proxen", [
      server("new-1", "🇳🇱 Нидерланды", "pa82n3.proxen.pdevinfra.com"),
    ]);
    const fresh = resolveSelection(subs([after]), identity());

    expect(fresh.serverId).toBe("new-1");
    expect(fresh.lost).toBe(false);
  });

  it("keeps a renamed location by its endpoint", () => {
    const before = sub("proxen", [
      server("old-1", "🇺🇸 США", "oanql1.proxen.pdevinfra.com"),
    ]);
    const key = serverKey(before.servers[0]);
    const after = sub("proxen", [
      server("new-1", "🇺🇸 США-2", "oanql1.proxen.pdevinfra.com"),
    ]);
    const next = resolveSelection(subs([after]), {
      serverId: null,
      key,
      subId: "proxen",
      label: "🇺🇸 США",
    });

    expect(next.serverId).toBe("new-1");
    expect(next.label).toBe("🇺🇸 США-2");
    expect(next.lost).toBe(false);
  });

  it("prefers the same subscription when two advertise the same label", () => {
    const a = sub("sub-a", [server("a-1", "🇩🇪 Германия", "ksakj2.example.com")]);
    const b = sub("sub-b", [server("b-1", "🇩🇪 Германия", "ksakj2.example.com")]);
    const next = resolveSelection(subs([a, b]), {
      serverId: null,
      key: serverKey(b.servers[0]),
      subId: "sub-b",
      label: "🇩🇪 Германия",
    });

    expect(next.serverId).toBe("b-1");
    expect(next.subId).toBe("sub-b");
  });

  it("reports an empty subscription list without marking a loss", () => {
    expect(resolveSelection([], identity({ subId: "proxen", label: "🇺🇸 США" }))).toEqual(
      { serverId: null, key: null, subId: null, label: null, lost: false },
    );
  });

  it("compares labels ignoring flag, spacing and case", () => {
    expect(normalizeLocationLabel("🇺🇸 США")).toBe(normalizeLocationLabel(" сша "));
  });

  it("never moves the choice into another card when the endpoint rotated", () => {
    // The same old endpoint still lives in a second card (a pasted link, a
    // duplicated import). A global endpoint search would jump there.
    const home = sub("proxen", [server("p-1", "🇺🇸 США", "oanql1.example.com")]);
    const other = sub("paste", [server("m-1", "🇺🇸 США", "old.example.com")]);
    const next = resolveSelection(subs([home, other]), {
      serverId: "p-old",
      key: serverKey(server("x", "🇺🇸 США", "old.example.com")),
      subId: "proxen",
      label: "🇺🇸 США",
    });

    expect(next.serverId).toBe("p-1");
    expect(next.subId).toBe("proxen");
    expect(next.lost).toBe(false);
  });

  it("reports a loss instead of picking the same label in another card", () => {
    const home = sub("proxen", [server("p-1", "🇩🇪 Германия", "ksakj2.example.com")]);
    const other = sub("paste", [server("m-1", "🇺🇸 США", "oanql1.example.com")]);
    const next = resolveSelection(subs([home, other]), {
      serverId: "m-old",
      key: serverKey(server("x", "🇺🇸 США", "old.example.com")),
      subId: "proxen",
      label: "🇺🇸 США",
    });

    expect(next.serverId).toBeNull();
    expect(next.lost).toBe(true);
    // The identity survives, so a later update that brings it back re-picks it.
    expect(next.label).toBe("🇺🇸 США");
  });

  it("keeps the chosen location when every entry shares one endpoint", () => {
    // The AegisVPN shape: four locations and an "auto choice" profile in front of
    // the SAME endpoint, told apart by label only. A refresh regenerates the ids,
    // and matching the key by "first hit" landed the user on Автовыбор.
    const shared = sub("aegis", [
      server("auto", "⚡ Автовыбор", "same.example.com"),
      server("nl", "🇳🇱 Нидерланды", "same.example.com"),
      server("de", "🇩🇪 Германия", "same.example.com"),
    ]);
    const next = resolveSelection(subs([shared]), {
      serverId: "stale-id",
      key: serverKey(shared.servers[1]),
      subId: "aegis",
      label: "🇳🇱 Нидерланды",
    });

    expect(next.serverId).toBe("nl");
    expect(next.lost).toBe(false);
  });

  it("tells locations apart when only the transport differs", () => {
    const withPath = { ...server("a", "Первая", "one.example.com"), raw: {
      protocol: "vless", host: "one.example.com", port: 443,
      uuid: "uuid-one.example.com", password: null, method: null,
      transport: "ws", security: "tls", sni: "one.example.com", path: "/ws",
    }};
    const plain = { ...server("b", "Вторая", "one.example.com"), raw: {
      protocol: "vless", host: "one.example.com", port: 443,
      uuid: "uuid-one.example.com", password: null, method: null,
      transport: "tcp", security: "tls", sni: "one.example.com", path: null,
    }};
    expect(serverKey(withPath)).not.toBe(serverKey(plain));
  });

  it("re-finds the choice in another card once its own card is gone", () => {
    const other = sub("paste", [server("m-1", "🇺🇸 США", "oanql1.example.com")]);
    const next = resolveSelection(subs([other]), {
      serverId: "p-old",
      key: serverKey(other.servers[0]),
      subId: "proxen",
      label: "🇺🇸 США",
    });

    expect(next.serverId).toBe("m-1");
    expect(next.subId).toBe("paste");
  });
});
