import { describe, it, expect } from "vitest";
import { nextStatus } from "../../core/state-machine.js";

describe("nextStatus", () => {
  it("todo + run_requested → in_progress, spawn_executor", () => {
    const r = nextStatus("todo", { type: "run_requested", executorAgent: "coder" });
    expect(r.status).toBe("in_progress");
    expect(r.sideEffects).toContainEqual({ type: "spawn_executor", agentName: "coder" });
  });

  it("todo + run_requested without executor → 'error' side effect, status unchanged", () => {
    const r = nextStatus("todo", { type: "run_requested", executorAgent: null });
    expect(r.status).toBe("todo");
    expect(r.sideEffects).toContainEqual({ type: "error", message: expect.stringContaining("no executor") });
  });
});

describe("in_progress transitions", () => {
  it("run_completed with reviewer → in_review, spawn_reviewer", () => {
    const r = nextStatus("in_progress", { type: "run_completed", reviewerAgent: "checker" });
    expect(r.status).toBe("in_review");
    expect(r.sideEffects).toContainEqual({ type: "spawn_reviewer", agentName: "checker" });
  });

  it("run_completed without reviewer → in_review, no spawn", () => {
    const r = nextStatus("in_progress", { type: "run_completed", reviewerAgent: null });
    expect(r.status).toBe("in_review");
    expect(r.sideEffects.some(s => s.type === "spawn_reviewer")).toBe(false);
  });

  it("run_failed → stays in_progress, posts error comment, red badge", () => {
    const r = nextStatus("in_progress", { type: "run_failed", message: "timeout" });
    expect(r.status).toBe("in_progress");
    expect(r.sideEffects).toContainEqual({ type: "post_error_comment", message: "timeout" });
    expect(r.sideEffects).toContainEqual({ type: "mark_badge_red" });
  });
});

describe("in_review transitions", () => {
  it("review_approved → done, set_completed_at", () => {
    const r = nextStatus("in_review", { type: "review_approved" });
    expect(r.status).toBe("done");
    expect(r.sideEffects).toContainEqual({ type: "set_completed_at" });
  });

  it("review_rejected → in_progress, post comment, clear error", () => {
    const r = nextStatus("in_review", { type: "review_rejected", notes: "not ok" });
    expect(r.status).toBe("in_progress");
    expect(r.sideEffects).toContainEqual({ type: "post_review_comment", notes: "not ok" });
    expect(r.sideEffects).toContainEqual({ type: "clear_error_text" });
  });
});
