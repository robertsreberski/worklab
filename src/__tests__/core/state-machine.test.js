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
