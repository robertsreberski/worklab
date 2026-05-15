import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingTaskScheduler } from "../../../coordinator/watcher/auto-start-scheduler.js";

describe("pending task auto-start scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes pending starts and runs after the current tick", async () => {
    vi.useFakeTimers();
    const active = new Map();
    const pendingStarts = new Set();
    const run = vi.fn(async () => {});
    const canStart = vi.fn(() => true);
    const scheduler = createPendingTaskScheduler({ active, pendingStarts, canStart, run });

    expect(scheduler.schedule("task-1")).toBe(true);
    expect(scheduler.schedule("task-1")).toBe(false);
    expect(pendingStarts.has("task-1")).toBe(true);

    await vi.runAllTimersAsync();

    expect(run).toHaveBeenCalledWith("task-1");
    expect(pendingStarts.has("task-1")).toBe(false);
  });

  it("skips tasks that become ineligible before the timer fires", async () => {
    vi.useFakeTimers();
    const active = new Map();
    const pendingStarts = new Set();
    const run = vi.fn(async () => {});
    const canStart = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const scheduler = createPendingTaskScheduler({ active, pendingStarts, canStart, run });

    expect(scheduler.schedule("task-1")).toBe(true);
    await vi.runAllTimersAsync();

    expect(run).not.toHaveBeenCalled();
    expect(pendingStarts.has("task-1")).toBe(false);
  });

  it("routes run failures to the supplied error handler", async () => {
    vi.useFakeTimers();
    const active = new Map();
    const pendingStarts = new Set();
    const error = new Error("spawn failed");
    const onError = vi.fn();
    const scheduler = createPendingTaskScheduler({
      active,
      pendingStarts,
      canStart: () => true,
      run: vi.fn(async () => {
        throw error;
      }),
    });

    expect(scheduler.schedule("task-1", onError)).toBe(true);
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalledWith(error);
  });

  it("routes synchronous run failures to the supplied error handler", async () => {
    vi.useFakeTimers();
    const active = new Map();
    const pendingStarts = new Set();
    const error = new Error("sync spawn failed");
    const onError = vi.fn();
    const scheduler = createPendingTaskScheduler({
      active,
      pendingStarts,
      canStart: () => true,
      run: vi.fn(() => {
        throw error;
      }),
    });

    expect(scheduler.schedule("task-1", onError)).toBe(true);
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalledWith(error);
    expect(pendingStarts.has("task-1")).toBe(false);
  });
});
