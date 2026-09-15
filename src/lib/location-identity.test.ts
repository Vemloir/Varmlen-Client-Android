import { describe, expect, it } from "vitest";
import { locationKey, migrateLocationKeys } from "./location-identity";

/** A provider that puts its balancer in front of the same servers produces rows
 *  that share every endpoint field and differ only by label — AegisVPN's
 *  «Автовыбор» and «Finland | Helsinki». */
const row = (id: string, name: string, host = "fi1.example.com") => ({
  id,
  name,
  raw: {
    protocol: "vless",
    host,
    port: 443,
    uuid: "7aad7a35-bd15-4351-9cd7-c903a6028e1d",
    transport: "tcp",
    security: "reality",
    sni: "example.com",
  },
});

describe("locationKey", () => {
  it("tells two rows on one endpoint apart", () => {
    const auto = row("a", "🇪🇺 Автовыбор");
    const helsinki = row("b", "🇫🇮 Finland | Helsinki");
    expect(locationKey(auto)).not.toBe(locationKey(helsinki));
  });

  it("survives a refresh, which regenerates the entry id", () => {
    expect(locationKey(row("old-id", "🇫🇮 Finland"))).toBe(
      locationKey(row("new-id", "Finland")),
    );
  });

  it("ignores the flag emoji and case, like the label comparison does", () => {
    expect(locationKey(row("a", "🇩🇪 Berlin"))).toBe(
      locationKey(row("b", "BERLIN")),
    );
  });
});

describe("migrateLocationKeys", () => {
  it("rewrites an endpoint key when only one row can have been meant", () => {
    const berlin = row("1", "🇩🇪 Berlin", "de1.example.com");
    const sub = migrateLocationKeys({
      servers: [berlin],
      hiddenKeys: [
        // written by an older build: the endpoint, no label
        ["vless", "de1.example.com", "443", "7aad7a35-bd15-4351-9cd7-c903a6028e1d", "", "", "tcp", "reality", "example.com", "", "", "", ""].join(
          "\u0000",
        ),
      ],
      pinnedLocations: {},
    });
    expect(sub.hiddenKeys).toEqual([locationKey(berlin)]);
  });

  it("drops an endpoint key that several rows share, instead of hiding a wrong bunch", () => {
    const sub = migrateLocationKeys({
      servers: [row("1", "🇪🇺 Автовыбор"), row("2", "🇫🇮 Finland | Helsinki")],
      hiddenKeys: ["some-legacy-endpoint-key"],
      pinnedLocations: { "some-legacy-endpoint-key": 1700000000000 },
    });
    expect(sub.hiddenKeys).toEqual([]);
    expect(sub.pinnedLocations).toEqual({});
  });

  it("leaves row keys alone", () => {
    const helsinki = row("2", "🇫🇮 Finland | Helsinki");
    const sub = migrateLocationKeys({
      servers: [row("1", "🇪🇺 Автовыбор"), helsinki],
      hiddenKeys: [locationKey(helsinki)],
      pinnedLocations: { [locationKey(helsinki)]: 1700000000000 },
    });
    expect(sub.hiddenKeys).toEqual([locationKey(helsinki)]);
    expect(sub.pinnedLocations).toEqual({ [locationKey(helsinki)]: 1700000000000 });
  });
})
  it("hides only the row the user hid, not every row on that endpoint", () => {
    const auto = row("1", "🇪🇺 Автовыбор");
    const helsinki = row("2", "🇫🇮 Finland | Helsinki");
    // what `toggleHideLocation` stores for the row the menu was opened on
    const hiddenKeys = [locationKey(helsinki)];
    const visible = [auto, helsinki].filter(
      (srv) => !hiddenKeys.includes(locationKey(srv)),
    );
    expect(visible.map((srv) => srv.name)).toEqual(["🇪🇺 Автовыбор"]);
  });
