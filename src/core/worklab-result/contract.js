import { z } from "zod";
import { DECISIONS, STAGES } from "./decisions.js";

const artifactSchema = z.record(z.string(), z.any()).default({});
const artifactEntrySchema = z.object({
  key: z.string().trim().min(1),
  content: z.string().default(""),
  description: z.string().optional().default(""),
  media_type: z.string().optional().default("text/plain"),
});

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
export const MEMORY_CANDIDATE_KINDS = ["fact", "preference", "procedure", "failure", "decision", "episode"];
export const MEMORY_CANDIDATE_SCOPES = ["agent", "project", "task", "global"];
export const VERIFICATION_EVIDENCE_KINDS = ["test", "build", "lint", "manual_check", "screenshot", "n_a"];

const verificationEvidenceSchema = z.object({
  kind: z.enum(VERIFICATION_EVIDENCE_KINDS),
  command_or_url: z.string().trim().optional().default(""),
  exit_code_or_status: z.string().trim().optional().default(""),
  snippet: z.string().optional().default(""),
  reason: z.string().optional().default(""),
}).passthrough();

const memoryCandidateSchema = z.object({
  kind: z.enum(MEMORY_CANDIDATE_KINDS).default("fact"),
  scope: z.enum(MEMORY_CANDIDATE_SCOPES).default("agent"),
  content: z.string().trim().min(1),
  evidence: z.string().optional().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});

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
  artifact_entries: z.array(artifactEntrySchema).default([]),
  blocking_issues: z.array(z.string()).default([]),
  pending_actions: z.array(z.string()).default([]),
  questions: z.array(pendingQuestionSchema).max(3).default([]),
  subtasks: z.array(subtaskSchema).default([]),
  parent_review_policy: parentReviewPolicySchema,
  memory_candidates: z.array(memoryCandidateSchema).default([]),
  verification_evidence: z.array(verificationEvidenceSchema).default([]),
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
    "artifact_entries",
    "blocking_issues",
    "pending_actions",
    "questions",
    "subtasks",
    "parent_review_policy",
    "memory_candidates",
    "verification_evidence",
  ],
  properties: {
    schema: { type: "string", enum: ["worklab.v2"] },
    stage: { type: "string", enum: STAGES },
    decision: { type: "string", enum: DECISIONS },
    summary: { type: "string" },
    details: { type: "string" },
    final_text: { type: "string" },
    artifacts: { type: "object", additionalProperties: false, properties: {}, required: [] },
    artifact_entries: {
      type: "array",
      description: "Named textual deliverables. Use this for dynamic artifact keys that cannot be expressed as JSON-schema object properties; Worklab normalizes each entry into artifacts[key]. Do not claim artifacts.<key> unless an entry with that key is present.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "content", "description", "media_type"],
        properties: {
          key: { type: "string" },
          content: { type: "string" },
          description: { type: "string" },
          media_type: { type: "string" },
        },
      },
    },
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
    memory_candidates: {
      type: "array",
      description: "Optional durable learnings from this run. Use sparingly for facts, preferences, procedures, failures, decisions, or episodes that should help future runs.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "scope", "content", "evidence", "confidence"],
        properties: {
          kind: { type: "string", enum: MEMORY_CANDIDATE_KINDS },
          scope: { type: "string", enum: MEMORY_CANDIDATE_SCOPES },
          content: { type: "string" },
          evidence: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    verification_evidence: {
      type: "array",
      description: "Reviewer evidence for an approve decision: each row records what was actually checked. Include the exact command_or_url that was run (so the coordinator can cross-reference the tool log), the exit_code_or_status, and a short snippet of the output. Use kind='n_a' with a reason for tasks that genuinely don't need verification (pure docs, research).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "command_or_url", "exit_code_or_status", "snippet", "reason"],
        properties: {
          kind: { type: "string", enum: VERIFICATION_EVIDENCE_KINDS },
          command_or_url: { type: "string" },
          exit_code_or_status: { type: "string" },
          snippet: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function withArtifactEntriesMerged(value) {
  if (!isRecord(value)) return value;
  const artifactEntries = Array.isArray(value.artifact_entries) ? value.artifact_entries : [];
  if (artifactEntries.length === 0) return value;
  const artifacts = isRecord(value.artifacts) ? { ...value.artifacts } : {};
  for (const entry of artifactEntries) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key) continue;
    artifacts[key] = entry.content ?? "";
  }
  return { ...value, artifacts };
}

export function normalizeWorklabResult(value, fallback = {}) {
  const source = withArtifactEntriesMerged(value || {});
  const parsed = worklabResultSchema.safeParse({
    artifacts: {},
    artifact_entries: [],
    blocking_issues: [],
    pending_actions: [],
    questions: [],
    subtasks: [],
    verification_evidence: [],
    final_text: "",
    ...fallback,
    ...source,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
      result: null,
    };
  }
  return { ok: true, result: withArtifactEntriesMerged(parsed.data), error: null };
}

const ARTIFACT_REF_RE = /\bartifacts?\.([A-Za-z0-9_-]+)\b/g;

function artifactReferencesInText(text, out) {
  const raw = String(text || "");
  let match;
  ARTIFACT_REF_RE.lastIndex = 0;
  while ((match = ARTIFACT_REF_RE.exec(raw))) {
    if (match[1]) out.add(match[1]);
  }
}

function parseTodoState(value) {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function completedTodoArtifactReferences(todoState, out) {
  const state = parseTodoState(todoState);
  const todos = Array.isArray(state?.todos) ? state.todos : [];
  for (const todo of todos) {
    if (!isRecord(todo) || todo.status !== "completed") continue;
    artifactReferencesInText(todo.content, out);
    artifactReferencesInText(todo.active_form, out);
  }
}

function hasDeliveredArtifact(artifacts, key) {
  if (!isRecord(artifacts) || !Object.prototype.hasOwnProperty.call(artifacts, key)) return false;
  const value = artifacts[key];
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function claimedArtifactKeys(value, { todoState = null } = {}) {
  const claims = new Set();
  artifactReferencesInText(value.summary, claims);
  artifactReferencesInText(value.details, claims);
  artifactReferencesInText(value.final_text, claims);
  completedTodoArtifactReferences(todoState, claims);
  return [...claims].sort();
}

export function validateWorklabResultSemantics(result, options = {}) {
  const value = withArtifactEntriesMerged(result?.worklab_result || result);
  if (!value || value.schema !== "worklab.v2") {
    return { ok: false, error: "missing worklab_result" };
  }
  const decision = value.decision;
  const pendingActions = Array.isArray(value.pending_actions) ? value.pending_actions.filter(Boolean) : [];
  const questions = Array.isArray(value.questions) ? value.questions.filter(Boolean) : [];
  const subtasks = Array.isArray(value.subtasks) ? value.subtasks.filter(Boolean) : [];

  if (options.allowDelegation === false && (decision === "delegate" || subtasks.length > 0)) {
    return { ok: false, error: "delegation is unavailable for this agent runtime" };
  }

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
  const missingArtifact = claimedArtifactKeys(value, options)
    .find((key) => !hasDeliveredArtifact(value.artifacts, key));
  if (missingArtifact) {
    return {
      ok: false,
      error: `result claims artifacts.${missingArtifact} but result.artifacts.${missingArtifact} is missing`,
    };
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

const STRUCTURED_RESULT_FIELDS = new Set([
  "schema",
  "stage",
  "decision",
  "summary",
  "details",
  "final_text",
  "artifacts",
  "artifact_entries",
  "blocking_issues",
  "pending_actions",
  "questions",
  "subtasks",
  "parent_review_policy",
  "memory_candidates",
]);

const STRUCTURED_JSON_FIELDS = new Set([
  "artifacts",
  "artifact_entries",
  "blocking_issues",
  "pending_actions",
  "questions",
  "subtasks",
  "memory_candidates",
]);

const STRUCTURED_STRING_FIELDS = new Set([
  "schema",
  "stage",
  "decision",
  "summary",
  "details",
  "final_text",
  "parent_review_policy",
]);

function firstNonNegative(values) {
  const sorted = values.filter((value) => Number.isInteger(value) && value >= 0).sort((a, b) => a - b);
  return sorted[0] ?? -1;
}

function cleanStructuredStringField(value, fieldName) {
  if (typeof value !== "string") return value;
  const closeTag = value.indexOf(`</${fieldName}>`);
  const parameterTag = value.search(/<parameter\s+name=/i);
  const invokeTag = value.indexOf("</invoke>");
  const end = firstNonNegative([closeTag, parameterTag, invokeTag]);
  return (end >= 0 ? value.slice(0, end) : value).trim();
}

function parseStructuredParameterValue(field, rawValue) {
  const text = String(rawValue || "").trim();
  if (STRUCTURED_JSON_FIELDS.has(field)) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (STRUCTURED_STRING_FIELDS.has(field)) return cleanStructuredStringField(text, field);
  return undefined;
}

function extractStructuredParameters(text) {
  const raw = String(text || "");
  const params = {};
  const re = /<parameter\s+name=(["'])([^"']+)\1\s*>/gi;
  let match;
  while ((match = re.exec(raw))) {
    const field = match[2];
    if (!STRUCTURED_RESULT_FIELDS.has(field)) continue;
    const start = match.index + match[0].length;
    const nextParameter = raw.slice(start).search(/<parameter\s+name=/i);
    const closeParameter = raw.indexOf("</parameter>", start);
    const closeField = raw.indexOf(`</${field}>`, start);
    const closeInvoke = raw.indexOf("</invoke>", start);
    const relativeNext = nextParameter >= 0 ? start + nextParameter : -1;
    const end = firstNonNegative([closeParameter, closeField, closeInvoke, relativeNext]);
    const value = parseStructuredParameterValue(field, raw.slice(start, end >= 0 ? end : raw.length));
    if (value !== undefined) params[field] = value;
  }
  return params;
}

function hasEmbeddedStructuredParameters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((item) => typeof item === "string" && /<parameter\s+name=/i.test(item));
}

export function recoverStructuredWorklabResult(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== "worklab.v2") return null;
  if (!hasEmbeddedStructuredParameters(value)) return null;
  const recovered = { ...value };
  const lifted = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue !== "string") continue;
    Object.assign(lifted, extractStructuredParameters(fieldValue));
    if (STRUCTURED_STRING_FIELDS.has(field)) {
      recovered[field] = cleanStructuredStringField(fieldValue, field);
    }
  }
  for (const [field, fieldValue] of Object.entries(lifted)) {
    if (!(field in recovered) || recovered[field] == null || recovered[field] === "") {
      recovered[field] = fieldValue;
    }
  }
  return normalizeWorklabResult(recovered, fallback);
}

export function extractWorklabResult(value, fallback = {}) {
  const candidates = [];
  collectWorklabCandidates(value, candidates);
  const candidate = candidates[candidates.length - 1];
  if (!candidate) return { ok: false, error: "no worklab_result found", result: null };
  const recovered = recoverStructuredWorklabResult(candidate, fallback);
  if (recovered?.ok) return recovered;
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
    artifact_entries: [],
    blocking_issues: [],
    pending_actions: [],
    questions: [],
    subtasks: [],
    memory_candidates: [],
    verification_evidence: [],
  };
}
