import { formatWorklabResultText, stripWorklabResultJson } from "./worklab-result/contract.js";

/**
 * Pure helpers for extracting execution metadata from a prior run's agent_log events.
 * No I/O, no side effects — only data shaping.
 */

/**
 * Extract execution summary from a prior run's agent_log events.
 *
 * Finds the LAST `final` event in the events array. If the prior run has no
 * `final` event (e.g. was cancelled or errored early), the returned object
 * uses safe zero-value defaults — the reviewer still runs, it just sees
 * "no final text".
 *
 * @param {Array} priorEvents - Parsed event objects from agent_logs.events JSON.
 * @param {{ agent_name: string }} priorRun - The task_runs row for the prior run.
 *   If null/undefined, throws a TypeError (caller should guard).
 * @returns {{
 *   runId: string | null,
 *   agentName: string,
 *   finalText: string,
 *   events: Array,
 *   numTurns: number,
 *   durationMs: number,
 * }}
 */
export function extractExecutionFromEvents(priorEvents, priorRun) {
  if (priorRun == null) {
    throw new TypeError("priorRun must not be null or undefined");
  }

  const events = Array.isArray(priorEvents) ? priorEvents : [];

  // Find the last `final` event (reverse-scan so multiple finals keep last).
  const finalEvent = [...events].reverse().find((e) => e && e.type === "final");
  const deliveredText = stripWorklabResultJson(finalEvent?.text ?? "");
  const finalText = deliveredText || (finalEvent?.worklab_result
    ? formatWorklabResultText(finalEvent.worklab_result)
    : "");

  return {
    runId: priorRun.id ?? null,
    agentName: priorRun.agent_name ?? "unknown",
    finalText,
    events,
    numTurns: finalEvent?.numTurns ?? 0,
    durationMs: finalEvent?.durationMs ?? 0,
  };
}
