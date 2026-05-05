// Sibling contract to worklab.v2: structured output produced by a team
// lead's lead_cycle run. The watcher converts a successful lead-cycle
// result into existing side-effects: task_assignments[] assign owner_agent on
// existing unowned team tasks; task_creations[] become subtasks of the
// synthetic root via createDelegatedSubtasks; advisory_notes[] become system
// comments on the named tasks; goal_status flips the synthetic root's
// goal_status / last_lead_at metadata.

import { z } from "zod";

export const LEAD_CYCLE_SCHEMA = "worklab.lead_cycle.v1";
export const LEAD_GOAL_STATUSES = ["in_progress", "complete", "blocked"];
export const LEAD_TASK_PRIORITIES = ["high", "normal", "low"];
export const LEAD_NOTE_KINDS = ["warning", "suggestion", "blocker_observation"];
export const LEAD_REVIEW_AFTER_EVENTS = ["task_completed", "task_blocked"];

const stringList = z.preprocess((value) => {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return value;
}, z.array(z.string()).transform((items) => items.map((item) => item.trim()).filter(Boolean))).default([]);

export const leadTaskCreationSchema = z.object({
  title: z.string().trim().min(1),
  instructions: z.string().default(""),
  suggested_agent: z.string().trim().min(1),
  depends_on: z.array(z.string()).default([]),
  acceptance_criteria: stringList,
  expected_artifact: z.string().optional().nullable(),
  priority: z.enum(LEAD_TASK_PRIORITIES).default("normal"),
}).passthrough();

export const leadAdvisoryNoteSchema = z.object({
  target_task_id: z.string().trim().min(1),
  kind: z.enum(LEAD_NOTE_KINDS),
  content: z.string().trim().min(1),
}).passthrough();

export const leadTaskAssignmentSchema = z.object({
  target_task_id: z.string().trim().min(1),
  owner_agent: z.string().trim().min(1),
  rationale: z.string().default(""),
}).passthrough();

const reviewHintSchema = z.object({
  after_minutes: z.number().int().positive().optional().nullable(),
  after_event: z.enum(LEAD_REVIEW_AFTER_EVENTS).optional().nullable(),
}).partial().nullable().default(null);

export const leadCycleResultSchema = z.object({
  schema: z.literal(LEAD_CYCLE_SCHEMA),
  goal_status: z.enum(LEAD_GOAL_STATUSES),
  goal_status_reason: z.string().default(""),
  summary: z.string().trim().min(1),
  task_creations: z.array(leadTaskCreationSchema).default([]),
  task_assignments: z.array(leadTaskAssignmentSchema).default([]),
  advisory_notes: z.array(leadAdvisoryNoteSchema).default([]),
  next_review_hint: reviewHintSchema,
}).passthrough();

export const WORKLAB_LEAD_CYCLE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "goal_status",
    "goal_status_reason",
    "summary",
    "task_creations",
    "task_assignments",
    "advisory_notes",
    "next_review_hint",
  ],
  properties: {
    schema: { type: "string", enum: [LEAD_CYCLE_SCHEMA] },
    goal_status: { type: "string", enum: LEAD_GOAL_STATUSES },
    goal_status_reason: { type: "string" },
    summary: { type: "string" },
    task_creations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "instructions",
          "suggested_agent",
          "depends_on",
          "acceptance_criteria",
          "expected_artifact",
          "priority",
        ],
        properties: {
          title: { type: "string" },
          instructions: { type: "string" },
          suggested_agent: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          expected_artifact: { type: ["string", "null"] },
          priority: { type: "string", enum: LEAD_TASK_PRIORITIES },
        },
      },
    },
    task_assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target_task_id", "owner_agent", "rationale"],
        properties: {
          target_task_id: { type: "string" },
          owner_agent: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
    advisory_notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target_task_id", "kind", "content"],
        properties: {
          target_task_id: { type: "string" },
          kind: { type: "string", enum: LEAD_NOTE_KINDS },
          content: { type: "string" },
        },
      },
    },
    next_review_hint: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        after_minutes: { type: ["integer", "null"] },
        after_event: {
          anyOf: [
            { type: "string", enum: LEAD_REVIEW_AFTER_EVENTS },
            { type: "null" },
          ],
        },
      },
    },
  },
};

export const LEAD_CYCLE_MAX_TASK_CREATIONS = 8;

function maxTaskCreationsForContext(ctx = {}) {
  const value = Number(ctx.maxTaskCreations);
  return Number.isInteger(value) && value > 0 ? value : LEAD_CYCLE_MAX_TASK_CREATIONS;
}

export function normalizeLeadCycleResult(value, fallback = {}) {
  const parsed = leadCycleResultSchema.safeParse({
    task_creations: [],
    task_assignments: [],
    advisory_notes: [],
    next_review_hint: null,
    ...fallback,
    ...(value || {}),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
      result: null,
    };
  }
  return { ok: true, result: parsed.data, error: null };
}

// Semantic checks beyond shape: roster membership, completion implies no new
// task creations, advisory targets must belong to the (team, project) scope,
// and a hard cap on how many tasks one cycle can spawn.
export function validateLeadCycleSemantics(result, ctx = {}) {
  const value = result?.lead_cycle_result || result;
  if (!value || value.schema !== LEAD_CYCLE_SCHEMA) {
    return { ok: false, error: "missing lead_cycle_result" };
  }
  const creations = Array.isArray(value.task_creations) ? value.task_creations : [];
  const assignments = Array.isArray(value.task_assignments) ? value.task_assignments : [];
  const notes = Array.isArray(value.advisory_notes) ? value.advisory_notes : [];
  const maxTaskCreations = maxTaskCreationsForContext(ctx);

  if (creations.length > maxTaskCreations) {
    return { ok: false, error: `too many task_creations (max ${maxTaskCreations})` };
  }

  if (value.goal_status === "complete" && creations.length > 0) {
    return { ok: false, error: 'goal_status="complete" cannot include task_creations' };
  }

  if (value.goal_status !== "in_progress" && !value.goal_status_reason) {
    return { ok: false, error: `goal_status="${value.goal_status}" requires goal_status_reason` };
  }

  if (Array.isArray(ctx.rosterAgents) && ctx.rosterAgents.length) {
    const roster = new Set(ctx.rosterAgents);
    const creationOffenders = creations
      .map((item) => String(item?.suggested_agent || "").trim())
      .filter((name) => name && !roster.has(name));
    if (creationOffenders.length) {
      return {
        ok: false,
        error: `suggested_agent outside team roster: ${creationOffenders.map((n) => `"${n}"`).join(", ")}`,
        offenders: creationOffenders,
      };
    }
    const assignmentOffenders = assignments
      .map((item) => String(item?.owner_agent || "").trim())
      .filter((name) => name && !roster.has(name));
    if (assignmentOffenders.length) {
      return {
        ok: false,
        error: `owner_agent outside team roster: ${assignmentOffenders.map((n) => `"${n}"`).join(", ")}`,
        offenders: assignmentOffenders,
      };
    }
  }

  if (Array.isArray(ctx.assignableTaskIds)) {
    const assignable = new Set(ctx.assignableTaskIds);
    const offenders = assignments
      .map((assignment) => String(assignment?.target_task_id || "").trim())
      .filter((id) => id && !assignable.has(id));
    if (offenders.length) {
      return {
        ok: false,
        error: `task_assignments target tasks outside assignable task queue: ${offenders.join(", ")}`,
        offenders,
      };
    }
  }

  if (Array.isArray(ctx.scopeTaskIds) && ctx.scopeTaskIds.length) {
    const scope = new Set(ctx.scopeTaskIds);
    const offenders = notes
      .map((note) => String(note?.target_task_id || "").trim())
      .filter((id) => id && !scope.has(id));
    if (offenders.length) {
      return {
        ok: false,
        error: `advisory_notes target tasks outside team scope: ${offenders.join(", ")}`,
        offenders,
      };
    }
  }

  return { ok: true, error: null };
}

export function parseLeadCycleResultFromText(text, fallback = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "empty final text", result: null };
  try {
    const parsed = JSON.parse(raw);
    return normalizeLeadCycleResult(parsed, fallback);
  } catch {
    // Fall through to fenced/embedded JSON extraction.
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return normalizeLeadCycleResult(JSON.parse(fenced[1]), fallback);
    } catch {
      // ignore
    }
  }
  return { ok: false, error: "could not parse lead_cycle_result JSON", result: null };
}

export function synthesizeLeadCycleFailure({ summary = "Lead cycle failed", reason = "" } = {}) {
  return {
    schema: LEAD_CYCLE_SCHEMA,
    goal_status: "blocked",
    goal_status_reason: reason || summary,
    summary,
    task_creations: [],
    task_assignments: [],
    advisory_notes: [],
    next_review_hint: null,
  };
}
