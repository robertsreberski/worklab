import { describe, expect, it, vi } from "vitest";
import { createWatcherProxy } from "../../coordinator.js";

describe("createWatcherProxy", () => {
  it("forwards team lead entry points to the live watcher", () => {
    const spawnLeadCycle = vi.fn(() => ({ ok: true, runId: "run-1" }));
    const maybeScheduleUnassignedTeamTask = vi.fn(() => ({ ok: true }));
    const proxy = createWatcherProxy({
      current: {
        handleRunRequested: vi.fn(),
        cancel: vi.fn(),
        shutdown: vi.fn(),
        isActive: vi.fn(),
        getRunLiveInputState: vi.fn(),
        sendRunMessage: vi.fn(),
        maybeAutoStart: vi.fn(),
        maybeAutoStartDependents: vi.fn(),
        maybeScheduleUnassignedTeamTask,
        spawnLeadCycle,
      },
    });

    expect(proxy.spawnLeadCycle({ teamId: "team-1", projectId: "project-1", reason: "manual" }))
      .toEqual({ ok: true, runId: "run-1" });
    expect(proxy.maybeScheduleUnassignedTeamTask("task-1", "task_created_unassigned"))
      .toEqual({ ok: true });
    expect(spawnLeadCycle).toHaveBeenCalledWith({ teamId: "team-1", projectId: "project-1", reason: "manual" });
    expect(maybeScheduleUnassignedTeamTask).toHaveBeenCalledWith("task-1", "task_created_unassigned");
  });
});
