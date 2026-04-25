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
  additionalProperties: true,
  required: ["schema", "decision", "summary"],
  properties: {
    schema: { const: "worklab.v2" },
    stage: { type: "string", enum: STAGES },
    decision: { type: "string", enum: DECISIONS },
    summary: { type: "string" },
    details: { type: "string" },
    artifacts: { type: "object", additionalProperties: true },
    blocking_issues: { type: "array", items: { type: "string" } },
    pending_actions: { type: "array", items: { type: "string" } },
    subtasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["title"],
        properties: {
          title: { type: "string" },
          instructions: { type: "string" },
          suggested_agent: { type: "string" },
          required: { type: "boolean" },
          depends_on: { type: "array", items: { type: "string" } },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          expected_artifact: { type: "string" },
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
