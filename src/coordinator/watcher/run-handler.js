// Run-completion primitives. Pure helpers used by the watcher's main
// orchestration loop after a worker exits:
//
//   runProcessStatus       — pluck the canonical process_status from a row/result
//   safeParseJson          — tolerant JSON parse with a fallback
//   modeForStage           — map a workflow stage to a worker run mode
//   buildFallbackResult    — synthesize a worklab_result when the run text
//                            had no parseable JSON (review mode preserves
//                            verdict-line semantics; non-review synthesizes
//                            an "advance" only when the run produced text)

import { parseVerdict } from "../../core/review.js";
import { synthesizeWorklabResult } from "../../ai/result/contract.js";

export function runProcessStatus(runOrResult) {
  return runOrResult?.processStatus || runOrResult?.process_status || "running";
}

export function safeParseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function modeForStage(stage) {
  if (stage === "plan") return "plan";
  return stage === "review" ? "review" : "execute";
}

export function buildFallbackResult({ stage, mode, res }) {
  if (stage === "review" || mode === "review") {
    // Worker's reviewResultFromText handles the verdict-line parse already; if
    // we still don't have a worklab_result here it means the reviewer emitted
    // neither valid JSON nor a usable VERDICT line. Returning null causes
    // handleSuccessfulExit to escalate via handleFailedExit (failure_kind
    // "invalid_result"). DO NOT synthesise an "advance" here — that would
    // silently approve the reviewer's broken output.
    const verdictEvent = Array.isArray(res.events)
      ? res.events.find((event) => event?.type === "verdict")
      : null;
    const verdict = verdictEvent?.verdict || parseVerdict(res.finalText).verdict;
    const notes = verdictEvent?.notes || parseVerdict(res.finalText).notes || "";
    if (verdict === "APPROVE") {
      return synthesizeWorklabResult({ stage: "review", decision: "approve", summary: notes || "Approved", details: res.finalText || "" });
    }
    if (verdict === "REJECT") {
      return synthesizeWorklabResult({ stage: "review", decision: "reject", summary: notes || "Rejected", details: res.finalText || "" });
    }
    return null;
  }
  if (!String(res.finalText || "").trim()) return null;
  return synthesizeWorklabResult({
    stage,
    decision: "advance",
    summary: res.finalText ? String(res.finalText).trim().slice(0, 500) : "Run completed",
    details: res.finalText || "",
  });
}
