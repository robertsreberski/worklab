import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeAppResume } from "../../ui/src/lib/pageVisibility.js";

function fakeTarget(initialVisibility = "visible") {
  const listeners = new Map();
  return {
    visibilityState: initialVisibility,
    addEventListener: vi.fn((type, listener) => {
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type, listener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
}

function fakeEnv(initialVisibility = "visible") {
  const document = fakeTarget(initialVisibility);
  const window = fakeTarget(initialVisibility);
  return {
    document,
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
    dispatchWindow: window.dispatch,
  };
}

describe("app resume lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call back on initial subscription", () => {
    const env = fakeEnv("visible");
    const callback = vi.fn();

    const unsubscribe = subscribeAppResume(callback, env);

    expect(callback).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("calls back when the document returns from hidden to visible", () => {
    const env = fakeEnv("visible");
    const callback = vi.fn();

    const unsubscribe = subscribeAppResume(callback, env);
    env.document.visibilityState = "hidden";
    env.document.dispatch("visibilitychange");
    env.document.visibilityState = "visible";
    env.document.dispatch("visibilitychange");

    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("calls back when a page is restored from bfcache", () => {
    const env = fakeEnv("visible");
    const callback = vi.fn();

    const unsubscribe = subscribeAppResume(callback, env);
    env.dispatchWindow("pageshow", { persisted: true });

    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("dedupes visibility and focus resume events in the same window", () => {
    const env = fakeEnv("visible");
    const callback = vi.fn();

    const unsubscribe = subscribeAppResume(callback, env, { dedupeMs: 500 });
    env.document.visibilityState = "hidden";
    env.document.dispatch("visibilitychange");
    env.document.visibilityState = "visible";
    env.document.dispatch("visibilitychange");
    env.dispatchWindow("focus");

    expect(callback).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_600);
    env.document.visibilityState = "hidden";
    env.document.dispatch("visibilitychange");
    env.document.visibilityState = "visible";
    env.dispatchWindow("focus");

    expect(callback).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not call back while the document is still hidden", () => {
    const env = fakeEnv("visible");
    const callback = vi.fn();

    const unsubscribe = subscribeAppResume(callback, env);
    env.document.visibilityState = "hidden";
    env.document.dispatch("visibilitychange");
    env.dispatchWindow("focus");
    env.dispatchWindow("pageshow", { persisted: true });

    expect(callback).not.toHaveBeenCalled();
    unsubscribe();
  });
});
