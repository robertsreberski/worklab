import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeRunStreamsForTests,
  subscribeRunState,
  subscribeRunStream,
} from "../../ui/src/lib/useRunStream.js";

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.close = vi.fn();
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
}

describe("shared run stream subscriptions", () => {
  beforeEach(() => {
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        run: { id: "run-1", status: "running", process_status: "running" },
        log: {
          events: [{ type: "text", text: "hydrated", _event_seq: 1 }],
          event_count: 1,
        },
      }),
    }));
  });

  afterEach(() => {
    closeRunStreamsForTests();
    FakeEventSource.instances = [];
    delete globalThis.EventSource;
    delete globalThis.fetch;
  });

  it("fans out one run EventSource to multiple subscribers", () => {
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribeRunStream("run-1", first);
    const unsubscribeSecond = subscribeRunStream("run-1", second);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/runs/run-1/stream");

    FakeEventSource.instances[0].onmessage({ data: JSON.stringify({ type: "text", text: "working", _event_seq: 1 }) });

    expect(first).toHaveBeenCalledWith({ type: "text", text: "working", _event_seq: 1 });
    expect(second).toHaveBeenCalledWith({ type: "text", text: "working", _event_seq: 1 });

    unsubscribeFirst();
    expect(FakeEventSource.instances[0].close).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("shares one compact run hydration request across subscribers", async () => {
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribeRunState("run-1", first, { subscribe: true });
    const unsubscribeSecond = subscribeRunState("run-1", second, { subscribe: true });

    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledWith(expect.objectContaining({
        loading: false,
        events: [{ type: "text", text: "hydrated", _event_seq: 1 }],
        run: { id: "run-1", status: "running", process_status: "running" },
      }));
      expect(second).toHaveBeenCalledWith(expect.objectContaining({ loading: false }));
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/runs/run-1?events=tail&limit=24",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(FakeEventSource.instances).toHaveLength(1);

    unsubscribeFirst();
    unsubscribeSecond();
  });
});
