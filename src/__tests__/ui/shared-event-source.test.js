import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedEventSourceRuntime } from "../../ui/src/lib/sharedEventSource.js";

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

class FakeBroadcastChannel {
  static channels = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.closed = false;
    const set = FakeBroadcastChannel.channels.get(name) || new Set();
    set.add(this);
    FakeBroadcastChannel.channels.set(name, set);
  }

  postMessage(message) {
    for (const channel of FakeBroadcastChannel.channels.get(this.name) || []) {
      if (channel === this || channel.closed) continue;
      channel.onmessage?.({ data: message });
    }
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: vi.fn((key) => data.has(key) ? data.get(key) : null),
    setItem: vi.fn((key, value) => { data.set(key, String(value)); }),
    removeItem: vi.fn((key) => { data.delete(key); }),
  };
}

function fakeDocument(visibilityState = "visible") {
  const listeners = new Map();
  return {
    visibilityState,
    addEventListener: vi.fn((type, listener) => {
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type, listener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener();
    },
  };
}

describe("cross-tab shared EventSource runtime", () => {
  let storage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    storage = memoryStorage();
    FakeEventSource.instances = [];
    FakeBroadcastChannel.channels.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    FakeEventSource.instances = [];
    FakeBroadcastChannel.channels.clear();
  });

  it("opens one real EventSource and broadcasts events to follower tabs", () => {
    const firstDoc = fakeDocument("visible");
    const secondDoc = fakeDocument("visible");
    const owner = createSharedEventSourceRuntime({
      tabId: "tab-a",
      env: { EventSource: FakeEventSource, BroadcastChannel: FakeBroadcastChannel, localStorage: storage, document: firstDoc },
    });
    const follower = createSharedEventSourceRuntime({
      tabId: "tab-b",
      env: { EventSource: FakeEventSource, BroadcastChannel: FakeBroadcastChannel, localStorage: storage, document: secondDoc },
    });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = owner.subscribe("global", "/api/events/stream", first);
    const unsubscribeSecond = follower.subscribe("global", "/api/events/stream", second);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events/stream");

    FakeEventSource.instances[0].onmessage({ data: JSON.stringify({ type: "task_updated", id: "task-1" }) });

    expect(first).toHaveBeenCalledWith({ type: "task_updated", id: "task-1" });
    expect(second).toHaveBeenCalledWith({ type: "task_updated", id: "task-1" });

    unsubscribeFirst();
    unsubscribeSecond();
    owner.closeAll();
    follower.closeAll();
  });

  it("promotes a follower when the owner releases its lease", () => {
    const owner = createSharedEventSourceRuntime({
      tabId: "tab-a",
      env: { EventSource: FakeEventSource, BroadcastChannel: FakeBroadcastChannel, localStorage: storage, document: fakeDocument("visible") },
    });
    const follower = createSharedEventSourceRuntime({
      tabId: "tab-b",
      env: { EventSource: FakeEventSource, BroadcastChannel: FakeBroadcastChannel, localStorage: storage, document: fakeDocument("visible") },
    });

    const unsubscribeOwner = owner.subscribe("run:1", "/api/runs/1/stream", vi.fn());
    follower.subscribe("run:1", "/api/runs/1/stream", vi.fn());
    expect(FakeEventSource.instances).toHaveLength(1);

    unsubscribeOwner();
    vi.advanceTimersByTime(50);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toBe("/api/runs/1/stream");

    owner.closeAll();
    follower.closeAll();
  });

  it("lets a visible follower take over from a hidden owner", () => {
    const hiddenDoc = fakeDocument("visible");
    const visibleDoc = fakeDocument("visible");
    const owner = createSharedEventSourceRuntime({
      tabId: "tab-a",
      env: { EventSource: FakeEventSource, BroadcastChannel: FakeBroadcastChannel, localStorage: storage, document: hiddenDoc },
    });
    const follower = createSharedEventSourceRuntime({
      tabId: "tab-b",
      env: { EventSource: FakeEventSource, BroadcastChannel: FakeBroadcastChannel, localStorage: storage, document: visibleDoc },
    });

    owner.subscribe("global", "/api/events/stream", vi.fn());
    follower.subscribe("global", "/api/events/stream", vi.fn());
    expect(FakeEventSource.instances).toHaveLength(1);

    hiddenDoc.visibilityState = "hidden";
    hiddenDoc.dispatch("visibilitychange");
    vi.advanceTimersByTime(50);

    expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    owner.closeAll();
    follower.closeAll();
  });
});
