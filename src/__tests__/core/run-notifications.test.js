import { describe, expect, it } from "vitest";
import {
  buildRunNotification,
  buildRunPushPayload,
  runNotificationKind,
  runNotificationRoute,
} from "../../core/run-notifications.js";

const taskStarted = {
  type: "run_started",
  runId: "run-1",
  taskId: "task-1",
  taskKey: "T-7",
  taskTitle: "Implement notifications",
  mode: "execute",
  stage: "execute",
  agentName: "coder",
  agentDisplayName: "Code Specialist",
  status: "running",
  processStatus: "running",
};

describe("run notification content", () => {
  it("classifies task run notification kinds", () => {
    expect(runNotificationKind(taskStarted)).toBe("started");
    expect(runNotificationKind({ ...taskStarted, type: "run_ended", processStatus: "succeeded" })).toBe("completed");
    expect(runNotificationKind({ ...taskStarted, type: "run_ended", processStatus: "failed" })).toBe("errored");
    expect(runNotificationKind({ ...taskStarted, type: "run_ended", processStatus: "cancelled" })).toBe(null);
    expect(runNotificationKind({ ...taskStarted, taskId: null })).toBe(null);
  });

  it("builds shared notification text and routes", () => {
    expect(buildRunNotification(taskStarted)).toEqual({
      kind: "started",
      title: "Run started: T-7 · Implement notifications",
      body: "Execute · Code Specialist",
    });
    expect(runNotificationRoute(taskStarted)).toBe("#/tasks/T-7?run=run-1");
    expect(runNotificationRoute({ ...taskStarted, taskKey: "" })).toBe("#/tasks/task-1?run=run-1");
  });

  it("builds small push payloads for service workers", () => {
    expect(buildRunPushPayload({
      ...taskStarted,
      type: "run_ended",
      processStatus: "failed",
      errorText: "worker exited",
    })).toEqual({
      title: "Run errored: T-7 · Implement notifications",
      body: "worker exited",
      tag: "worklab-run-1",
      data: {
        kind: "errored",
        route: "#/tasks/T-7?run=run-1",
        runId: "run-1",
        taskId: "task-1",
      },
    });
  });
});
