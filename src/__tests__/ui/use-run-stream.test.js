import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeRunStreamsForTests, subscribeRunStream } from "../../ui/src/lib/useRunStream.js";

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
  });

  afterEach(() => {
    closeRunStreamsForTests();
    FakeEventSource.instances = [];
    delete globalThis.EventSource;
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
});
