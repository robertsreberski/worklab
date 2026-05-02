import { z } from "zod";
import { DECISIONS, STAGES } from "./decisions.js";

const artifactSchema = z.record(z.string(), z.any()).default({});

const stringListSchema = z.preprocess((value) => {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return value;
}, z.array(z.string()).transform((items) => items.map((item) => item.trim()).filter(Boolean))).default([]);

export const subtaskSchema = z.object({
  title: z.string().trim().min(1),
  instructions: z.string().default(""),
  suggested_agent: z.string().trim().min(1).optional().nullable(),
  required: z.boolean().default(true),
  depends_on: z.array(z.string()).default([]),
  acceptance_criteria: stringListSchema,
  expected_artifact: z.string().optional().nullable(),
}).passthrough();

const questionOptionSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const label = value.trim();
    return { id: label, label, description: "" };
  }
  return value;
}, z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().optional().default(""),
}));

export const pendingQuestionSchema = z.object({
  id: z.string().trim().min(1),
  header: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z.array(questionOptionSchema).min(2).max(4),
  multi_select: z.boolean().optional().default(false),
  allow_free_text: z.boolean().optional().default(false),
});

// R6: optional planner-side request to override the parent task's
// review policy when delegating. The watcher consults this on a successful
// `decision: delegate` and writes the resolved value to
// `tasks.parent_review_policy`. Unrecognised values fall back to the
// watcher-derived default (`skip_when_qa_child` when a QA child is present,
// else `default`).
export const PARENT_REVIEW_POLICY_VALUES = ["default", "skip_when_qa_child", "always_skip"];

const parentReviewPolicySchema = z.preprocess((value) => {
  if (value == null || value === "") return undefined;
  if (typeof value === "string") return value.trim();
  return value;
}, z.string().min(1).optional());

export const worklabResultSchema = z.object({
  schema: z.literal("worklab.v2"),
  stage: z.enum(STAGES).optional(),
  decision: z.enum(DECISIONS),
  summary: z.string().default(""),
  details: z.string().optional().default(""),
  final_text: z.string().optional().default(""),
  artifacts: artifactSchema,
  blocking_issues: z.array(z.string()).default([]),
  pending_actions: z.array(z.string()).default([]),
  questions: z.array(pendingQuestionSchema).max(3).default([]),
  subtasks: z.array(subtaskSchema).default([]),
  parent_review_policy: parentReviewPolicySchema,
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
    "final_text",
    "artifacts",
    "blocking_issues",
    "pending_actions",
    "questions",
    "subtasks",
    "parent_review_policy",
  ],
  properties: {
    schema: { type: "string", enum: ["worklab.v2"] },
    stage: { type: "string", enum: STAGES },
    decision: { type: "string", enum: DECISIONS },
    summary: { type: "string" },
    details: { type: "string" },
    final_text: { type: "string" },
    artifacts: { type: "object", additionalProperties: false, properties: {}, required: [] },
    blocking_issues: { type: "array", items: { type: "string" } },
    pending_actions: { type: "array", items: { type: "string" } },
    questions: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "header",
          "question",
          "options",
          "multi_select",
          "allow_free_text",
        ],
        properties: {
          id: { type: "string" },
          header: { type: "string" },
          question: { type: "string" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label", "description"],
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
              },
            },
          },
          multi_select: { type: "boolean" },
          allow_free_text: { type: "boolean" },
        },
      },
    },
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
    parent_review_policy: {
      type: ["string", "null"],
      description: `Optional parent review policy request. Recognized values: ${PARENT_REVIEW_POLICY_VALUES.join(", ")}. Unknown values are accepted and resolved by the watcher fallback.`,
    },
  },
};

export function normalizeWorklabResult(value, fallback = {}) {
  const parsed = worklabResultSchema.safeParse({
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    questions: [],
    subtasks: [],
    final_text: "",
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
  const questions = Array.isArray(value.questions) ? value.questions.filter(Boolean) : [];
  const subtasks = Array.isArray(value.subtasks) ? value.subtasks.filter(Boolean) : [];

  if (decision !== "pause" && pendingActions.length > 0) {
    return { ok: false, error: `pending_actions can only be used with decision "pause" (got "${decision}")` };
  }
  if (decision !== "pause" && questions.length > 0) {
    return { ok: false, error: `questions can only be used with decision "pause" (got "${decision}")` };
  }
  if (questions.length > 0 && value.stage !== "plan") {
    return { ok: false, error: "questions can only be used by plan-stage pauses" };
  }
  if (decision === "pause" && pendingActions.length === 0 && questions.length === 0) {
    return { ok: false, error: "pause requires at least one pending_action or question" };
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
  if (!raw) return { ok: false, error: "empty final text", result: null, worklabCandidate: false };
  try {
    const value = JSON.parse(raw);
    const normalized = normalizeWorklabResult(value, fallback);
    if (normalized.ok || value?.schema === "worklab.v2") {
      return { ...normalized, worklabCandidate: value?.schema === "worklab.v2" };
    }
  } catch {
    // Continue with fenced or concatenated JSON payloads.
  }
  const { results, errors, worklabCandidate } = parseWorklabResultCandidates(raw, fallback);
  if (results.length > 0) return { ok: true, error: null, result: results[results.length - 1], worklabCandidate: true };
  if (errors.length > 0) return { ok: false, error: errors[errors.length - 1], result: null, worklabCandidate: true };
  if (worklabCandidate) return { ok: false, error: "malformed worklab_result JSON", result: null, worklabCandidate: true };
  return { ok: false, error: "final text is not JSON", result: null, worklabCandidate: false };
}

function hasWorklabSchemaMarker(text) {
  return /"schema"\s*:\s*"worklab\.v2"/.test(String(text || ""));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUnescapedQuote(text, index) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashCount += 1;
  return slashCount % 2 === 0;
}

function isLooseStringTerminator(text, quoteIndex) {
  let i = quoteIndex + 1;
  while (/\s/.test(text[i] || "")) i += 1;
  if (text[i] === "}") return true;
  if (text[i] !== ",") return false;
  i += 1;
  while (/\s/.test(text[i] || "")) i += 1;
  return /^"[^"]+"\s*:/.test(text.slice(i, i + 120));
}

function escapeLooseStringQuotes(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    out += char === "\"" && isUnescapedQuote(value, i) ? "\\\"" : char;
  }
  return out;
}

function decodeLooseJsonString(value) {
  const escaped = escapeLooseStringQuotes(String(value || "")).replace(/\r?\n/g, "\\n");
  try {
    return JSON.parse(`"${escaped}"`);
  } catch {
    return String(value || "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
}

function readLooseStringProperty(text, key) {
  const raw = String(text || "");
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`, "g");
  const match = re.exec(raw);
  if (!match) return null;
  const start = match.index + match[0].length;
  for (let i = start; i < raw.length; i += 1) {
    if (raw[i] === "\"" && isUnescapedQuote(raw, i) && isLooseStringTerminator(raw, i)) {
      return decodeLooseJsonString(raw.slice(start, i));
    }
  }
  return null;
}

function emptyArrayPropertyOrMissing(text, key) {
  const raw = String(text || "");
  const property = new RegExp(`"${escapeRegExp(key)}"\\s*:`);
  if (!property.test(raw)) return true;
  const empty = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*\\[\\s*\\]`);
  return empty.test(raw);
}

function recoverMalformedReviewResult(candidate, fallback = {}, parseError = null) {
  const error = parseError?.message ? `malformed worklab_result JSON: ${parseError.message}` : "malformed worklab_result JSON";
  if (!hasWorklabSchemaMarker(candidate)) return { ok: false, error };
  const schema = readLooseStringProperty(candidate, "schema");
  const stage = readLooseStringProperty(candidate, "stage");
  const decision = readLooseStringProperty(candidate, "decision");
  if (schema !== "worklab.v2" || stage !== "review" || !["approve", "reject"].includes(decision)) {
    return { ok: false, error };
  }
  if (
    !emptyArrayPropertyOrMissing(candidate, "blocking_issues")
    || !emptyArrayPropertyOrMissing(candidate, "pending_actions")
    || !emptyArrayPropertyOrMissing(candidate, "subtasks")
  ) {
    return { ok: false, error };
  }
  return normalizeWorklabResult({
    schema,
    stage,
    decision,
    summary: readLooseStringProperty(candidate, "summary") || (decision === "approve" ? "Approved" : "Rejected"),
    details: readLooseStringProperty(candidate, "details") || "",
    final_text: readLooseStringProperty(candidate, "final_text") || "",
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    questions: [],
    subtasks: [],
  }, fallback);
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
  return parseWorklabResultCandidates(text, fallback).results;
}

function parseWorklabResultCandidates(text, fallback = {}) {
  const results = [];
  const errors = [];
  let worklabCandidate = hasWorklabSchemaMarker(text);
  for (const candidate of collectTextJsonCandidates(text)) {
    try {
      const value = JSON.parse(candidate);
      const normalized = normalizeWorklabResult(value, fallback);
      if (normalized.ok) results.push(normalized.result);
      else if (value?.schema === "worklab.v2") errors.push(normalized.error);
    } catch (err) {
      if (hasWorklabSchemaMarker(candidate)) {
        worklabCandidate = true;
        const recovered = recoverMalformedReviewResult(candidate, fallback, err);
        if (recovered.ok) results.push(recovered.result);
        else errors.push(recovered.error);
      }
    }
  }
  return { results, errors, worklabCandidate };
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
    "structured_output",
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
  const finalText = typeof value.final_text === "string" ? value.final_text.trim() : "";
  if (finalText) return finalText;
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
  let cleaned = raw
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, (match, body) => {
      const results = parseWorklabResultsFromText(body);
      return results.length > 0 ? "" : match;
    })
    .trim();
  for (const candidate of extractJsonObjectStrings(cleaned)) {
    const results = parseWorklabResultsFromText(candidate);
    if (results.length > 0) cleaned = cleaned.replace(candidate, "");
  }
  return cleaned.trim();
}

export function synthesizeWorklabResult({ stage = "execute", decision = "advance", summary = "", details = "", final_text = "" } = {}) {
  return {
    schema: "worklab.v2",
    stage,
    decision,
    summary,
    details,
    final_text,
    artifacts: {},
    blocking_issues: [],
    pending_actions: [],
    questions: [],
    subtasks: [],
  };
}
