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

export function validateWorklabResultSemantics(result) {
  const value = result?.worklab_result || result;
  if (!value || value.schema !== "worklab.v2") {
    return { ok: false, error: "missing worklab_result" };
  }
  const decision = value.decision;
  const pendingActions = Array.isArray(value.pending_actions) ? value.pending_actions.filter(Boolean) : [];
  const subtasks = Array.isArray(value.subtasks) ? value.subtasks.filter(Boolean) : [];

  if (decision !== "pause" && pendingActions.length > 0) {
    return { ok: false, error: `pending_actions can only be used with decision "pause" (got "${decision}")` };
  }
  if (decision === "pause" && pendingActions.length === 0) {
    return { ok: false, error: "pause requires at least one pending_action" };
  }
  if (decision !== "delegate" && subtasks.length > 0) {
    return { ok: false, error: `subtasks can only be used with decision "delegate" (got "${decision}")` };
  }
  if (decision === "delegate" && subtasks.length === 0) {
    return { ok: false, error: "delegate requires at least one subtask" };
  }

  return { ok: true, error: null };
}

export function parseWorklabResultFromText(text, fallback = {}) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "empty final text", result: null };
  try {
    return normalizeWorklabResult(JSON.parse(raw), fallback);
  } catch {
    const candidates = parseWorklabResultsFromText(raw, fallback);
    if (candidates.length > 0) return { ok: true, error: null, result: candidates[candidates.length - 1] };
    return { ok: false, error: "final text is not JSON", result: null };
  }
}

function extractJsonObjectStrings(text) {
  const raw = String(text || "");
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function collectTextJsonCandidates(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const candidates = [];
  const fencedRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencedRe.exec(raw))) candidates.push(match[1]);
  candidates.push(...extractJsonObjectStrings(raw));
  return candidates;
}

export function parseWorklabResultsFromText(text, fallback = {}) {
  const results = [];
  for (const candidate of collectTextJsonCandidates(text)) {
    try {
      const normalized = normalizeWorklabResult(JSON.parse(candidate), fallback);
      if (normalized.ok) results.push(normalized.result);
    } catch {
      // Ignore non-JSON braces in ordinary prose and keep looking.
    }
  }
  return results;
}

function collectWorklabCandidates(value, out, seen = new Set(), depth = 0) {
  if (value == null || depth > 8) return;
  if (typeof value === "string") {
    out.push(...parseWorklabResultsFromText(value));
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (value.schema === "worklab.v2") {
    out.push(value);
    return;
  }
  if (value.worklab_result) {
    collectWorklabCandidates(value.worklab_result, out, seen, depth + 1);
  }
  if ((value.type === "tool_use" || value.type === "tool_call") && value.name === "StructuredOutput") {
    collectWorklabCandidates(value.input ?? value.arguments, out, seen, depth + 1);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectWorklabCandidates(item, out, seen, depth + 1);
    }
    return;
  }

  const likelyKeys = [
    "result",
    "final_output",
    "output",
    "text",
    "input",
    "arguments",
    "message",
    "content",
    "item",
  ];
  for (const key of likelyKeys) {
    if (!(key in value)) continue;
    collectWorklabCandidates(value[key], out, seen, depth + 1);
  }
}

export function extractWorklabResult(value, fallback = {}) {
  const candidates = [];
  collectWorklabCandidates(value, candidates);
  const candidate = candidates[candidates.length - 1];
  if (!candidate) return { ok: false, error: "no worklab_result found", result: null };
  return normalizeWorklabResult(candidate, fallback);
}

export function formatWorklabResultText(result) {
  const value = result?.worklab_result || result;
  if (!value || value.schema !== "worklab.v2") return "";
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  const details = typeof value.details === "string" ? value.details.trim() : "";
  if (summary && details && summary !== details) return `${summary}\n\n${details}`;
  return details || summary;
}

export function parseStandaloneWorklabResultText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const parsed = normalizeWorklabResult(JSON.parse(raw));
    if (parsed.ok) return parsed.result;
  } catch {
    // Continue with fenced or concatenated JSON payloads.
  }
  const fencedOnly = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fencedOnly) {
    const parsed = parseWorklabResultFromText(fencedOnly[1]);
    return parsed.ok ? parsed.result : null;
  }
  const candidates = extractJsonObjectStrings(raw);
  if (candidates.length === 0) return null;
  let remainder = raw;
  for (const candidate of candidates) remainder = remainder.replace(candidate, "");
  if (remainder.trim()) return null;
  const results = parseWorklabResultsFromText(raw);
  return results[results.length - 1] || null;
}

export function stripWorklabResultJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const standalone = parseStandaloneWorklabResultText(raw);
  if (standalone) return formatWorklabResultText(standalone);
  return raw
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, (match, body) => {
      const results = parseWorklabResultsFromText(body);
      return results.length > 0 ? formatWorklabResultText(results[results.length - 1]) : match;
    })
    .trim();
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
