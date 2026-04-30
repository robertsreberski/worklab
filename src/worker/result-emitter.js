// Result-shaping helpers used by the worker entry point. Pulled out of
// worker.js so the big `main()` reads as orchestration; the parsing
// produces canonical worklab_result shapes from raw provider responses.
//
// Phase 5 first slice — the worker's mode-specific runners (execute, review,
// consolidate, automation) still live inline in worker.js because they
// share heavy state with `main()`. Future passes will lift them out.

import { parseVerdict } from "../core/review.js";
import {
  normalizeWorklabResult,
  parseWorklabResultFromText,
  synthesizeWorklabResult,
  validateWorklabResultSemantics,
} from "../ai/result/contract.js";

export function validateRuntimeResult(result) {
  const validated = validateWorklabResultSemantics(result);
  if (validated.ok) return { result, error: null, fatal: false };
  return { result, error: validated.error, fatal: true };
}

export function resultFromTextOrFallback(text, fallback) {
  const parsed = parseWorklabResultFromText(text, fallback);
  if (parsed.ok) return validateRuntimeResult(parsed.result);
  if (!String(text || "").trim()) {
    return { result: null, error: "missing final output", fatal: true };
  }
  return { result: synthesizeWorklabResult({ ...fallback, details: text || "" }), error: parsed.error };
}

export function resultFromResponseOrFallback(response, fallback) {
  if (response?.worklabResult) {
    const normalized = normalizeWorklabResult(response.worklabResult, fallback);
    if (normalized.ok) {
      return {
        ...validateRuntimeResult(normalized.result),
        source: response.structuredResultSource || "structured",
      };
    }
    return { result: null, error: normalized.error, fatal: true, source: response.structuredResultSource || "structured" };
  }
  return resultFromTextOrFallback(response?.text || "", fallback);
}

export function reviewResultFromText(text) {
  const parsed = parseWorklabResultFromText(text, { stage: "review" });
  if (parsed.ok) {
    const validated = validateRuntimeResult(parsed.result);
    return {
      ...validated,
      verdict: parsed.result.decision === "approve" ? "APPROVE" : parsed.result.decision === "reject" ? "REJECT" : null,
      notes: parsed.result.details || parsed.result.summary || "",
    };
  }

  const { verdict, notes } = parseVerdict(text);
  if (verdict === "APPROVE") {
    return {
      result: synthesizeWorklabResult({ stage: "review", decision: "approve", summary: notes || "Approved", details: text || "" }),
      verdict,
      notes,
      error: parsed.error,
    };
  }
  if (verdict === "REJECT") {
    return {
      result: synthesizeWorklabResult({ stage: "review", decision: "reject", summary: notes || "Rejected", details: text || "" }),
      verdict,
      notes,
      error: parsed.error,
    };
  }
  return { result: null, verdict: null, notes: "", error: parsed.error };
}

export function reviewResultFromResponse(response) {
  if (response?.worklabResult) {
    const normalized = normalizeWorklabResult(response.worklabResult, { stage: "review" });
    if (normalized.ok) {
      const result = normalized.result;
      return {
        ...validateRuntimeResult(result),
        verdict: result.decision === "approve" ? "APPROVE" : result.decision === "reject" ? "REJECT" : null,
        notes: result.details || result.summary || "",
        source: response.structuredResultSource || "structured",
      };
    }
    return { result: null, verdict: null, notes: "", error: normalized.error, fatal: true, source: response.structuredResultSource || "structured" };
  }
  return reviewResultFromText(response?.text || "");
}
