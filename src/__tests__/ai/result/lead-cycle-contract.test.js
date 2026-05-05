import { describe, it, expect } from "vitest";
import {
  LEAD_CYCLE_SCHEMA,
  WORKLAB_LEAD_CYCLE_JSON_SCHEMA,
  normalizeLeadCycleResult,
  parseLeadCycleResultFromText,
  validateLeadCycleSemantics,
  synthesizeLeadCycleFailure,
} from "../../../ai/result/lead-cycle-contract.js";

const baseResult = {
  schema: LEAD_CYCLE_SCHEMA,
  goal_status: "in_progress",
  goal_status_reason: "",
  summary: "Made progress on infra.",
  task_creations: [],
  advisory_notes: [],
  next_review_hint: null,
};

describe("worklab.lead_cycle.v1 contract", () => {
  it("exposes a JSON Schema with required fields and bounded enums", () => {
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.required).toContain("goal_status");
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.required).toContain("summary");
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.properties.schema.enum).toEqual([LEAD_CYCLE_SCHEMA]);
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.properties.goal_status.enum).toEqual(["in_progress", "complete", "blocked"]);
  });

  it("normalizes a minimal valid result", () => {
    const result = normalizeLeadCycleResult({ ...baseResult, summary: "Hello" });
    expect(result.ok).toBe(true);
    expect(result.result.goal_status).toBe("in_progress");
    expect(result.result.task_creations).toEqual([]);
    expect(result.result.task_assignments).toEqual([]);
  });

  it("rejects missing schema marker", () => {
    const result = normalizeLeadCycleResult({ ...baseResult, schema: "worklab.v2" });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty summary", () => {
    const result = normalizeLeadCycleResult({ ...baseResult, summary: "" });
    expect(result.ok).toBe(false);
  });

  it("validateLeadCycleSemantics flags goal_status=complete with task_creations", () => {
    const v = validateLeadCycleSemantics({
      ...baseResult,
      goal_status: "complete",
      goal_status_reason: "done",
      task_creations: [{
        title: "x", instructions: "", suggested_agent: "lead",
        depends_on: [], acceptance_criteria: [], expected_artifact: null, priority: "normal",
      }],
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/cannot include task_creations/);
  });

  it("validateLeadCycleSemantics requires a reason on non-progress states", () => {
    const v = validateLeadCycleSemantics({ ...baseResult, goal_status: "blocked", goal_status_reason: "" });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/goal_status_reason/);
  });

  it("validateLeadCycleSemantics rejects suggested_agent outside the roster", () => {
    const v = validateLeadCycleSemantics({
      ...baseResult,
      task_creations: [{
        title: "x", instructions: "", suggested_agent: "rogue",
        depends_on: [], acceptance_criteria: [], expected_artifact: null, priority: "normal",
      }],
    }, { rosterAgents: ["lead", "engineer"] });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/rogue/);
  });

  it("validateLeadCycleSemantics rejects assignment owners outside the roster", () => {
    const v = validateLeadCycleSemantics({
      ...baseResult,
      task_assignments: [{ target_task_id: "task-1", owner_agent: "rogue", rationale: "Needs backend work." }],
    }, { rosterAgents: ["lead", "engineer"], assignableTaskIds: ["task-1"] });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/rogue/);
  });

  it("validateLeadCycleSemantics rejects assignment targets outside the assignable queue", () => {
    const v = validateLeadCycleSemantics({
      ...baseResult,
      task_assignments: [{ target_task_id: "outside", owner_agent: "lead", rationale: "I can own this." }],
    }, { rosterAgents: ["lead", "engineer"], assignableTaskIds: ["task-1"] });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/outside assignable task queue/);
  });

  it("validateLeadCycleSemantics rejects advisory_notes outside scopeTaskIds", () => {
    const v = validateLeadCycleSemantics({
      ...baseResult,
      advisory_notes: [{ target_task_id: "outside", kind: "warning", content: "..." }],
    }, { rosterAgents: ["lead"], scopeTaskIds: ["t1"] });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/outside team scope/);
  });

  it("validateLeadCycleSemantics caps task_creations to the configured maximum", () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({
      title: `t${i}`, instructions: "", suggested_agent: "lead",
      depends_on: [], acceptance_criteria: [], expected_artifact: null, priority: "normal",
    }));
    const v = validateLeadCycleSemantics({ ...baseResult, task_creations: tasks }, { rosterAgents: ["lead"] });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/too many task_creations/);
  });

  it("validateLeadCycleSemantics honors the runtime delegation child cap", () => {
    const tasks = Array.from({ length: 4 }, (_, i) => ({
      title: `t${i}`, instructions: "", suggested_agent: "lead",
      depends_on: [], acceptance_criteria: [], expected_artifact: null, priority: "normal",
    }));
    const v = validateLeadCycleSemantics(
      { ...baseResult, task_creations: tasks },
      { rosterAgents: ["lead"], maxTaskCreations: 3 },
    );
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/max 3/);
  });

  it("parseLeadCycleResultFromText handles fenced JSON output", () => {
    const text = "```json\n" + JSON.stringify({ ...baseResult, summary: "Inside fence" }) + "\n```";
    const parsed = parseLeadCycleResultFromText(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.summary).toBe("Inside fence");
  });

  it("synthesizeLeadCycleFailure returns a blocked result", () => {
    const fallback = synthesizeLeadCycleFailure({ summary: "boom", reason: "unparseable" });
    expect(fallback.schema).toBe(LEAD_CYCLE_SCHEMA);
    expect(fallback.goal_status).toBe("blocked");
    expect(fallback.goal_status_reason).toBe("unparseable");
  });
});
