import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSSEForTests, subscribeSSE } from "../../ui/src/lib/useSSE.js";

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.close = vi.fn();
    this.onmessage = null;
    FakeEventSource.instances.push(this);
  }
}

describe("shared SSE subscriptions", () => {
  afterEach(() => {
    closeSSEForTests();
    FakeEventSource.instances = [];
    delete globalThis.EventSource;
  });

  it("fans out one EventSource to multiple subscribers", () => {
    globalThis.EventSource = FakeEventSource;
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribeSSE("global", first);
    const unsubscribeSecond = subscribeSSE("global", second);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events/stream");

    FakeEventSource.instances[0].onmessage({ data: JSON.stringify({ type: "task_updated" }) });
    expect(first).toHaveBeenCalledWith({ type: "task_updated" });
    expect(second).toHaveBeenCalledWith({ type: "task_updated" });

    unsubscribeFirst();
    expect(FakeEventSource.instances[0].close).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
  });
});
