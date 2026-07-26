import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionOperationGate } from "./connection-operation";

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectionOperationGate", () => {
  it("does not run a scheduled reconnect after explicit disconnect", async () => {
    vi.useFakeTimers();
    const gate = new ConnectionOperationGate();
    const reconnect = vi.fn();

    gate.schedule(reconnect, 500);
    gate.cancel();
    await vi.advanceTimersByTimeAsync(500);

    expect(reconnect).not.toHaveBeenCalled();
  });

  it("rejects a stale connect completion", () => {
    const gate = new ConnectionOperationGate();
    const firstConnect = gate.begin();
    const disconnect = gate.cancel();

    expect(gate.isCurrent(firstConnect)).toBe(false);
    expect(gate.isCurrent(disconnect)).toBe(true);
  });
});
