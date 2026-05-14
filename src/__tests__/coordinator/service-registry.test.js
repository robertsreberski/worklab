import { describe, expect, it, vi } from "vitest";
import {
  createBackgroundServiceRegistry,
  startDeferredService,
} from "../../coordinator/service-registry.js";

describe("coordinator service registry", () => {
  it("starts registered services in order and records startup phases", () => {
    const calls = [];
    const logger = { warn: vi.fn() };
    const markStartup = vi.fn((phase) => calls.push(`mark:${phase}`));
    const registry = createBackgroundServiceRegistry({ logger, markStartup });

    registry.register({
      name: "first",
      phase: "first_start",
      start: vi.fn(() => calls.push("start:first")),
    });
    registry.register({
      name: "second",
      phase: "second_start",
      start: vi.fn(() => calls.push("start:second")),
    });

    registry.startAll();

    expect(calls).toEqual([
      "start:first",
      "mark:first_start",
      "start:second",
      "mark:second_start",
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs start failures and continues through the registry", () => {
    const calls = [];
    const logger = { warn: vi.fn() };
    const markStartup = vi.fn((phase) => calls.push(`mark:${phase}`));
    const registry = createBackgroundServiceRegistry({ logger, markStartup });

    registry.register({
      name: "bad",
      phase: "bad_start",
      start: vi.fn(() => {
        calls.push("start:bad");
        throw new Error("boom");
      }),
    });
    registry.register({
      name: "good",
      phase: "good_start",
      start: vi.fn(() => calls.push("start:good")),
    });

    registry.startAll();

    expect(calls).toEqual([
      "start:bad",
      "mark:bad_start",
      "start:good",
      "mark:good_start",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ service: "bad" }),
      "background service start error",
    );
  });

  it("shuts down registered services and continues after failures", async () => {
    const calls = [];
    const logger = { warn: vi.fn() };
    const registry = createBackgroundServiceRegistry({ logger });

    registry.register({
      name: "shutdown",
      shutdown: vi.fn(async () => {
        calls.push("shutdown");
      }),
    });
    registry.register({
      name: "stop",
      stop: vi.fn(() => {
        calls.push("stop");
        throw new Error("stop failed");
      }),
    });
    registry.register({
      name: "after",
      shutdown: vi.fn(async () => {
        calls.push("after");
      }),
    });

    await registry.shutdownAll();

    expect(calls).toEqual(["shutdown", "stop", "after"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ service: "stop" }),
      "background service shutdown error",
    );
  });

  it("keeps deferred service status non-blocking while start is unresolved", async () => {
    const logger = { warn: vi.fn() };
    const service = {
      start: vi.fn(() => new Promise(() => {})),
      status: vi.fn(() => ({ enabled: true, connected: false, reason: "not_started" })),
      shutdown: vi.fn(async () => {}),
    };

    const wrapped = startDeferredService({
      name: "slack",
      service,
      startTimeoutMs: 5,
      logger,
    });

    expect(wrapped.status()).toMatchObject({ enabled: true, connected: false, reason: "starting" });

    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(wrapped.status()).toMatchObject({ enabled: true, connected: false, reason: "start_timeout" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ service: "slack" }),
      "optional service start timed out",
    );
  });
});
