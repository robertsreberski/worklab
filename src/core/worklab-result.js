import { z } from "zod";
import { DECISIONS, STAGES } from "./state-machine.js";

const artifactSchema = z.record(z.string(), z.any()).default({});

export const subtaskSchema = z.object({
  title: z.string().trim().min(1),
  instructions: z.string().default(""),
  suggested_agent: z.string().trim().min(1).optional().nullable(),
  required: z.boolean().default(true),
  depends_on: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  expected_artifact: z.string().optional().nullable(),
}).passthrough();

export const worklabResultSchema = z.object({
  schema: z.literal("worklab.v2"),
  stage: z.enum(STAGES).optional(),
  decision: z.enum(DECISIONS),
  summary: z.string().default(""),
  details: z.string().optional().default(""),
  artifacts: artifactSchema,
  blocking_issues: z.array(z.string()).default([]),
  pending_actions: z.array(z.string()).default([]),
  subtasks: z.array(subtaskSchema).default([]),
}).passthrough();

export const WORKLAB_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "stage",
    "decision",
    "summary",
    "details",
    "artifacts",
    "blocking_issues",
    "pending_actions",
    "subtasks",
  ],
  properties: {
    schema: { type: "string", enum: ["worklab.v2"] },
    stage: { type: "string", enum: STAGES },
    decision: { type: "string", enum: DECISIONS },
    summary: { type: "string" },
    details: { type: "string" },
    artifacts: { type: "object", additionalProperties: false, properties: {}, required: [] },
    blocking_issues: { type: "array", items: { type: "string" } },
    pending_actions: { type: "array", items: { type: "string" } },
    subtasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "instructions",
          "suggested_agent",
          "required",
          "depends_on",
          "acceptance_criteria",
          "expected_artifact",
        ],
        properties: {
          title: { type: "string" },
          instructions: { type: "string" },
          suggested_agent: { type: ["string", "null"] },
          required: { type: "boolean" },
          depends_on: { type: "array", items: { type: "string" } },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          expected_artifact: { type: ["string", "null"] },
        },
      },
    },
  },
};

export function normalizeWorklabResult(value, fallback = {}) {
  const parsed = worklabResultSchema.safeParse({
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    subtasks: [],
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

export function parseWorklabResultFromText(text, fallback = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "empty final text", result: null };
  try {
    return normalizeWorklabResult(JSON.parse(raw), fallback);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fenced) return { ok: false, error: "final text is not JSON", result: null };
    try {
      return normalizeWorklabResult(JSON.parse(fenced[1]), fallback);
    } catch {
      return { ok: false, error: "fenced final text is not valid JSON", result: null };
    }
  }
}

function firstWorklabCandidate(value, seen = new Set(), depth = 0) {
  if (value == null || depth > 8) return null;
  if (typeof value === "string") {
    const parsed = parseWorklabResultFromText(value);
    return parsed.ok ? parsed.result : null;
  }
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (value.schema === "worklab.v2") return value;
  if (value.worklab_result) {
    const nested = firstWorklabCandidate(value.worklab_result, seen, depth + 1);
    if (nested) return nested;
  }
  if ((value.type === "tool_use" || value.type === "tool_call") && value.name === "StructuredOutput") {
    const nested = firstWorklabCandidate(value.input ?? value.arguments, seen, depth + 1);
    if (nested) return nested;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = firstWorklabCandidate(item, seen, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  const likelyKeys = [
    "result",
    "final_output",
    "output",
    "input",
    "arguments",
    "message",
    "content",
    "item",
  ];
  for (const key of likelyKeys) {
    if (!(key in value)) continue;
    const nested = firstWorklabCandidate(value[key], seen, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function extractWorklabResult(value, fallback = {}) {
  const candidate = firstWorklabCandidate(value);
  if (!candidate) return { ok: false, error: "no worklab_result found", result: null };
  return normalizeWorklabResult(candidate, fallback);
}

export function synthesizeWorklabResult({ stage = "execute", decision = "advance", summary = "", details = "" } = {}) {
  return {
    schema: "worklab.v2",
    stage,
    decision,
    summary,
    details,
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    subtasks: [],
  };
}
