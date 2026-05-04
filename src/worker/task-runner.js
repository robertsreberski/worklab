import {
  buildTaskRunInput,
  generateResponse,
  resolveModel,
} from "../core/index.js";
import {
  WORKLAB_RESULT_JSON_SCHEMA,
  normalizeWorklabResult,
  parseWorklabResultFromText,
  synthesizeWorklabResult,
  validateWorklabResultSemantics,
} from "../ai/result/contract.js";
import { parseWorklabResultLenient } from "../ai/result/lenient-parse.js";
import { estimateFirstTurnInput } from "../agent/compaction.js";
import { createSdkEventCoalescer } from "./event-coalescer.js";
import { maxTurnsForModel } from "./util.js";

function validateRuntimeResult(result) {
  const validated = validateWorklabResultSemantics(result);
  if (validated.ok) return { result, error: null, fatal: false };
  return { result, error: validated.error, fatal: true };
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

export async function runTask(ctx) {
  const { db, config, ac, emit, liveInput, agentName, runId, taskId, mode } = ctx;

  let input;
  try {
    input = buildTaskRunInput({ config, db, taskId, agentName, runId, mode, worklabToolSurfaceMarkdown: ctx.worklabToolSurfaceMarkdown });
  } catch (err) {
    return { kind: "task", error: err.message || String(err) };
  }
  const { task, agent, skills, skillDirs, mcpServers, allowedTools, disallowedTools, toolPolicy, systemPrompt, messages } = input;
  const model = resolveModel(agent.model);
  const sdkEvents = createSdkEventCoalescer((event) => emit({ type: "sdk_event", event }));
  const firstTurn = estimateFirstTurnInput({ systemPrompt, messages });
  emit({
    type: "prompt_built",
    diagnostics: {
      first_turn_input_tokens: firstTurn.inputTokens,
      first_turn_overhead_tokens: firstTurn.overheadTokens,
      first_turn_input_chars: firstTurn.inputChars,
      first_turn_overhead_chars: firstTurn.overheadChars,
    },
  });

  try {
    const result = await generateResponse(systemPrompt, {
      model,
      effort: agent.effort || "medium",
      db,
      dataDir: config.dataDir,
      skills,
      skillDirs,
      messages,
      cwd: config.workspace,
      mcpServers,
      allowedTools,
      disallowedTools,
      toolPolicy,
      permissionMode: "bypassPermissions",
      maxTurns: maxTurnsForModel(model, 30),
      outputSchema: WORKLAB_RESULT_JSON_SCHEMA,
      runArtifactDir: input.qaOutputDir,
      abortSignal: ac.signal,
      liveInput,
      onEvent: sdkEvents.emit,
    });
    if (result.cancelled) return { kind: "task", cancelled: true, providerSessionId: result.providerSessionId || null };
    if (result.error) {
      return {
        kind: "task",
        error: result.error,
        failureKind: result.failureKind,
        errorDetails: result.errorDetails || null,
        providerSessionId: result.providerSessionId || null,
        runtimeWarnings: result.runtimeWarnings,
      };
    }
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
      worklabResult: parsedResult.result,
      parsedResultError: parsedResult.error || null,
      parsedResultFatal: !!parsedResult.fatal,
      parsedResultWarningKind: parsedResult.fatal ? "worklab_result_validation" : "unstructured_result_fallback",
      parsedResultRecoveredVia: parsedResult.recoveredVia || null,
    };
  } catch (err) {
    return { kind: "task", error: err.message || String(err) };
  } finally {
    sdkEvents.flush();
  }
}
