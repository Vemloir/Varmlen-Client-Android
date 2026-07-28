// @vitest-environment happy-dom

import { render } from "@testing-library/svelte";
import { cleanup } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import LocationEditor from "./LocationEditor.svelte";

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

describe("Android location editor content", () => {
  it("mounts a persisted reactive JSON draft", () => {
    const view = render(LocationEditor, {
      draft: { kind: "json", source: '{\n  "ok": true\n}' },
    });

    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      '{\n  "ok": true\n}',
    );
  });

  it("mounts a structured-fields draft", () => {
    const view = render(LocationEditor, {
      draft: {
        kind: "fields",
        values: {
          label: "Estonia",
          protocol: "vless",
          host: "example.com",
          port: "443",
          uuid: "00000000-0000-0000-0000-000000000001",
          password: "",
          method: "",
          transport: "tcp",
          security: "reality",
          sni: "example.com",
          fingerprint: "chrome",
          public_key: "key",
          short_id: "01",
          flow: "",
          path: "",
          mode: "",
          packet_encoding: "",
          local_address: "",
          pre_shared_key: "",
          reserved: "",
          mtu: "",
          domain_strategy: "",
        },
        rawParams: [],
      },
    });

    expect(view.getAllByDisplayValue("example.com")).toHaveLength(2);
  });
});
