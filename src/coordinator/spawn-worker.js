import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { newAgentLogId } from "../core/ids.js";
// Compat for the legacy task_runs.status column (kept alongside process_status
// so older readers don't see NULLs). New writers go through process_status.
const PROCESS_TO_LEGACY_STATUS = {
  succeeded: "complete",
  failed: "error",
  cancelled: "cancelled",
  abandoned: "error",
  queued: "running",
  running: "running",
};
import { normalizeLiveInputBody } from "../core/live-input.js";
import { classifyFailure, createStderrTail, retryableProviderFailureInfo } from "@worklab/agent-runtime/ai/failure.js";
import { insertSystemComment } from "../core/db/queries/comments.js";
import { newCommentId } from "../core/ids.js";
import { evaluateRunTurnBudget, loadRunTurnBudget } from "../core/run-turn-budget.js";
import { readSettings } from "../core/settings.js";
import { aggregateRunArtifacts, artifactPaths, extractRunArtifacts, runArtifactSummary } from "../core/run-artifacts.js";
import { compactEventsForSqlite } from "../core/run-log-compaction.js";
import { runTodoStateSummary } from "../core/run-todos.js";
import {
  captureGitArtifactState,
  collectGitArtifacts,
  collectQaOutputArtifacts,
  collectWorkspaceDeltaArtifacts,
  createWorkspaceSnapshot,
} from "../core/artifact-collection.js";
import { getRunTodoStateRow, setRunRawOutputPath, setRunTranscriptTail } from "../core/db/queries/runs.js";
import { buildTranscriptTailSnapshot } from "@worklab/agent-runtime/agent/transcript.js";
import {
  CONTEXT_BLOAT_TOP_EVENTS,
  RAW_RESULT_STORAGE_LIMIT,
  compactStorageEvent,
  contentBlocksFromEvent,
  insertTopByChars,
  isBroadGlobUse,
  jsonCharLength,
  makeRawLogPath,
  truncateDisplayEvent,
} from "./spawn-worker/log-events.js";

function isCancellationExit(code, signal) {
  return code === 130 || signal === "SIGTERM" || signal === "SIGINT";
}

function readSettingsSafe(db) {
  try {
    return db ? readSettings(db) : null;
  } catch {
    return null;
  }
}


export function spawnWorker({
  binary,
  args,
  env = {},
  runId,
  taskId,
  broker,
  db,
  logger,
  cancelGraceMs = 5000,
  persistDebounceMs = 250,
  dataDir = env.WORKLAB_DATA_DIR,
  runTimeoutMs = 30 * 60 * 1000,
  runIdleWarningMs = 240 * 1000,
  logInlineLimit = 12_000,
  contextBloatEventChars = 100_000,
  contextBloatTotalChars = 500_000,
  exitCloseGraceMs = 1000,
  stderrTailLimit = 8 * 1024,
  diagnosticsSeed = null,
}) {
  const startedAt = Date.now();
  const workspaceArtifactSnapshot = env.WORKLAB_WORKSPACE
    ? createWorkspaceSnapshot({ workdir: env.WORKLAB_WORKSPACE })
    : null;
  const gitArtifactBefore = env.WORKLAB_WORKSPACE
    ? captureGitArtifactState(env.WORKLAB_WORKSPACE)
    : null;
  const child = spawn("node", [binary, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = [];
  const rawEvents = [];
  const warnings = [];
  let promptDiagnostics = null;
  const stderrTail = createStderrTail({ limit: stderrTailLimit });
  let finalPayload = null;
  let structuredOutputResult = null;
  let errorMessage = null;
  let resultError = null;
  let workerDiagnostics = null;
  let explicitFailureKind = null;
  let errorDetails = null;
  let exitCode = null;
  let exitSignal = null;
  let workerCancelSignal = null;
  let cancelRequested = false;
  let cancelInitiator = null;
  let cancelReason = null;
  let sigkillTimer = null;
  let finalized = false;
  let exitFallbackTimer = null;
  let exitWatchdogFired = false;
  // R5: drained-resume protocol. drainRequested means the coordinator asked
  // the worker to wrap up cleanly; drainAcknowledged means the worker emitted
  // a `drained` stdout event before exiting. drainTimedOut means the
  // coordinator's drain watchdog fired and we fell back to a hard cancel.
  let drainRequested = false;
  let drainAcknowledged = false;
  let drainTimedOut = false;
  let drainTimer = null;
  let persistTimer = null;
  let timeoutTimer = null;
  let idleTimer = null;
  let timedOut = false;
  const logId = newAgentLogId();
  let rawLogPath = null;
  const toolUseNames = new Map();
  const contextBloat = {
    totalEventChars: 0,
    totalToolPayloadChars: 0,
    warningEmitted: false,
    largestEvents: [],
    largestToolEvents: [],
    broadScanEvents: [],
  };
  // Settings-backed turn guardrail. Team/workspace cost budgets run in the
  // watcher budget cascade; this local guard only cancels runaway tool loops
  // by counting tool_result events against explicit runtime settings.
  const budgetThresholds = loadRunTurnBudget(readSettingsSafe(db));
  const budgetState = {
    toolResultsSeen: 0,
    softWarningEmitted: false,
    hardCancelTriggered: false,
  };
  // Trailing-edge debounce window for the in-flight events JSON. Long-running
  // agents emit hundreds of events; rewriting the whole JSON each line is
  // O(N²) bytes written, which can stall WAL on a small disk. The final UPDATE
  // in finalize() always writes the canonical events payload, so the worst
  // case for a crash is losing the last `persistDebounceMs` of events from
  // the live UI feed — the broker still streams every event in real time.

  db.prepare(
    `INSERT INTO agent_logs
      (id, task_run_id, events, status, created_at)
     VALUES (?, ?, '[]', 'running', ?)`,
  ).run(logId, runId, startedAt);

  try {
    rawLogPath = makeRawLogPath(dataDir, runId);
    if (rawLogPath) {
      setRunRawOutputPath(db, runId, rawLogPath);
    }
  } catch (err) {
    rawLogPath = null;
    logger?.warn?.({ err: err.message, runId }, "raw run log initialization failed");
  }

  function flushEvents() {
    db.prepare("UPDATE agent_logs SET events = ? WHERE id = ?").run(JSON.stringify(events), logId);
  }

  function schedulePersist() {
    if (persistTimer || finalized) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (finalized) return;
      flushEvents();
    }, persistDebounceMs);
  }

  function appendRawEvent(event) {
    if (!rawLogPath) return;
    try {
      appendFileSync(rawLogPath, `${JSON.stringify(event)}\n`);
    } catch (err) {
      logger?.warn?.({ err: err.message, runId, rawLogPath }, "raw run log write failed");
      rawLogPath = null;
    }
  }

  function emitEvent(parsed) {
    const rawEvent = compactStorageEvent(
      { ...parsed, _event_seq: parsed._event_seq ?? events.length + 1 },
      { limit: RAW_RESULT_STORAGE_LIMIT },
    );
    rawEvents.push(rawEvent);
    const contextWarning = recordContextPayload(rawEvent);
    appendRawEvent(rawEvent);
    const event = truncateDisplayEvent(rawEvent, { limit: logInlineLimit, rawLogPath });
    events.push(event);
    if (rawEvent.type === "runtime_warning") {
      warnings.push({
        kind: rawEvent.warning_kind || "runtime",
        source: rawEvent.source || null,
        message: typeof rawEvent.message === "string" ? rawEvent.message : "",
        ts: rawEvent.ts || Date.now(),
      });
    }
    schedulePersist();
    broker.broadcast(runId, event);
    broker.broadcast("global", {
      type: "run_progress",
      runId,
      taskId,
      eventSeq: event._event_seq ?? rawEvent._event_seq ?? events.length,
      eventCount: events.length,
      lastEvent: event,
    });
    resetIdleTimer();
    if (contextWarning) emitEvent(contextWarning);
    // Evaluate the run-turn guardrail after the event has been recorded. The
    // check is cheap and idempotent — soft/hard warnings are gated on their
    // own one-shot flags so we never spam the timeline. Hard-tier
    // crossings call terminateChild() inside evaluateBudgetForEvent.
    if (rawEvent.type !== "runtime_warning") {
      const budgetWarning = evaluateBudgetForEvent();
      if (budgetWarning) emitEvent(budgetWarning);
    }
    return { rawEvent, event };
  }

  function mergeWorkerDiagnostics(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    workerDiagnostics = {
      ...(workerDiagnostics || {}),
      ...value,
    };
  }

  function recordContextPayload(rawEvent) {
    if (!rawEvent || rawEvent.type === "runtime_warning") return null;
    const eventChars = jsonCharLength(rawEvent);
    contextBloat.totalEventChars += eventChars;
    insertTopByChars(contextBloat.largestEvents, {
      seq: rawEvent._event_seq,
      type: rawEvent.type || null,
      inner_type: rawEvent.event?.type || null,
      chars: eventChars,
    });

    let largestBlock = null;
    for (const block of contentBlocksFromEvent(rawEvent)) {
      if (block?.type === "tool_use") {
        if (block.id && block.name) toolUseNames.set(block.id, block.name);
        if (isBroadGlobUse(block)) {
          const entry = {
            seq: rawEvent._event_seq,
            tool: block.name,
            pattern: block.input?.pattern || null,
            path: block.input?.path || null,
            chars: jsonCharLength(block.input || {}),
          };
          contextBloat.broadScanEvents.push(entry);
        }
        const inputChars = jsonCharLength(block.input || {});
        if (inputChars > 0) {
          largestBlock = {
            seq: rawEvent._event_seq,
            role: "tool_use",
            tool: block.name || null,
            tool_use_id: block.id || null,
            chars: inputChars,
          };
        }
      }
      if (block?.type === "tool_result") {
        const payloadChars = jsonCharLength(block.content ?? block.output ?? block.result ?? "")
          + jsonCharLength(block.raw_result || {});
        contextBloat.totalToolPayloadChars += payloadChars;
        // Each tool_result counts as one turn for the runtime turn guardrail.
        // Real turns include thinking + tool_use + tool_result; we use the
        // result count as a proxy because it's the only signal that survives
        // the SDK → spawn-worker boundary intact across providers.
        budgetState.toolResultsSeen += 1;
        largestBlock = {
          seq: rawEvent._event_seq,
          role: "tool_result",
          tool: toolUseNames.get(block.tool_use_id) || block.raw_result?.details?.tool || null,
          tool_use_id: block.tool_use_id || null,
          chars: payloadChars,
          is_error: !!block.is_error,
        };
      }
    }
    if (largestBlock) insertTopByChars(contextBloat.largestToolEvents, largestBlock);

    const largeEvent = eventChars >= contextBloatEventChars;
    const largeTotal = contextBloat.totalToolPayloadChars >= contextBloatTotalChars;
    if (contextBloat.warningEmitted || (!largeEvent && !largeTotal)) return null;
    contextBloat.warningEmitted = true;
    const top = contextBloat.largestToolEvents[0] || contextBloat.largestEvents[0] || {};
    const toolLabel = top.tool ? `${top.tool} ` : "";
    return {
      type: "runtime_warning",
      warning_kind: "context_bloat",
      source: "worker",
      message: `${toolLabel}output is large enough to risk exhausting the model context; avoid broad repository scans and use targeted paths.`,
      diagnostics: {
        event_chars: eventChars,
        total_tool_payload_chars: contextBloat.totalToolPayloadChars,
        largest_tool_event: top,
      },
      ts: Date.now(),
    };
  }

  function postBudgetSystemComment(taskIdForComment, body) {
    if (!taskIdForComment || !body) return;
    try {
      insertSystemComment(db, {
        id: newCommentId(),
        taskId: taskIdForComment,
        body,
        createdAt: Date.now(),
      });
    } catch (err) {
      logger?.warn?.({ err: err.message, runId, taskId: taskIdForComment }, "budget system comment insert failed");
    }
  }

  // Invoked after every event so the guardrail sees the latest tool_result
  // count. Returns a runtime_warning event when a
  // threshold is newly crossed, or null when nothing changed. The watcher's
  // emitEvent loop folds the returned event back through itself so the
  // warning appears in the run timeline alongside the event that tripped it.
  // Hard-tier crossings additionally trigger a cancel with
  // initiator="budget", which classifyFailure maps to budget_exceeded via
  // the explicit hint we set here.
  function evaluateBudgetForEvent() {
    if (budgetState.hardCancelTriggered) return null;
    const stats = {
      num_turns: budgetState.toolResultsSeen,
    };
    const evaluation = evaluateRunTurnBudget(budgetThresholds, stats);
    if (!evaluation.soft_warn && !evaluation.hard_pause) return null;

    if (evaluation.hard_pause) {
      budgetState.hardCancelTriggered = true;
      budgetState.softWarningEmitted = true;
      const message = `Run cancelled: ${evaluation.reason}.`;
      if (taskId) postBudgetSystemComment(taskId, message);
      // cancelInitiator="budget" + an explicit failureKind hint guarantees
      // classifyFailure maps this to budget_exceeded regardless of how the
      // worker exits (clean SIGTERM, exit 130, etc).
      cancelRequested = true;
      cancelInitiator = cancelInitiator || "budget";
      cancelReason = cancelReason || evaluation.reason;
      errorMessage = errorMessage || message;
      explicitFailureKind = "budget_exceeded";
      terminateChild();
      return {
        type: "runtime_warning",
        warning_kind: "budget_exceeded",
        source: "budget",
        message,
        diagnostics: {
          tier: "hard",
          stats,
          reasons: evaluation.hard_reasons || [],
          thresholds: budgetThresholds.hard,
        },
        ts: Date.now(),
      };
    }

    if (budgetState.softWarningEmitted) return null;
    budgetState.softWarningEmitted = true;
    const message = `Soft budget threshold crossed: ${evaluation.reason}.`;
    if (taskId) postBudgetSystemComment(taskId, message);
    return {
      type: "runtime_warning",
      warning_kind: "budget_soft",
      source: "budget",
      message,
      diagnostics: {
        tier: "soft",
        stats,
        reasons: evaluation.soft_reasons || [],
        thresholds: budgetThresholds.soft,
      },
      ts: Date.now(),
    };
  }

  function contextBloatDiagnostics() {
    if (
      contextBloat.totalEventChars === 0
      && contextBloat.totalToolPayloadChars === 0
      && contextBloat.broadScanEvents.length === 0
    ) return {};
    const highRisk = contextBloat.warningEmitted
      || contextBloat.totalToolPayloadChars >= contextBloatTotalChars
      || contextBloat.largestEvents.some((event) => event.chars >= contextBloatEventChars);
    return {
      context_risk: highRisk ? "high" : "normal",
      event_chars: contextBloat.totalEventChars,
      tool_payload_chars: contextBloat.totalToolPayloadChars,
      largest_events: contextBloat.largestEvents,
      largest_tool_events: contextBloat.largestToolEvents,
      broad_scan_events: contextBloat.broadScanEvents.slice(0, CONTEXT_BLOAT_TOP_EVENTS),
    };
  }

  function resetIdleTimer() {
    if (!runIdleWarningMs || runIdleWarningMs < 1 || finalized) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (finalized) return;
      // R7: include last_tool_name so the operator can tell whether the worker
      // is genuinely stuck or just waiting on a long-running tool call (e.g.,
      // playwright snapshot). The reviewer's QA flow legitimately sits at
      // browser_snapshot for 90+ s sometimes.
      const lastTool = (() => {
        for (let i = rawEvents.length - 1; i >= 0; i -= 1) {
          const ev = rawEvents[i];
          const target = ev?.type === "sdk_event" && ev.event ? ev.event : ev;
          const blocks = Array.isArray(target?.message?.content) ? target.message.content
            : Array.isArray(target?.content) ? target.content : [];
          for (let j = blocks.length - 1; j >= 0; j -= 1) {
            const block = blocks[j];
            if (block?.type === "tool_use") return block.name || null;
          }
        }
        return null;
      })();
      emitEvent({
        type: "runtime_warning",
        warning_kind: "idle",
        message: lastTool
          ? `No worker events for ${runIdleWarningMs}ms (last tool: ${lastTool}).`
          : `No worker events for ${runIdleWarningMs}ms.`,
        last_tool_name: lastTool,
        ts: Date.now(),
      });
    }, runIdleWarningMs);
    idleTimer.unref?.();
  }

  function terminateChild() {
    try { child.stdin?.end?.(); } catch { /* already closed */ }
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    if (!sigkillTimer) {
      sigkillTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, cancelGraceMs);
      sigkillTimer.unref?.();
    }
  }

  if (runTimeoutMs && runTimeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (finalized) return;
      timedOut = true;
      cancelRequested = true;
      cancelInitiator = cancelInitiator || "worker_timeout";
      cancelReason = cancelReason || `run timed out after ${runTimeoutMs}ms`;
      errorMessage = errorMessage || cancelReason;
      emitEvent({
        type: "runtime_warning",
        warning_kind: "timeout",
        source: "worker",
        message: errorMessage,
        ts: Date.now(),
      });
      terminateChild();
    }, runTimeoutMs);
    timeoutTimer.unref?.();
  }
  resetIdleTimer();

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      logger?.warn?.({ line, err: err.message }, "worker emitted malformed stdout");
      return;
    }
    const { rawEvent } = emitEvent(parsed);
    mergeWorkerDiagnostics(rawEvent.diagnostics);
    const recoveredStructuredResult = worklabResultFromStructuredOutputEvent(rawEvent);
    if (recoveredStructuredResult) structuredOutputResult = recoveredStructuredResult;
    if (rawEvent.type === "final") finalPayload = rawEvent;
    if (rawEvent.type === "error") {
      errorMessage = rawEvent.message;
      explicitFailureKind = rawEvent.failureKind || rawEvent.failure_kind || explicitFailureKind;
      if (rawEvent.details) errorDetails = rawEvent.details;
    }
    if (rawEvent.type === "cancelled") {
      cancelInitiator = cancelInitiator || rawEvent.initiator || rawEvent.cancel_initiator || null;
      cancelReason = cancelReason || rawEvent.reason || rawEvent.cancel_reason || null;
      workerCancelSignal = workerCancelSignal || rawEvent.signal || null;
      if (rawEvent.drained === true) drainAcknowledged = true;
    }
    if (rawEvent.type === "drained") {
      drainAcknowledged = true;
    }
    if (rawEvent.type === "worklab_result_error") {
      resultError = rawEvent.message || "invalid worklab_result";
      explicitFailureKind = "invalid_result";
    }
    if (rawEvent.type === "prompt_built" && rawEvent.diagnostics) {
      promptDiagnostics = { ...(promptDiagnostics || {}), ...rawEvent.diagnostics };
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrTail.push(text);
    logger?.info?.({ runId, stderr: text }, "worker stderr");
  });

  // Capture spawn failures (ENOENT on the binary, EACCES, etc). Without this
  // listener Node would fire 'error' then 'close' with code=null and we would
  // record a generic "exited 0" for what was really a spawn failure.
  child.on("error", (err) => {
    if (!errorMessage) errorMessage = err?.message || String(err);
    logger?.error?.({ err, runId }, "worker child process error");
  });

  function cancel(options = {}) {
    if (cancelRequested) return;
    cancelRequested = true;
    cancelInitiator = options.initiator || cancelInitiator || "user";
    cancelReason = options.reason ?? cancelReason ?? null;
    terminateChild();
  }

  // R5: graceful drain. Send a `worklab_drain` control message to the worker
  // and wait up to `timeoutMs` for it to exit on its own. If the deadline
  // expires we fall through to the regular cancel path (which terminates the
  // child) so the coordinator can still exit; the row is then classified as
  // `cancelled_shutdown` with a `drain_timeout: true` diagnostic.
  function drain({ timeoutMs = 60_000, reason = "coordinator_shutdown" } = {}) {
    if (drainRequested || cancelRequested || finalized) return Promise.resolve();
    drainRequested = true;
    cancelInitiator = cancelInitiator || "coordinator_shutdown";
    cancelReason = cancelReason ?? reason ?? null;
    const deadlineAt = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    const message = {
      type: "worklab_drain",
      reason: reason || "coordinator_shutdown",
      deadline_at: deadlineAt,
    };
    return writeControlMessage(message)
      .catch((err) => {
        logger?.warn?.({ err: err.message, runId }, "drain message could not be delivered");
      })
      .finally(() => {
        if (finalized) return;
        if (drainTimer) clearTimeout(drainTimer);
        drainTimer = setTimeout(() => {
          drainTimer = null;
          if (finalized) return;
          drainTimedOut = true;
          // The drain window expired without a clean exit. Fall back to the
          // normal cancel path so the coordinator can finish shutting down.
          cancel({ initiator: "coordinator_shutdown", reason: "drain timeout" });
        }, Math.max(0, Number(timeoutMs) || 0));
        drainTimer.unref?.();
      });
  }

  function writeControlMessage(payload) {
    return new Promise((resolve, reject) => {
      if (finalized || child.stdin?.destroyed || child.stdin?.writableEnded) {
        reject(new Error("run is no longer accepting input"));
        return;
      }
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function sendLiveMessage(message) {
    const normalized = normalizeLiveInputBody(message?.body);
    if (!normalized.ok) return { ok: false, code: normalized.code, message: normalized.error };
    const payload = {
      type: "live_user_message",
      id: message.id,
      body: normalized.body,
      created_at: message.createdAt || Date.now(),
      author_type: message.authorType || "human",
    };
    try {
      await writeControlMessage(payload);
    } catch (err) {
      return {
        ok: false,
        code: "delivery_failed",
        message: err?.message || "failed to deliver message to worker",
      };
    }
    emitEvent({
      type: "live_user_message",
      message_id: payload.id || null,
      body: payload.body,
      created_at: payload.created_at,
      author_type: payload.author_type,
      ts: Date.now(),
    });
    return { ok: true };
  }

  const done = new Promise((resolve) => {
    function finalize(code, signal = null) {
      if (finalized) return;
      finalized = true;
      if (exitFallbackTimer) {
        clearTimeout(exitFallbackTimer);
        exitFallbackTimer = null;
      }
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      const durationMs = Date.now() - startedAt;
      const endedAt = Date.now();
      let processStatus = "succeeded";
      if (timedOut) processStatus = "failed";
      else if (cancelRequested || drainRequested || isCancellationExit(code, signal)) processStatus = "cancelled";
      else if (signal === "SIGKILL" && !code) processStatus = "abandoned";
      else if (code !== 0 || resultError) processStatus = "failed";
      const status = PROCESS_TO_LEGACY_STATUS[processStatus] || "running";
      const failureKind = processStatus === "succeeded"
        ? null
        : (classifyFailure({
            exitCode: code,
            errorText: errorMessage || resultError || "",
            stderrTail: stderrTail.toString(),
            timedOut,
            // R5: drainRequested folds into the cancel branch so a clean
            // worker-side drain (exit 0, `drained` event) is still classified
            // as `cancelled_shutdown` rather than `succeeded`.
            cancelRequested: cancelRequested || drainRequested,
            cancelInitiator,
            signal,
            resultParseError: !!resultError,
            hint: explicitFailureKind,
          }) || "spawn");
      const recoveredStructuredResult = !finalPayload?.worklab_result ? structuredOutputResult : null;
      const result = finalPayload?.worklab_result || recoveredStructuredResult || null;
      const leadCycleResult = finalPayload?.lead_cycle_result || null;
      const recoveredFinalText = recoveredStructuredResult ? finalTextFromWorklabResult(recoveredStructuredResult) : null;
      const finalWarnings = Array.isArray(finalPayload?.warnings) ? finalPayload.warnings : [];
      const allWarnings = [...warnings, ...finalWarnings];
      const providerSessionId = finalPayload?.provider_session_id
        || finalPayload?.providerSessionId
        || null;
      const fileEditArtifacts = extractRunArtifacts(rawEvents, {
        includePending: false,
        includeFailed: false,
        run: { id: runId, started_at: startedAt, ended_at: endedAt },
      });
      const workspaceArtifactResult = collectWorkspaceDeltaArtifacts(workspaceArtifactSnapshot, {
        workdir: env.WORKLAB_WORKSPACE,
        runId,
        endedAt,
      });
      const qaArtifactResult = collectQaOutputArtifacts({
        workdir: env.WORKLAB_WORKSPACE,
        qaOutputDir: env.WORKLAB_QA_OUTPUT_DIR,
        runId,
        endedAt,
      });
      const gitArtifactAfter = env.WORKLAB_WORKSPACE
        ? captureGitArtifactState(env.WORKLAB_WORKSPACE)
        : null;
      const gitArtifacts = collectGitArtifacts(gitArtifactBefore, gitArtifactAfter, { runId, endedAt });
      const artifacts = aggregateRunArtifacts([
        { id: runId, started_at: startedAt, ended_at: endedAt, artifacts: fileEditArtifacts },
        { id: runId, started_at: startedAt, ended_at: endedAt, artifacts: workspaceArtifactResult.artifacts },
        { id: runId, started_at: startedAt, ended_at: endedAt, artifacts: qaArtifactResult.artifacts },
        { id: runId, started_at: startedAt, ended_at: endedAt, artifacts: gitArtifacts },
      ]);
      const artifactSummary = runArtifactSummary(artifacts);
      const paths = artifactPaths(artifacts);
      const execenvPath = env.WORKLAB_EXECENV_PATH || null;
      const costUsd = numberOrNull(
        finalPayload?.cost_usd
          ?? finalPayload?.costUsd
          ?? finalPayload?.usage?.cost_usd
          ?? finalPayload?.usage?.costUsd,
      );
      const stderrTailText = stderrTail.toString();
      const providerFailureInfo = failureKind === "provider_unavailable"
        ? retryableProviderFailureInfo({
            errorText: errorMessage || resultError || "",
            stderrTail: stderrTailText,
            failureKind,
          })
        : null;
      const toolPayloadTruncatedCount = allWarnings.filter((w) => w.kind === "tool_payload_truncated").length;
      const toolOutputsPrunedCount = rawEvents.reduce((acc, event) => {
        const target = event?.type === "sdk_event" && event.event ? event.event : event;
        if (target?.type !== "tool_context_pruned") return acc;
        return acc + (Number(target.pruned_tool_results) || 0);
      }, 0);
      const resultRecoveredViaLenient = allWarnings.some((w) => w.kind === "result_recovered_via_lenient");
      const todoSummary = (() => {
        try {
          return runTodoStateSummary(getRunTodoStateRow(db, runId)?.todo_state_json);
        } catch {
          return runTodoStateSummary(null);
        }
      })();
      const diagnostics = {
        ...(diagnosticsSeed || {}),
        ...(promptDiagnostics || {}),
        ...contextBloatDiagnostics(),
        ...(workerDiagnostics || {}),
        ...(finalPayload?.diagnostics || {}),
        provider_session_id: providerSessionId,
        execenv_path: execenvPath,
        effective_workdir: env.WORKLAB_WORKSPACE || null,
        workspace_artifacts: workspaceArtifactResult.diagnostics,
        qa_artifacts: qaArtifactResult.diagnostics,
        git_artifacts: {
          before: gitArtifactBefore,
          after: gitArtifactAfter,
          changed: gitArtifacts.length > 0,
        },
        run_todo: {
          used: todoSummary.update_count > 0,
          update_count: todoSummary.update_count,
          total: todoSummary.total,
          completed: todoSummary.completed,
          open: Math.max(0, todoSummary.total - todoSummary.completed),
        },
        warning_count: allWarnings.length,
        ...(toolPayloadTruncatedCount > 0 ? { tool_results_truncated: toolPayloadTruncatedCount } : {}),
        ...(toolOutputsPrunedCount > 0 ? { tool_outputs_pruned: toolOutputsPrunedCount } : {}),
        ...(resultRecoveredViaLenient ? { result_recovered_via: "lenient" } : {}),
        ...(recoveredStructuredResult ? { structured_output_recovered_as_final: true } : {}),
        cancel_initiator: cancelInitiator,
        cancel_reason: cancelReason,
        ...(signal ? { exit_signal: signal } : {}),
        ...(workerCancelSignal ? { worker_cancel_signal: workerCancelSignal } : {}),
        ...(stderrTailText ? { stderr_tail: stderrTailText } : {}),
        ...(failureKind ? { failure_kind: failureKind } : {}),
        ...(providerFailureInfo?.retryable ? {
          retryable_provider_error: true,
          provider_error_subkind: providerFailureInfo.subkind,
          ...(providerFailureInfo.requestId ? { provider_request_id: providerFailureInfo.requestId } : {}),
        } : {}),
        ...(errorDetails ? { error_details: errorDetails } : {}),
        ...(drainRequested ? {
          drained: drainAcknowledged,
          ...(drainTimedOut ? { drain_timeout: true } : {}),
        } : {}),
      };

      // R5: when the coordinator asked the worker to drain, persist a tagged
      // transcript_tail snapshot so the next coordinator boot can pick the
      // run back up via a `coordinator_resume` continuation. The snapshot
      // captures the recent assistant turns + tool calls; the run's
      // task/agent identity is keyed off the existing task_runs row. We
      // unwrap `sdk_event` envelopes because buildTranscriptTailSnapshot
      // walks the inner provider-shaped events.
      if (drainRequested && rawEvents.length > 0) {
        const innerEvents = rawEvents.map((event) => (
          event?.type === "sdk_event" && event.event ? event.event : event
        ));
        const baseSnapshot = buildTranscriptTailSnapshot(innerEvents);
        if (baseSnapshot) {
          const taggedSnapshot = {
            ...baseSnapshot,
            resume_kind: "drained",
            drain_acknowledged: drainAcknowledged,
            ...(drainTimedOut ? { drain_timeout: true } : {}),
          };
          try {
            setRunTranscriptTail(db, runId, JSON.stringify(taggedSnapshot));
          } catch (err) {
            logger?.warn?.({ err: err.message, runId }, "failed to persist drained transcript snapshot");
          }
        }
      }

      const firstTurnInputTokens = numberOrNull(promptDiagnostics?.first_turn_input_tokens);
      const firstTurnOverheadTokens = numberOrNull(promptDiagnostics?.first_turn_overhead_tokens);
      const sqliteLog = compactEventsForSqlite(rawEvents);

      db.prepare(
        `UPDATE task_runs
         SET status = ?, process_status = ?, ended_at = ?, exit_code = ?,
             error_text = ?, decision = ?, failure_kind = ?, summary = ?,
             details = ?, result_json = ?,
             artifact_paths_json = ?, artifacts_json = ?, artifact_summary_json = ?,
             cancel_initiator = ?, cancel_reason = ?,
             warnings_json = ?, diagnostics_json = ?,
             provider_session_id = ?, execenv_path = ?, cost_usd = ?,
             first_turn_input_tokens = ?, first_turn_overhead_tokens = ?
         WHERE id = ?`,
      ).run(
        status,
        processStatus,
        endedAt,
        code,
        errorMessage || resultError,
        result?.decision || null,
        failureKind,
        result?.summary || leadCycleResult?.summary || null,
        result?.details || leadCycleResult?.goal_status_reason || null,
        result ? JSON.stringify(result) : leadCycleResult ? JSON.stringify(leadCycleResult) : null,
        JSON.stringify(paths),
        JSON.stringify(artifacts),
        JSON.stringify(artifactSummary),
        cancelInitiator,
        cancelReason,
        JSON.stringify(allWarnings),
        Object.keys(diagnostics).length ? JSON.stringify(diagnostics) : null,
        providerSessionId,
        execenvPath,
        costUsd,
        firstTurnInputTokens,
        firstTurnOverheadTokens,
        runId,
      );

      db.prepare(
        `UPDATE agent_logs
         SET events = ?, model = ?, effort = ?, input_tokens = ?,
             output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?,
             cost_usd = ?, duration_ms = ?, num_turns = ?, status = ?,
             events_compacted_at = ?, events_original_count = COALESCE(events_original_count, ?),
             events_original_bytes = COALESCE(events_original_bytes, ?),
             events_compaction_strategy = ?, events_compaction_version = ?,
             events_compacted_bytes = ?
         WHERE id = ?`,
      ).run(
        JSON.stringify(sqliteLog.events),
        finalPayload?.model || null,
        finalPayload?.effort || null,
        finalPayload?.usage?.input_tokens ?? finalPayload?.usage?.inputTokens ?? null,
        finalPayload?.usage?.output_tokens ?? finalPayload?.usage?.outputTokens ?? null,
        finalPayload?.usage?.cache_read_tokens ?? finalPayload?.usage?.cacheReadTokens ?? null,
        finalPayload?.usage?.cache_creation_tokens ?? finalPayload?.usage?.cacheWriteTokens ?? null,
        costUsd,
        finalPayload?.durationMs ?? durationMs,
        finalPayload?.numTurns ?? null,
        status,
        endedAt,
        sqliteLog.original_count,
        sqliteLog.original_bytes,
        sqliteLog.strategy,
        sqliteLog.version,
        sqliteLog.bytes,
        logId,
      );

      broker.broadcast(runId, { type: "done", exitCode: code });

      resolve({
        exitCode: code,
        events,
        warnings: allWarnings,
        diagnostics,
        finalText: finalPayload?.text || recoveredFinalText,
        worklabResult: result,
        leadCycleResult,
        artifacts,
        artifactSummary,
        usage: finalPayload?.usage || {},
        costUsd,
        providerSessionId,
        execenvPath,
        cancelInitiator,
        cancelReason,
        error: errorMessage || resultError,
        resultError,
        failureKind,
        status,
        processStatus,
      });
    }

    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal || null;
      // Prefer close so stdout/stderr buffers have drained. The fallback keeps
      // tests and unusual child behavior from hanging forever if close is lost.
      // We give close `exitCloseGraceMs` to fire before forcing finalization,
      // and emit a runtime_warning if the watchdog has to step in — that's a
      // signal the child died with stdout still buffered.
      exitFallbackTimer = setTimeout(() => {
        if (finalized) return;
        exitWatchdogFired = true;
        emitEvent({
          type: "runtime_warning",
          warning_kind: "exit_without_close",
          source: "worker",
          message: `worker emitted exit but not close within ${exitCloseGraceMs}ms; finalizing anyway`,
          ts: Date.now(),
          diagnostics: { pi_error_code: "exit_without_close" },
        });
        finalize(exitCode, exitSignal);
      }, exitCloseGraceMs);
      exitFallbackTimer.unref?.();
    });

    child.on("close", (code, signal) => {
      finalize(code ?? exitCode, signal || exitSignal);
    });
  });

  return {
    pid: child.pid,
    done,
    cancel,
    drain,
    sendLiveMessage,
    get warnings() { return [...warnings]; },
    get exitWatchdogFired() { return exitWatchdogFired; },
    get drainRequested() { return drainRequested; },
    get drainAcknowledged() { return drainAcknowledged; },
    get drainTimedOut() { return drainTimedOut; },
  };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isWorklabResult(value) {
  return isPlainObject(value)
    && value.schema === "worklab.v2"
    && typeof value.decision === "string";
}

function worklabResultFromStructuredOutputEvent(rawEvent) {
  const event = rawEvent?.type === "sdk_event" && rawEvent.event ? rawEvent.event : rawEvent;
  if (event?.type !== "structured_output") return null;
  const candidates = [
    event.worklab_result,
    event.value,
    event.value?.worklab_result,
    rawEvent?.worklab_result,
  ];
  return candidates.find(isWorklabResult) || null;
}

function finalTextFromWorklabResult(result) {
  for (const key of ["final_text", "summary", "details"]) {
    const value = result?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
