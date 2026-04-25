import { describe, it, expect } from "vitest";
import {
  legacyRunStatusToProcessStatus,
  legacyStatusToStage,
  nextStage,
  processStatusToLegacyStatus,
  stageToLegacyStatus,
} from "../../core/state-machine.js";

describe("workflow stage reducer", () => {
  it("starts a runnable stage without changing the workflow stage", () => {
    const r = nextStage("execute", { type: "run_requested", stage: "execute", mode: "execute", agentName: "coder" });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "spawn_worker", stage: "execute", mode: "execute", agentName: "coder" });
  });

  it("rejects run_requested without an assigned agent", () => {
    const r = nextStage("execute", { type: "run_requested", stage: "execute", mode: "execute", agentName: null });
    expect(r.stage).toBe("execute");
    expect(r.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("no agent") });
  });

  it("execute advance moves to review and can spawn a reviewer", () => {
    const r = nextStage("execute", {
      type: "run_succeeded",
      stage: "execute",
      reviewerAgent: "checker",
      result: { decision: "advance" },
    });
    expect(r.stage).toBe("review");
    expect(r.sideEffects).toContainEqual({ type: "spawn_reviewer", agentName: "checker" });
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
    expect(r.sideEffects).toContainEqual({ type: "post_review_verdict", verdict: "APPROVE", notes: "ok" });
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
});

describe("legacy compatibility mapping", () => {
  it.each([
    ["todo", "execute"],
    ["in_progress", "execute"],
    ["in_review", "review"],
    ["done", "done"],
    ["blocked", "blocked"],
  ])("maps legacy task status %s to stage %s", (status, stage) => {
    expect(legacyStatusToStage(status)).toBe(stage);
  });

  it("maps stages to legacy statuses without claiming active work", () => {
    expect(stageToLegacyStatus("execute")).toBe("todo");
    expect(stageToLegacyStatus("execute", { running: true })).toBe("in_progress");
    expect(stageToLegacyStatus("review")).toBe("in_review");
    expect(stageToLegacyStatus("done")).toBe("done");
  });

  it("maps run process status to legacy run status", () => {
    expect(legacyRunStatusToProcessStatus("complete")).toBe("succeeded");
    expect(legacyRunStatusToProcessStatus("error")).toBe("failed");
    expect(processStatusToLegacyStatus("succeeded")).toBe("complete");
    expect(processStatusToLegacyStatus("failed")).toBe("error");
  });
});
