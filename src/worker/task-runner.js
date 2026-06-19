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
  return { result: null, error: validated.error, fatal: true };
}

function eventContentBlocks(event) {
  const target = event?.type === "sdk_event" && event.event ? event.event : event;
  if (Array.isArray(target?.message?.content)) return target.message.content;
  if (Array.isArray(target?.content)) return target.content;
  return [];
}

function hasNonTerminalToolActivity(event) {
  return eventContentBlocks(event).some((block) => {
    if (block?.type === "tool_result") return true;
    if (block?.type !== "tool_use") return false;
    return block.name !== "StructuredOutput";
  });
}

function terminalCandidateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  let lastToolActivity = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (hasNonTerminalToolActivity(events[i])) lastToolActivity = i;
  }
  return events.slice(lastToolActivity + 1);
}

function resultFromTextOrFallback(text, fallback) {
  const parsed = parseWorklabResultFromText(text, fallback);
  if (parsed.ok) return validateRuntimeResult(parsed.result);
  if (String(text || "").trim()) {
    const lenient = parseWorklabResultLenient(text, fallback);
    if (lenient) {
      const validated = validateRuntimeResult(lenient);
      if (!validated.fatal) return { ...validated, recoveredVia: "lenient" };
    }
  }
  if (!String(text || "").trim()) {
    return { result: null, error: "missing final output", fatal: true };
  }
  if (parsed.worklabCandidate) {
    return { result: null, error: parsed.error, fatal: true };
  }
  return { result: synthesizeWorklabResult({ ...fallback, details: text || "" }), error: parsed.error };
}

function resultFromResponseOrFallback(response, fallback) {
  // Try the provider's structured output first; then scan the event stream
  // (handles CLI providers that surface JSON via assistant messages); finally
  // fall back to parsing the text.
  if (response?.structuredResult !== undefined && response?.structuredResult !== null) {
    const extracted = extractWorklabResult(response.structuredResult, fallback);
    if (extracted.ok) {
      return {
        ...validateRuntimeResult(extracted.result),
        source: response.structuredResultSource || "structured",
      };
    }
    return {
      result: null,
      error: extracted.error,
      fatal: true,
      source: response.structuredResultSource || "structured",
    };
  }
  const finalEvents = terminalCandidateEvents(response?.events);
  if (finalEvents.length > 0) {
    const extracted = extractWorklabResult(finalEvents, fallback);
    if (extracted.ok) {
      return {
        ...validateRuntimeResult(extracted.result),
        source: "event_scan",
      };
    }
  }
  return resultFromTextOrFallback(response?.text || "", fallback);
}

export async function runTask(ctx) {
  const { mode } = ctx;

  const turn = await runTaskAgentTurn(ctx, { kind: "task", mode, outputSchema: WORKLAB_RESULT_JSON_SCHEMA });
  if (turn.terminal) return turn.terminal;
  const { input, result } = turn;
  const { task } = input;
  const parsedResult = resultFromResponseOrFallback(result, {
    stage: task.stage || mode,
    decision: "advance",
    summary: result.text ? String(result.text).trim().slice(0, 500) : "Run completed",
  });
  return {
    kind: "task",
    text: result.text,
    usage: result.usage,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    model: result.model,
    effort: result.effort,
    providerSessionId: result.providerSessionId || null,
    runtimeWarnings: result.runtimeWarnings,
    diagnostics: result.diagnostics || null,
    worklabResult: parsedResult.result,
    parsedResultError: parsedResult.error || null,
    parsedResultFatal: !!parsedResult.fatal,
    parsedResultWarningKind: parsedResult.fatal ? "worklab_result_validation" : "unstructured_result_fallback",
    parsedResultRecoveredVia: parsedResult.recoveredVia || null,
  };
}
