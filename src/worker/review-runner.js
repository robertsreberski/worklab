// Review mode has the same tool allowlist as execute. We document — but do not
// enforce — that reviewers should not call kb_delete. Enforcement via per-tool
// permissions is Phase 4+.
import { parseVerdict } from "../core/review.js";
import {
  WORKLAB_RESULT_JSON_SCHEMA,
  extractWorklabResult,
  parseWorklabResultFromText,
  synthesizeWorklabResult,
  validateWorklabResultSemantics,
} from "../core/worklab-result/contract.js";
import { parseWorklabResultLenient } from "../core/worklab-result/lenient-parse.js";
import { runTaskAgentTurn } from "./agent-turn.js";

function validateRuntimeResult(result) {
  const validated = validateWorklabResultSemantics(result);
  if (validated.ok) return { result, error: null, fatal: false };
  return { result, error: validated.error, fatal: true };
}

function reviewResultFromText(text) {
  const parsed = parseWorklabResultFromText(text, { stage: "review" });
  if (parsed.ok) {
    const validated = validateRuntimeResult(parsed.result);
    return {
      ...validated,
      verdict: parsed.result.decision === "approve" ? "APPROVE" : parsed.result.decision === "reject" ? "REJECT" : null,
      notes: parsed.result.details || parsed.result.summary || "",
    };
  }

  if (String(text || "").trim()) {
    const lenient = parseWorklabResultLenient(text, { stage: "review" });
    if (lenient && (lenient.decision === "approve" || lenient.decision === "reject")) {
      const validated = validateRuntimeResult(lenient);
      if (!validated.fatal) {
        return {
          ...validated,
          verdict: lenient.decision === "approve" ? "APPROVE" : "REJECT",
          notes: lenient.details || lenient.summary || "",
          recoveredVia: "lenient",
          error: parsed.error,
        };
      }
    }
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

function reviewResultFromResponse(response) {
  if (response?.structuredResult !== undefined && response?.structuredResult !== null) {
    const extracted = extractWorklabResult(response.structuredResult, { stage: "review" });
    if (extracted.ok) {
      const result = extracted.result;
      return {
        ...validateRuntimeResult(result),
        verdict: result.decision === "approve" ? "APPROVE" : result.decision === "reject" ? "REJECT" : null,
        notes: result.details || result.summary || "",
        source: response.structuredResultSource || "structured",
      };
    }
    return {
      result: null, verdict: null, notes: "",
      error: extracted.error, fatal: true,
      source: response.structuredResultSource || "structured",
    };
  }
  if (Array.isArray(response?.events) && response.events.length > 0) {
    const extracted = extractWorklabResult(response.events, { stage: "review" });
    if (extracted.ok) {
      const result = extracted.result;
      return {
        ...validateRuntimeResult(result),
        verdict: result.decision === "approve" ? "APPROVE" : result.decision === "reject" ? "REJECT" : null,
        notes: result.details || result.summary || "",
        source: "event_scan",
      };
    }
  }
  return reviewResultFromText(response?.text || "");
}

export async function runReview(ctx) {
  const turn = await runTaskAgentTurn(ctx, {
    kind: "review",
    mode: "review",
    priorRunId: process.env.WORKLAB_PRIOR_RUN_ID,
    outputSchema: WORKLAB_RESULT_JSON_SCHEMA,
  });
  if (turn.terminal) return turn.terminal;
  const { result } = turn;
  const parsedReview = reviewResultFromResponse(result);
  return {
    kind: "review",
    text: result.text,
    usage: result.usage,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    model: result.model,
    effort: result.effort,
    providerSessionId: result.providerSessionId || null,
    runtimeWarnings: result.runtimeWarnings,
    worklabResult: parsedReview.result,
    verdict: parsedReview.verdict,
    notes: parsedReview.notes,
    parsedResultError: parsedReview.error || null,
    parsedResultFatal: !!parsedReview.fatal,
    parsedResultWarningKind: parsedReview.fatal ? "worklab_result_validation" : "review_result_parse",
    parsedResultFatalMessage: parsedReview.error || "Reviewer did not return a valid worklab_result or verdict",
    parsedResultRecoveredVia: parsedReview.recoveredVia || null,
  };
}
