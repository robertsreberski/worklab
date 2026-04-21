import { describe, it, expect, vi } from "vitest";
import { createSseBroker } from "../../api/sse.js";

function fakeRes() {
  const writes = [];
  return {
    writeHead: vi.fn(),
    write: vi.fn(s => writes.push(s)),
    end: vi.fn(),
    on: vi.fn(),
    writes,
  };
}

describe("sse broker", () => {
  it("subscribes a client and broadcasts to it", () => {
    const broker = createSseBroker();
    const res = fakeRes();
    broker.subscribe("channel-1", res);
    broker.broadcast("channel-1", { type: "hello" });
    expect(res.write).toHaveBeenCalled();
    expect(res.writes.join("")).toMatch(/"type":"hello"/);
  });

  it("broadcast to unknown channel is a no-op", () => {
    const broker = createSseBroker();
    expect(() => broker.broadcast("missing", { x: 1 })).not.toThrow();
  });

  it("unsubscribe removes a client so it stops receiving", () => {
    const broker = createSseBroker();
    const res = fakeRes();
    broker.subscribe("c", res);
    broker.unsubscribe("c", res);
    // subscribe writes ": connected\n\n" once; after unsubscribe,
    // broadcast should not add any further writes
    const callsBefore = res.write.mock.calls.length;
    broker.broadcast("c", { x: 1 });
    expect(res.write).toHaveBeenCalledTimes(callsBefore);
  });
});
