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

  it("forwards approval and ACP interaction controls to the live watcher", async () => {
    const approvalResult = { ok: true, row: { requestId: "approval-1", status: "approved" } };
    const sendRunApprovalDecision = vi.fn(async () => approvalResult);
    const sendRunAcpInteractionResponse = vi.fn(async () => ({ ok: true }));
    const sendRunAcpInteractionCancel = vi.fn(async () => ({ ok: true }));
    const proxy = createWatcherProxy({
      current: {
        sendRunApprovalDecision,
        sendRunAcpInteractionResponse,
        sendRunAcpInteractionCancel,
      },
    });

    const approvalPayload = {
      requestId: "approval-1",
      decision: "approve",
      reason: "Reviewed",
      decidedBy: "user",
    };
    await expect(proxy.sendRunApprovalDecision("run-1", approvalPayload)).resolves.toBe(approvalResult);
    await expect(proxy.sendRunAcpInteractionResponse({
      runId: "run-1",
      interactionId: "interaction-1",
      response: { action: "accept" },
    })).resolves.toEqual({ ok: true });
    await expect(proxy.sendRunAcpInteractionCancel({
      runId: "run-1",
      interactionId: "interaction-1",
    })).resolves.toEqual({ ok: true });
    expect(sendRunApprovalDecision).toHaveBeenCalledOnce();
    expect(sendRunApprovalDecision).toHaveBeenNthCalledWith(1, "run-1", approvalPayload);
    expect(sendRunAcpInteractionResponse).toHaveBeenCalledOnce();
    expect(sendRunAcpInteractionCancel).toHaveBeenCalledOnce();
  });
});
