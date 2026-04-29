import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSSEForTests, subscribeSSE } from "../../ui/src/lib/useSSE.js";

class FakeEventSource {
  static instances = [];
  static CLOSED = 2;

  constructor(url) {
    this.url = url;
    this.close = vi.fn();
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    this.readyState = 1;
    this.CLOSED = FakeEventSource.CLOSED;
    FakeEventSource.instances.push(this);
  }
}

describe("shared SSE subscriptions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    closeSSEForTests();
    FakeEventSource.instances = [];
    delete globalThis.EventSource;
    vi.useRealTimers();
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

  it("reconnects with backoff after an EventSource error closes the stream", () => {
    globalThis.EventSource = FakeEventSource;
    const callback = vi.fn();
    subscribeSSE("global", callback);

    const first = FakeEventSource.instances[0];
    first.readyState = FakeEventSource.CLOSED;
    first.onerror({});

    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances).toHaveLength(2);

    const second = FakeEventSource.instances[1];
    second.readyState = FakeEventSource.CLOSED;
    second.onerror({});
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("resets the backoff after a successful onopen", () => {
    globalThis.EventSource = FakeEventSource;
    subscribeSSE("global", vi.fn());

    const first = FakeEventSource.instances[0];
    first.readyState = FakeEventSource.CLOSED;
    first.onerror({});
    vi.advanceTimersByTime(500);

    const second = FakeEventSource.instances[1];
    second.onopen?.();
    second.readyState = FakeEventSource.CLOSED;
    second.onerror({});
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});
