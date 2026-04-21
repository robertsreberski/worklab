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

describe("human_move transitions", () => {
  it.each([
    ["todo", "in_progress"],
    ["in_progress", "todo"],
    ["in_progress", "in_review"],
    ["in_review", "done"],
    ["in_review", "in_progress"],
    ["done", "todo"],
    ["done", "in_progress"],
    ["done", "in_review"],
  ])("%s → %s via human_move is allowed", (from, to) => {
    const r = nextStatus(from, { type: "human_move", target: to });
    expect(r.status).toBe(to);
  });

  it("rejects invalid target", () => {
    const r = nextStatus("todo", { type: "human_move", target: "mystery" });
    expect(r.status).toBe("todo");
    expect(r.sideEffects.some(s => s.type === "error")).toBe(true);
  });

  it("sets completed_at on human_move → done", () => {
    const r = nextStatus("in_review", { type: "human_move", target: "done" });
    expect(r.sideEffects).toContainEqual({ type: "set_completed_at" });
  });

  it("clears completed_at on human_move from done → anywhere else", () => {
    const r = nextStatus("done", { type: "human_move", target: "todo" });
    expect(r.sideEffects).toContainEqual({ type: "clear_completed_at" });
  });
});

describe("transition coverage", () => {
  it("rejects run_requested from invalid states with error", () => {
    for (const s of ["in_review", "done"]) {
      const r = nextStatus(s, { type: "run_requested", executorAgent: "x" });
      expect(r.status).toBe(s);
      expect(r.sideEffects.some(se => se.type === "error")).toBe(true);
    }
  });

  it("unknown event type yields error", () => {
    const r = nextStatus("todo", { type: "bogus" });
    expect(r.status).toBe("todo");
    expect(r.sideEffects[0].type).toBe("error");
  });

  it("run_completed from non-in_progress state → error", () => {
    const r = nextStatus("todo", { type: "run_completed", reviewerAgent: null });
    expect(r.status).toBe("todo");
    expect(r.sideEffects.some(se => se.type === "error")).toBe(true);
  });

  it("run_failed from non-in_progress state → error", () => {
    const r = nextStatus("todo", { type: "run_failed", message: "oops" });
    expect(r.status).toBe("todo");
    expect(r.sideEffects.some(se => se.type === "error")).toBe(true);
  });

  it("review_approved from non-in_review state → error", () => {
    const r = nextStatus("todo", { type: "review_approved" });
    expect(r.status).toBe("todo");
    expect(r.sideEffects.some(se => se.type === "error")).toBe(true);
  });

  it("review_rejected from non-in_review state → error", () => {
    const r = nextStatus("todo", { type: "review_rejected", notes: "nope" });
    expect(r.status).toBe("todo");
    expect(r.sideEffects.some(se => se.type === "error")).toBe(true);
  });

  it("run_failed without message falls back to default message", () => {
    const r = nextStatus("in_progress", { type: "run_failed" });
    expect(r.sideEffects).toContainEqual({ type: "post_error_comment", message: "run failed" });
  });

  it("review_rejected without notes defaults to empty string", () => {
    const r = nextStatus("in_review", { type: "review_rejected" });
    expect(r.sideEffects).toContainEqual({ type: "post_review_comment", notes: "" });
  });
});
