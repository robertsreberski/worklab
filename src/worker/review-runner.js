// Review mode has the same tool allowlist as execute. We document — but do not
// enforce — that reviewers should not call kb_delete. Enforcement via per-tool
// permissions is Phase 4+.
import {
  buildTaskRunInput,
  generateResponse,
  resolveModel,
} from "../core/index.js";
import { parseVerdict } from "../core/review.js";
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

export async function runReview(ctx) {
  const { db, config, ac, emit, liveInput, agentName, runId, taskId } = ctx;

  let input;
  try {
    input = buildTaskRunInput({
      config,
      db,
      taskId,
      agentName,
      runId,
      mode: "review",
      priorRunId: process.env.WORKLAB_PRIOR_RUN_ID,
      worklabToolSurfaceMarkdown: ctx.worklabToolSurfaceMarkdown,
    });
  } catch (err) {
    return { kind: "review", error: err.message || String(err) };
  }
  const { agent, skills, skillDirs, mcpServers, allowedTools, disallowedTools, systemPrompt, messages } = input;
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
      executionMode: agent.execution_mode || "sdk",
      db,
      dataDir: config.dataDir,
      skills,
      skillDirs,
      messages,
      cwd: config.workspace,
      mcpServers,
      allowedTools,
      disallowedTools,
      permissionMode: "bypassPermissions",
      maxTurns: maxTurnsForModel(model, 30),
      outputSchema: WORKLAB_RESULT_JSON_SCHEMA,
      runArtifactDir: input.qaOutputDir,
      abortSignal: ac.signal,
      liveInput,
      onEvent: sdkEvents.emit,
    });
    if (result.cancelled) return { kind: "review", cancelled: true, providerSessionId: result.providerSessionId || null };
    if (result.error) {
      return {
        kind: "review",
        error: result.error,
        failureKind: result.failureKind,
        errorDetails: result.errorDetails || null,
        providerSessionId: result.providerSessionId || null,
        runtimeWarnings: result.runtimeWarnings,
      };
    }
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
  } catch (err) {
    return { kind: "review", error: err.message || String(err) };
  } finally {
    sdkEvents.flush();
  }
}
