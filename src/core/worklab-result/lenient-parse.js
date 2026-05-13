// Lenient worklab.v2 result parser.
//
// Reviewer runs occasionally return final text that is valid JSON wrapped in
// markdown fences or prefixed by a verdict heading. The strict parser rejects
// those, and without a fallback the harness surfaces an `invalid_result`
// failure with no recovery.
//
// This module exposes a fallback parser that strips fences, finds the largest
// balanced JSON object in the text, and normalises it through the strict
// schema. It is invoked from `src/worker.js` before the harness emits
// `invalid_result`.

import { DECISIONS, STAGES } from "./decisions.js";
import { normalizeWorklabResult } from "./contract.js";

const FENCED_RE = /```(?:[A-Za-z0-9_-]*)?\s*([\s\S]*?)```/g;

function stripFences(text) {
  const raw = String(text || "");
  if (!raw.includes("```")) return raw;
  const fenced = [];
  let match;
  FENCED_RE.lastIndex = 0;
  while ((match = FENCED_RE.exec(raw))) fenced.push(match[1]);
  if (!fenced.length) return raw;
  return [raw.replace(FENCED_RE, " "), ...fenced].join("\n");
}

function findBalancedJsonObjects(text) {
  const raw = String(text || "");
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        out.push(raw.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) { depth = 0; start = -1; }
    }
  }
  return out;
}

function rankCandidate(value) {
  if (!value || typeof value !== "object") return -1;
  if (value.schema === "worklab.v2") return 100 + JSON.stringify(value).length;
  if (DECISIONS.includes(value.decision)) return JSON.stringify(value).length;
  return -1;
}

function pickBestCandidate(candidates) {
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      const score = rankCandidate(value);
      if (score > bestScore) {
        best = value;
        bestScore = score;
      }
    } catch { /* skip unparseable */ }
  }
  return best;
}

export function parseWorklabResultLenient(text, fallback = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const candidates = findBalancedJsonObjects(stripFences(raw));
  if (!candidates.length) return null;
  const value = pickBestCandidate(candidates);
  if (!value || typeof value !== "object") return null;
  if (!DECISIONS.includes(value.decision)) return null;
  const synthesised = {
    ...value,
    schema: "worklab.v2",
    stage: value.stage || fallback.stage,
  };
  if (!STAGES.includes(synthesised.stage)) {
    synthesised.stage = fallback.stage && STAGES.includes(fallback.stage) ? fallback.stage : "review";
  }
  const normalized = normalizeWorklabResult(synthesised, fallback);
  return normalized.ok ? normalized.result : null;
}
