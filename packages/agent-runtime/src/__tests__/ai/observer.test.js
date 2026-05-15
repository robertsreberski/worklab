import { describe, expect, it, vi } from "vitest";
import { createMetricsObserver, createObserverHub } from "../../ai/observer.js";

describe("createObserverHub", () => {
  it("fans an event out to every observer", () => {
    const a = { name: "a", recordEvent: vi.fn() };
    const b = { name: "b", recordEvent: vi.fn() };
    const hub = createObserverHub({ observers: [a, b] });
    hub.emit({ type: "assistant" });
    expect(a.recordEvent).toHaveBeenCalledTimes(1);
    expect(b.recordEvent).toHaveBeenCalledTimes(1);
  });

  it("registers an onEvent callback as a synthetic observer", () => {
    const calls = [];
    const hub = createObserverHub({ onEvent: (e) => calls.push(e) });
    hub.emit({ type: "tool_use", name: "Bash" });
    expect(calls).toEqual([{ type: "tool_use", name: "Bash" }]);
  });

  it("swallows observer errors so one bad subscriber does not break the run", () => {
    const ok = { recordEvent: vi.fn() };
    const bad = { recordEvent: () => { throw new Error("boom"); } };
    const hub = createObserverHub({ observers: [bad, ok] });
    expect(() => hub.emit({ type: "assistant" })).not.toThrow();
    expect(ok.recordEvent).toHaveBeenCalled();
  });

  it("rejects observers that lack a recordEvent method", () => {
    const hub = createObserverHub({ observers: [{}, null, undefined, { recordEvent: "not-a-fn" }] });
    expect(hub.observers()).toEqual([]);
  });

  it("flushes async observers", async () => {
    const flushed = [];
    const hub = createObserverHub({
      observers: [
        { recordEvent: () => {}, async flush() { flushed.push("a"); } },
        { recordEvent: () => {}, flush: () => { flushed.push("b"); } },
      ],
    });
    await hub.flush();
    expect(flushed.sort()).toEqual(["a", "b"]);
  });
});

describe("createMetricsObserver", () => {
  it("tallies tool calls by name from explicit tool_use events", () => {
    const obs = createMetricsObserver();
    obs.recordEvent({ type: "tool_use", name: "Bash" });
    obs.recordEvent({ type: "tool_use", name: "Bash" });
    obs.recordEvent({ type: "tool_use", name: "Read" });
    expect(obs.snapshot().tools.callsByName).toEqual({ Bash: 2, Read: 1 });
  });

  it("tallies tool calls from assistant content blocks", () => {
    const obs = createMetricsObserver();
    obs.recordEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "let's go" },
          { type: "tool_use", name: "Edit" },
          { type: "tool_use", name: "Edit" },
        ],
      },
    });
    expect(obs.snapshot().tools.callsByName).toEqual({ Edit: 2 });
  });

  it("aggregates cache hits/misses and computes hitRatio", () => {
    const obs = createMetricsObserver();
    obs.recordEvent({ type: "cache_hit", tokens: 200 });
    obs.recordEvent({ type: "cache_hit", tokens: 100 });
    obs.recordEvent({ type: "cache_miss", tokens: 50 });
    const snap = obs.snapshot();
    expect(snap.cache.hits).toBe(2);
    expect(snap.cache.misses).toBe(1);
    expect(snap.cache.hitRatio).toBeCloseTo(2 / 3, 5);
    expect(snap.cache.readTokensFromEvents).toBe(300);
  });

  it("returns null hitRatio when no cache signal arrived", () => {
    const obs = createMetricsObserver();
    expect(obs.snapshot().cache.hitRatio).toBeNull();
  });

  it("treats cost_accumulated values as the running total, not deltas", () => {
    const obs = createMetricsObserver();
    obs.recordEvent({ type: "cost_accumulated", cumulativeUsd: 0.01, tokens: { input: 100, output: 20 } });
    obs.recordEvent({ type: "cost_accumulated", cumulativeUsd: 0.03, tokens: { input: 250, output: 60, cacheReadTokens: 100, cacheCreationTokens: 10 } });
    const snap = obs.snapshot();
    expect(snap.cost.cumulativeUsd).toBe(0.03);
    expect(snap.tokens).toEqual({ input: 250, output: 60, cacheReadTokens: 100, cacheCreationTokens: 10 });
  });

  it("computes p50/p95 turn latency from provider_request_* event pairs", () => {
    const obs = createMetricsObserver();
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const ms of samples) {
      obs.recordEvent({ type: "provider_request_started", model: "m", timestamp: 0 });
      obs.recordEvent({ type: "provider_request_completed", model: "m", timestamp: ms });
    }
    const snap = obs.snapshot();
    expect(snap.turns.count).toBe(10);
    expect(snap.turns.latencyMsP50).toBeGreaterThan(45);
    expect(snap.turns.latencyMsP50).toBeLessThan(60);
    expect(snap.turns.latencyMsP95).toBeGreaterThan(90);
  });

  it("counts approval lifecycle events", () => {
    const obs = createMetricsObserver();
    obs.recordEvent({ type: "tool_approval_pending" });
    obs.recordEvent({ type: "tool_approval_granted" });
    obs.recordEvent({ type: "tool_approval_pending" });
    obs.recordEvent({ type: "tool_approval_denied" });
    expect(obs.snapshot().approvals).toEqual({ pending: 2, granted: 1, denied: 1 });
  });

  it("counts errors by failureKind", () => {
    const obs = createMetricsObserver();
    obs.recordEvent({ type: "error", failureKind: "provider_unavailable" });
    obs.recordEvent({ type: "error", failureKind: "provider_unavailable" });
    obs.recordEvent({ type: "cancelled", reason: "user" });
    const snap = obs.snapshot();
    expect(snap.errors.total).toBe(3);
    expect(snap.errors.byKind.provider_unavailable).toBe(2);
    expect(snap.errors.byKind.user).toBe(1);
  });

  it("never throws on malformed events", () => {
    const obs = createMetricsObserver();
    expect(() => obs.recordEvent(null)).not.toThrow();
    expect(() => obs.recordEvent({})).not.toThrow();
    expect(() => obs.recordEvent({ type: 42 })).not.toThrow();
  });
});

describe("createRuntime + observers integration", () => {
  it("forwards host.observers and options.observers to bridge execute via the hub", async () => {
    const executeMock = vi.fn().mockResolvedValue({ text: "ok" });
    vi.resetModules();
    vi.doMock("../../ai/runtime/registry.js", () => ({
      resolveRuntimeBridge: async () => ({ id: "stub", execute: executeMock }),
    }));
    const { createRuntime } = await import("../../runtime.js");
    const hostObs = { recordEvent: vi.fn() };
    const callObs = { recordEvent: vi.fn() };
    const onEvent = vi.fn();
    const runtime = createRuntime({ observers: [hostObs] });
    await runtime.run("sys", {
      model: { sdk: "claude", model: "x" },
      observers: [callObs],
      onEvent,
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const passedOptions = executeMock.mock.calls[0][1];
    // The hub-emit wrapper should be in place of the original onEvent.
    expect(typeof passedOptions.onEvent).toBe("function");
    passedOptions.onEvent({ type: "tool_use", name: "Bash" });
    expect(hostObs.recordEvent).toHaveBeenCalledTimes(1);
    expect(callObs.recordEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    vi.doUnmock("../../ai/runtime/registry.js");
  });
});
