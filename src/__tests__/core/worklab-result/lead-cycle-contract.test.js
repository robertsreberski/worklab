import { describe, it, expect } from "vitest";
import {
  LEAD_CYCLE_SCHEMA,
  WORKLAB_LEAD_CYCLE_JSON_SCHEMA,
  normalizeLeadCycleResult,
  parseLeadCycleResultFromText,
  validateLeadCycleSemantics,
  synthesizeLeadCycleFailure,
} from "../../../core/worklab-result/lead-cycle-contract.js";

const baseResult = {
  schema: LEAD_CYCLE_SCHEMA,
  goal_status: "in_progress",
  goal_status_reason: "",
  summary: "Made progress on infra.",
  checkpoint_note: "Checked current work and assigned the next task.",
  validation_summary: "No validation run was needed this cycle.",
  task_creations: [],
  advisory_notes: [],
  next_review_hint: null,
};

function collectObjectSchemas(schema) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object")) found.push(node);
    for (const property of Object.values(node.properties || {})) visit(property);
    if (node.items) visit(node.items);
    for (const option of node.anyOf || []) visit(option);
  }
  visit(schema);
  return found;
}

describe("worklab.lead_cycle.v1 contract", () => {
  it("exposes a JSON Schema with required fields and bounded enums", () => {
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.required).toContain("goal_status");
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.required).toContain("summary");
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.required).toContain("checkpoint_note");
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.required).toContain("validation_summary");
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.properties.schema.enum).toEqual([LEAD_CYCLE_SCHEMA]);
    expect(WORKLAB_LEAD_CYCLE_JSON_SCHEMA.properties.goal_status.enum).toEqual(["in_progress", "complete", "blocked"]);
  });

  it("exports a strict structured-output schema accepted by response-format validators", () => {
    for (const objectSchema of collectObjectSchemas(WORKLAB_LEAD_CYCLE_JSON_SCHEMA)) {
      expect(objectSchema.additionalProperties).toBe(false);
      if (objectSchema.properties) {
        expect(objectSchema.required).toEqual(Object.keys(objectSchema.properties));
      }
    }
  });

  it("normalizes a minimal valid result", () => {
    const result = normalizeLeadCycleResult({ ...baseResult, summary: "Hello" });
    expect(result.ok).toBe(true);
    expect(result.result.goal_status).toBe("in_progress");
    expect(result.result.checkpoint_note).toBe("Checked current work and assigned the next task.");
    expect(result.result.validation_summary).toBe("No validation run was needed this cycle.");
    expect(result.result.task_creations).toEqual([]);
    expect(result.result.task_assignments).toEqual([]);
  });

  it("defaults checkpoint and validation summaries for legacy lead-cycle results", () => {
    const { checkpoint_note, validation_summary, ...legacy } = baseResult;
    const result = normalizeLeadCycleResult({ ...legacy, summary: "Legacy cycle" });

    expect(result.ok).toBe(true);
    expect(result.result.checkpoint_note).toBe("Legacy cycle");
    expect(result.result.validation_summary).toBe("");
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

  it("parseLeadCycleResultFromText recovers valid lead-cycle JSON from worklab.v2 final_text", () => {
    const wrapped = {
      schema: "worklab.v2",
      stage: "done",
      decision: "approve",
      summary: "Lead cycle completed.",
      details: "",
      final_text: JSON.stringify({ ...baseResult, summary: "Recovered from final_text" }),
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const parsed = parseLeadCycleResultFromText(JSON.stringify(wrapped));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.schema).toBe(LEAD_CYCLE_SCHEMA);
    expect(parsed.result.summary).toBe("Recovered from final_text");
  });

  it("parseLeadCycleResultFromText rejects wrapped lead-cycle JSON with invalid enum values", () => {
    const wrapped = {
      schema: "worklab.v2",
      stage: "done",
      decision: "approve",
      summary: "Lead cycle completed.",
      details: "",
      final_text: JSON.stringify({
        ...baseResult,
        task_creations: [{
          title: "Bad priority",
          instructions: "",
          suggested_agent: "lead",
          depends_on: [],
          acceptance_criteria: [],
          expected_artifact: null,
          priority: "medium",
        }],
        next_review_hint: { after_minutes: 30, after_event: "when a task finishes" },
      }),
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const parsed = parseLeadCycleResultFromText(JSON.stringify(wrapped));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Invalid option/);
  });

  it("synthesizeLeadCycleFailure returns a blocked result", () => {
    const fallback = synthesizeLeadCycleFailure({ summary: "boom", reason: "unparseable" });
    expect(fallback.schema).toBe(LEAD_CYCLE_SCHEMA);
    expect(fallback.goal_status).toBe("blocked");
    expect(fallback.goal_status_reason).toBe("unparseable");
  });
});
