// Worker mode-runner result emission.
//
// Each runner under src/worker/*-runner.js returns a structured result
// describing the worklab_result it produced (if any), terminal status, and
// any side-effects (memory writes) to surface. This module owns the
// translation from that result into the stdout events main() emits before
// exiting. Streaming events (sdk_event, runtime_warning during the run)
// remain emitted inline by the runner via ctx.emit — only terminal events
// flow through here.
//
// The shape returned by runners is:
//   {
//     kind: "consolidate" | "automation" | "task" | "review",
//     cancelled?: boolean,
//     error?: string,
//     failureKind?: string,
//     text, usage, durationMs, numTurns, model, effort,    // generateResponse fields
//     runtimeWarnings?: array,                              // forwarded warnings
//     worklabResult?: object,                               // task/review only
//     parsedResultError?: string,                           // pre-final runtime_warning
//     parsedResultFatal?: boolean,                          // emit worklab_result_error, exit 1
//     parsedResultWarningKind?: string,                     // warning_kind for parsedResultError
//     parsedResultFatalMessage?: string,                    // override for fatal worklab_result_error
//     verdict?: string|null,                                // review only
//     notes?: string,                                       // review only
//     memoryWritten?: { agent, path },                      // consolidate only
//   }

function emitRuntimeWarnings(emit, response) {
  const warnings = Array.isArray(response?.runtimeWarnings) ? response.runtimeWarnings : [];
  for (const warning of warnings) {
    emit({
      type: "runtime_warning",
      warning_kind: warning?.warning_kind || warning?.warningKind || "runtime",
      message: warning?.message || String(warning || "runtime warning"),
      ts: Date.now(),
    });
  }
}

function providerSessionPayload(result) {
  return result?.providerSessionId ? { provider_session_id: result.providerSessionId } : {};
}

export function emitFinalResult(ctx, result) {
  const { emit } = ctx;

  if (result.cancelled) {
    emit({ type: "cancelled" });
    return 130;
  }
  if (result.error) {
    emit({
      type: "error",
      message: result.error,
      failureKind: result.failureKind,
      ...(result.errorDetails ? { details: result.errorDetails } : {}),
    });
    return 1;
  }

  emitRuntimeWarnings(emit, result);

  if (result.kind === "consolidate") {
    if (result.memoryWritten) {
      emit({ type: "memory_written", agent: result.memoryWritten.agent, path: result.memoryWritten.path });
    }
    emit({
      type: "final",
      text: result.text,
      usage: result.usage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model: result.model,
      effort: result.effort,
      ...providerSessionPayload(result),
    });
    return 0;
  }

  if (result.kind === "automation") {
    emit({
      type: "final",
      text: result.text,
      usage: result.usage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model: result.model,
      effort: result.effort,
      ...providerSessionPayload(result),
    });
    return 0;
  }

  if (result.kind === "task") {
    if (result.parsedResultError) {
      emit({
        type: "runtime_warning",
        warning_kind: result.parsedResultWarningKind,
        message: result.parsedResultError,
      });
    }
    if (result.parsedResultRecoveredVia === "lenient") {
      emit({
        type: "runtime_warning",
        warning_kind: "result_recovered_via_lenient",
        source: "worker",
        message: "worklab_result recovered via lenient parser after strict parse failed",
      });
    }
    if (result.parsedResultFatal || !result.worklabResult) {
      emit({ type: "worklab_result_error", message: result.parsedResultFatalMessage || result.parsedResultError || "Invalid worklab_result" });
      return 1;
    }
    emit({
      type: "final",
      text: result.text,
      worklab_result: result.worklabResult,
      usage: result.usage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model: result.model,
      effort: result.effort,
      ...providerSessionPayload(result),
    });
    return 0;
  }

  if (result.kind === "review") {
    if (result.parsedResultError) {
      emit({
        type: "runtime_warning",
        warning_kind: result.parsedResultWarningKind,
        message: result.parsedResultError,
      });
    }
    if (result.parsedResultRecoveredVia === "lenient") {
      emit({
        type: "runtime_warning",
        warning_kind: "result_recovered_via_lenient",
        source: "worker",
        message: "worklab_result recovered via lenient parser after strict parse failed",
      });
    }
    if (result.parsedResultFatal || !result.worklabResult) {
      emit({
        type: "worklab_result_error",
        message: result.parsedResultFatalMessage || result.parsedResultError || "Reviewer did not return a valid worklab_result or verdict",
      });
      return 1;
    }
    emit({
      type: "final",
      text: result.text,
      worklab_result: result.worklabResult,
      usage: result.usage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      model: result.model,
      effort: result.effort,
      ...providerSessionPayload(result),
    });
    // Always emit verdict (null is valid); process exit reflects runtime
    // success only — coordinator handles invalid semantic output.
    emit({ type: "verdict", verdict: result.verdict, notes: result.notes });
    return 0;
  }

  emit({ type: "error", message: `unknown runner kind: ${result.kind}` });
  return 1;
}
