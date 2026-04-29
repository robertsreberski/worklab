import { describe, it, expect } from "vitest";
import {
  legacyRunStatusToProcessStatus,
  nextStage,
  processStatusToLegacyStatus,
} from "../../core/state-machine.js";

describe("workflow stage reducer", () => {
  it("starts a runnable stage without changing the workflow stage", () => {
    const r = nextStage("execute", { type: "run_requested", stage: "execute", mode: "execute", agentName: "coder" });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "spawn_worker", stage: "execute", mode: "execute", agentName: "coder" });
  });

  it("plan advance moves to execute", () => {
    const r = nextStage("plan", {
      type: "run_succeeded",
      stage: "plan",
      result: { decision: "advance" },
    });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "reset_failure_count" });
  });

  it("rejects run_requested without an assigned agent", () => {
    const r = nextStage("execute", { type: "run_requested", stage: "execute", mode: "execute", agentName: null });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("no agent") });
  });

  it("execute advance moves to review without auto-spawning a reviewer", () => {
    const r = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      reviewerAgent: "checker",
      result: { decision: "advance" },
    });
    expect(r.stage).toBe("review");
    expect(r.sideEffects).not.toContainEqual({ type: "spawn_reviewer", agentName: "checker" });
  });

  it("execute failure remains retryable in execute with failure context", () => {
    const r = nextStage("execute", { type: "run_failed", message: "timeout", failureKind: "timeout" });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "post_error_comment", message: "timeout" });
    expect(r.sideEffects).toContainEqual({ type: "set_error_text", message: "timeout" });
    expect(r.sideEffects).toContainEqual({ type: "set_stage_reason", reason: "timeout" });
  });

  it("review approve reaches done", () => {
    const r = nextStage("review", {
      type: "run_succeeded",
      stage: "review",
      result: { decision: "approve", summary: "ok" },
    });
    expect(r.stage).toBe("done");
    expect(r.sideEffects).toContainEqual({ type: "set_completed_at" });
    expect(r.sideEffects).not.toContainEqual({ type: "post_review_verdict", verdict: "APPROVE", notes: "ok" });
  });

  it("review reject routes back to execute", () => {
    const r = nextStage("review", {
      type: "run_succeeded",
      stage: "review",
      result: { decision: "reject", summary: "not ok", details: "fix tests" },
    });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "post_review_comment", notes: "fix tests" });
  });

  it("delegate creates subtasks and waits for children", () => {
    const subtasks = [{ title: "child", instructions: "do it" }];
    const r = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      result: { decision: "delegate", subtasks },
    });
    expect(r.stage).toBe("awaiting_children");
    expect(r.sideEffects).toContainEqual({ type: "create_subtasks", subtasks });
  });

  it("pause and block produce user-action stages", () => {
    expect(nextStage("execute", {
      type: "run_succeeded",
      result: { decision: "pause", summary: "need approval", pending_actions: ["approve"] },
    }).stage).toBe("awaiting_user");
    expect(nextStage("execute", {
      type: "run_succeeded",
      result: { decision: "block", summary: "missing key", blocking_issues: ["OPENAI_API_KEY"] },
    }).stage).toBe("blocked");
  });

  it("required children completion resumes execute; blocked child blocks parent", () => {
    expect(nextStage("awaiting_children", { type: "children_completed" }).stage).toBe("execute");
    expect(nextStage("awaiting_children", { type: "child_blocked", message: "child blocked" }).stage).toBe("blocked");
  });

  it("human moves are stage based and clear completed_at when reopening", () => {
    const r = nextStage("done", { type: "human_move", target: "execute" });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "clear_completed_at" });
  });

  it("execute advance with no reviewer goes straight to done with completed_at set", () => {
    const r = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      reviewerAgent: null,
      result: { decision: "advance" },
    });
    expect(r.stage).toBe("done");
    expect(r.sideEffects).toContainEqual({ type: "set_completed_at" });
    expect(r.sideEffects).not.toContainEqual({ type: "spawn_reviewer", agentName: expect.anything() });
  });

  it("review must explicitly approve or reject; advance is rejected as an error", () => {
    const r = nextStage("review", {
      type: "run_succeeded",
      stage: "review",
      result: { decision: "advance" },
    });
    expect(r.stage).toBe("review");
    expect(r.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("review must return") });
  });

  it("delegate with empty subtasks is rejected — prevents the parent from waiting on nothing", () => {
    const r = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      result: { decision: "delegate", subtasks: [] },
    });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("at least one subtask") });
  });

  it("rejects pending_actions except for pause and subtasks except for delegate", () => {
    const advancePending = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      result: { decision: "advance", pending_actions: ["do next"] },
    });
    expect(advancePending.stage).toBe("execute");
    expect(advancePending.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("pending_actions") });

    const advanceSubtask = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      result: { decision: "advance", subtasks: [{ title: "child" }] },
    });
    expect(advanceSubtask.stage).toBe("execute");
    expect(advanceSubtask.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("subtasks") });

    const pauseEmpty = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      result: { decision: "pause", pending_actions: [] },
    });
    expect(pauseEmpty.stage).toBe("execute");
    expect(pauseEmpty.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("pending_action") });
  });

  it("run_cancelled keeps the stage but does not write error_text or bump failure count", () => {
    const r = nextStage("execute", { type: "run_cancelled", retryStage: "execute", message: "user cancel" });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "clear_error_text" });
    expect(r.sideEffects).toContainEqual({ type: "set_stage_reason", reason: "cancelled (user)" });
    expect(r.sideEffects).toContainEqual({ type: "post_cancellation_comment", message: "user cancel" });
    // crucially: no set_failure_count on cancel
    expect(r.sideEffects.some((sideEffect) => sideEffect.type === "set_failure_count")).toBe(false);
  });

  it("run_abandoned is treated as a non-retry-counting failure with error_text", () => {
    const r = nextStage("execute", { type: "run_abandoned", retryStage: "execute" });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "set_error_text", message: expect.any(String) });
    expect(r.sideEffects).toContainEqual({ type: "set_stage_reason", reason: "abandoned" });
    expect(r.sideEffects.some((sideEffect) => sideEffect.type === "set_failure_count")).toBe(false);
  });

  it("run_failed escalates to blocked when failure_count crosses the configured threshold", () => {
    const r = nextStage("execute", {
      type: "run_failed",
      message: "still broken",
      failureKind: "spawn",
      failureCount: 2,
      maxFailures: 3,
    });
    expect(r.stage).toBe("blocked");
    expect(r.sideEffects).toContainEqual({ type: "set_failure_count", count: 3 });
    expect(r.sideEffects.find((sideEffect) => sideEffect.type === "set_blocking_issues").blockingIssues[0]).toMatch(/Reached max failures/);
  });

  it("run_failed below threshold stays retryable and increments the failure count", () => {
    const r = nextStage("execute", {
      type: "run_failed",
      message: "first fail",
      failureCount: 0,
      maxFailures: 3,
    });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "set_failure_count", count: 1 });
  });

  it("human_move out of awaiting_user clears pending_actions; out of blocked clears blocking_issues", () => {
    const fromPaused = nextStage("awaiting_user", { type: "human_move", target: "execute" });
    expect(fromPaused.sideEffects).toContainEqual({ type: "clear_pending_actions" });
    expect(fromPaused.sideEffects).toContainEqual({ type: "reset_failure_count" });

    const fromBlocked = nextStage("blocked", { type: "human_move", target: "execute" });
    expect(fromBlocked.sideEffects).toContainEqual({ type: "clear_blocking_issues" });
    expect(fromBlocked.sideEffects).toContainEqual({ type: "clear_error_text" });
  });

  it("delegate clears prior pending/blocking arrays when the parent enters awaiting_children", () => {
    const r = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      result: { decision: "delegate", subtasks: [{ title: "x" }] },
    });
    expect(r.sideEffects).toContainEqual({ type: "clear_pending_actions" });
    expect(r.sideEffects).toContainEqual({ type: "clear_blocking_issues" });
  });

  it("review approve clears pending/blocking arrays alongside completed_at", () => {
    const r = nextStage("review", {
      type: "run_succeeded",
      stage: "review",
      result: { decision: "approve", summary: "ok" },
    });
    expect(r.sideEffects).toContainEqual({ type: "clear_pending_actions" });
    expect(r.sideEffects).toContainEqual({ type: "clear_blocking_issues" });
    expect(r.sideEffects).toContainEqual({ type: "reset_failure_count" });
  });
});

describe("run process status compatibility mapping", () => {
  it("maps run process status to legacy run status", () => {
    expect(legacyRunStatusToProcessStatus("complete")).toBe("succeeded");
    expect(legacyRunStatusToProcessStatus("error")).toBe("failed");
    expect(processStatusToLegacyStatus("succeeded")).toBe("complete");
    expect(processStatusToLegacyStatus("failed")).toBe("error");
  });
});
