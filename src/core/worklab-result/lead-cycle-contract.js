// Sibling contract to worklab.v2: structured output produced by a team
// lead's lead_cycle run. The watcher converts a successful lead-cycle
// result into existing side-effects: task_assignments[] assign owner_agent on
// existing unowned team tasks; task_creations[] become subtasks of the
// synthetic root via createDelegatedSubtasks; advisory_notes[] become system
// comments on the named tasks; goal_status flips the synthetic root's
// goal_status / last_lead_at metadata.

import { z } from "zod";

export const LEAD_CYCLE_SCHEMA = "worklab.lead_cycle.v1";
const LEAD_GOAL_STATUSES = ["in_progress", "complete", "blocked"];
const LEAD_TASK_PRIORITIES = ["high", "normal", "low"];
const LEAD_NOTE_KINDS = ["warning", "suggestion", "blocker_observation"];
const LEAD_REVIEW_AFTER_EVENTS = ["task_completed", "task_blocked"];
const LEAD_GOAL_REFINEMENT_MODES = ["none", "apply"];
const LEAD_GOAL_REFINEMENT_CONFIDENCES = ["low", "medium", "high"];

const stringList = z.preprocess((value) => {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return value;
}, z.array(z.string()).transform((items) => items.map((item) => item.trim()).filter(Boolean))).default([]);

const leadTaskCreationSchema = z.object({
  title: z.string().trim().min(1),
  instructions: z.string().default(""),
  suggested_agent: z.string().trim().min(1),
  depends_on: z.array(z.string()).default([]),
  acceptance_criteria: stringList,
  expected_artifact: z.string().optional().nullable(),
  priority: z.enum(LEAD_TASK_PRIORITIES).default("normal"),
}).passthrough();

const leadAdvisoryNoteSchema = z.object({
  target_task_id: z.string().trim().min(1),
  kind: z.enum(LEAD_NOTE_KINDS),
  content: z.string().trim().min(1),
}).passthrough();

const leadTaskAssignmentSchema = z.object({
  target_task_id: z.string().trim().min(1),
  owner_agent: z.string().trim().min(1),
  rationale: z.string().default(""),
}).passthrough();

const leadTaskDeletionSchema = z.object({
  target_task_id: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
}).passthrough();

const leadGoalRefinementLinkSchema = z.object({
  label: z.string().default(""),
  url: z.string().default(""),
}).passthrough();

const leadGoalRefinementPatchSchema = z.object({
  north_star: z.string().default(""),
  objective: z.string().default(""),
  stopping_condition: z.string().default(""),
  validation_loop: z.string().default(""),
  constraints_add: stringList,
  links_add: z.array(leadGoalRefinementLinkSchema).default([]),
}).passthrough();

const leadGoalRefinementSchema = z.object({
  mode: z.enum(LEAD_GOAL_REFINEMENT_MODES).default("none"),
  confidence: z.enum(LEAD_GOAL_REFINEMENT_CONFIDENCES).default("low"),
  compatible_expansion: z.boolean().default(false),
  rationale: z.string().default(""),
  patch: leadGoalRefinementPatchSchema.nullable().default(null),
}).passthrough().default({
  mode: "none",
  confidence: "low",
  compatible_expansion: false,
  rationale: "",
  patch: null,
});

const reviewHintSchema = z.object({
  after_minutes: z.number().int().positive().optional().nullable(),
  after_event: z.enum(LEAD_REVIEW_AFTER_EVENTS).optional().nullable(),
}).partial().nullable().default(null);

const leadCycleResultSchema = z.object({
  schema: z.literal(LEAD_CYCLE_SCHEMA),
  goal_status: z.enum(LEAD_GOAL_STATUSES),
  goal_status_reason: z.string().default(""),
  summary: z.string().trim().min(1),
  checkpoint_note: z.string().default(""),
  validation_summary: z.string().default(""),
  task_creations: z.array(leadTaskCreationSchema).default([]),
  task_assignments: z.array(leadTaskAssignmentSchema).default([]),
  task_deletions: z.array(leadTaskDeletionSchema).default([]),
  goal_refinement: leadGoalRefinementSchema,
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
    "checkpoint_note",
    "validation_summary",
    "task_creations",
    "task_assignments",
    "task_deletions",
    "goal_refinement",
    "advisory_notes",
    "next_review_hint",
  ],
  properties: {
    schema: { type: "string", enum: [LEAD_CYCLE_SCHEMA] },
    goal_status: { type: "string", enum: LEAD_GOAL_STATUSES },
    goal_status_reason: { type: "string" },
    summary: { type: "string" },
    checkpoint_note: { type: "string" },
    validation_summary: { type: "string" },
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
    task_deletions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target_task_id", "rationale"],
        properties: {
          target_task_id: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
    goal_refinement: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "confidence", "compatible_expansion", "rationale", "patch"],
      properties: {
        mode: { type: "string", enum: LEAD_GOAL_REFINEMENT_MODES },
        confidence: { type: "string", enum: LEAD_GOAL_REFINEMENT_CONFIDENCES },
        compatible_expansion: { type: "boolean" },
        rationale: { type: "string" },
        patch: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["north_star", "objective", "stopping_condition", "validation_loop", "constraints_add", "links_add"],
          properties: {
            north_star: { type: "string" },
            objective: { type: "string" },
            stopping_condition: { type: "string" },
            validation_loop: { type: "string" },
            constraints_add: { type: "array", items: { type: "string" } },
            links_add: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "url"],
                properties: {
                  label: { type: "string" },
                  url: { type: "string" },
                },
              },
            },
          },
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
      required: ["after_minutes", "after_event"],
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

const LEAD_CYCLE_MAX_TASK_CREATIONS = 8;

export function normalizeLeadTaskTitle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\W_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function maxTaskCreationsForContext(ctx = {}) {
  const value = Number(ctx.maxTaskCreations);
  return Number.isInteger(value) && value > 0 ? value : LEAD_CYCLE_MAX_TASK_CREATIONS;
}

export function normalizeLeadCycleResult(value, fallback = {}) {
  const parsed = leadCycleResultSchema.safeParse({
    task_creations: [],
    task_assignments: [],
    task_deletions: [],
    goal_refinement: {
      mode: "none",
      confidence: "low",
      compatible_expansion: false,
      rationale: "",
      patch: null,
    },
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
  const result = {
    ...parsed.data,
    checkpoint_note: parsed.data.checkpoint_note || parsed.data.summary || "",
    validation_summary: parsed.data.validation_summary || "",
  };
  return { ok: true, result, error: null };
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
  const deletions = Array.isArray(value.task_deletions) ? value.task_deletions : [];
  const notes = Array.isArray(value.advisory_notes) ? value.advisory_notes : [];
  const refinement = value.goal_refinement || { mode: "none" };
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

  if (refinement.mode === "apply") {
    if (refinement.confidence !== "high") {
      return { ok: false, error: "goal_refinement apply requires confidence=high" };
    }
    if (refinement.compatible_expansion !== true) {
      return { ok: false, error: "goal_refinement apply requires compatible_expansion=true" };
    }
    if (!String(refinement.rationale || "").trim()) {
      return { ok: false, error: "goal_refinement apply requires rationale" };
    }
    if (!refinement.patch || typeof refinement.patch !== "object" || Array.isArray(refinement.patch)) {
      return { ok: false, error: "goal_refinement apply requires patch" };
    }
    const patch = refinement.patch;
    const scalarFields = ["north_star", "objective", "stopping_condition", "validation_loop"];
    const hasScalar = scalarFields.some((field) => String(patch[field] || "").trim());
    const hasConstraints = Array.isArray(patch.constraints_add) && patch.constraints_add.some((item) => String(item || "").trim());
    const hasLinks = Array.isArray(patch.links_add) && patch.links_add.some((item) => String(item?.url || "").trim());
    if (!hasScalar && !hasConstraints && !hasLinks) {
      return { ok: false, error: "goal_refinement apply patch is empty" };
    }
    for (const field of scalarFields) {
      const value = String(patch[field] || "").trim();
      if (value.length > 1200) return { ok: false, error: `goal_refinement ${field} is too long` };
    }
    const constraints = Array.isArray(patch.constraints_add) ? patch.constraints_add : [];
    if (constraints.length > 20 || constraints.some((item) => String(item || "").trim().length > 240)) {
      return { ok: false, error: "goal_refinement constraints_add is too large" };
    }
    const links = Array.isArray(patch.links_add) ? patch.links_add : [];
    if (links.length > 20 || links.some((item) => String(item?.url || "").trim().length > 1000 || String(item?.label || "").trim().length > 120)) {
      return { ok: false, error: "goal_refinement links_add is too large" };
    }
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

  if (Array.isArray(ctx.deletableTaskIds)) {
    const deletable = new Set(ctx.deletableTaskIds);
    const offenders = deletions
      .map((deletion) => String(deletion?.target_task_id || "").trim())
      .filter((id) => id && !deletable.has(id));
    if (offenders.length) {
      return {
        ok: false,
        error: `task_deletions target tasks outside deletable task set: ${offenders.join(", ")}`,
        offenders,
      };
    }
  }

  if (Array.isArray(ctx.existingTaskTitles) && ctx.existingTaskTitles.length) {
    const existingTitles = new Set(ctx.existingTaskTitles.map(normalizeLeadTaskTitle).filter(Boolean));
    const offenders = creations
      .map((creation) => String(creation?.title || "").trim())
      .filter((title) => existingTitles.has(normalizeLeadTaskTitle(title)));
    if (offenders.length) {
      return {
        ok: false,
        error: `task_creations duplicates existing task: ${offenders.join(", ")}`,
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

function normalizeLeadCycleCandidate(value, fallback) {
  const normalized = normalizeLeadCycleResult(value, fallback);
  if (normalized.ok) return normalized;
  if (value?.schema === "worklab.v2" && typeof value.final_text === "string" && value.final_text.trim()) {
    try {
      return normalizeLeadCycleResult(JSON.parse(value.final_text), fallback);
    } catch {
      return normalized;
    }
  }
  return normalized;
}

export function parseLeadCycleResultFromText(text, fallback = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "empty final text", result: null };
  try {
    return normalizeLeadCycleCandidate(JSON.parse(raw), fallback);
  } catch {
    // Fall through to fenced/embedded JSON extraction.
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return normalizeLeadCycleCandidate(JSON.parse(fenced[1]), fallback);
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
    task_deletions: [],
    advisory_notes: [],
    next_review_hint: null,
  };
}
