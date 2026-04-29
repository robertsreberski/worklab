import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { newAgentLogId } from "../core/ids.js";
import { processStatusToLegacyStatus } from "../core/state-machine.js";
import { normalizeLiveInputBody } from "../core/live-input.js";
import { classifyFailure, createStderrTail } from "../core/failure-kind.js";

const CONTEXT_BLOAT_TOP_EVENTS = 5;

function makeRawLogPath(dataDir, runId) {
  if (!dataDir || !runId) return null;
  const dir = join(dataDir, "logs", "runs");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${runId}.jsonl`);
}

function truncateString(value, { limit }) {
  if (!limit || limit < 1 || typeof value !== "string" || value.length <= limit) {
    return { value, truncated: false, originalLength: value?.length || 0 };
  }
  const marker = `\n\n[truncated ${value.length - limit} chars; full raw log available]`;
  return {
    value: `${value.slice(0, limit)}${marker}`,
    truncated: true,
    originalLength: value.length,
  };
}

function truncateToolResultValue(value, options) {
  if (typeof value === "string") return truncateString(value, options);
  if (Array.isArray(value)) {
    let truncated = false;
    let originalLength = 0;
    const next = value.map((item) => {
      if (item?.type === "text" && typeof item.text === "string") {
        const result = truncateString(item.text, options);
        truncated ||= result.truncated;
        originalLength = Math.max(originalLength, result.originalLength);
        return result.truncated ? { ...item, text: result.value } : item;
      }
      return item;
    });
    return { value: next, truncated, originalLength };
  }
  return { value, truncated: false, originalLength: 0 };
}

function truncateStructuredDisplayValue(value, options) {
  if (!options.limit || options.limit < 1 || value == null) {
    return { value, truncated: false, originalLength: 0 };
  }
  if (typeof value === "string") return truncateString(value, options);
  let raw;
  try {
    raw = JSON.stringify(value, null, 2);
  } catch {
    raw = String(value);
  }
  if (raw.length <= options.limit) return { value, truncated: false, originalLength: raw.length };
  const clipped = truncateString(raw, options);
  return {
    value: {
      truncated: true,
      original_length: raw.length,
      raw_output_path: options.rawLogPath || null,
      preview: clipped.value,
    },
    truncated: true,
    originalLength: raw.length,
  };
}

function truncateToolUseBlock(block, options) {
  if (!block || typeof block !== "object" || block.type !== "tool_use" || !("input" in block)) return block;
  const clipped = truncateStructuredDisplayValue(block.input, options);
  if (!clipped.truncated) return block;
  return {
    ...block,
    input: clipped.value,
    input_truncated: true,
    input_original_length: clipped.originalLength,
    raw_output_path: options.rawLogPath || null,
  };
}

function truncateToolResultBlock(block, options) {
  if (!block || typeof block !== "object" || block.type !== "tool_result") return block;
  let next = block;
  let truncated = false;
  let originalLength = 0;
  for (const key of ["content", "output", "result"]) {
    if (!(key in next)) continue;
    const clipped = truncateToolResultValue(next[key], options);
    if (clipped.truncated) {
      next = { ...next, [key]: clipped.value };
      truncated = true;
      originalLength = Math.max(originalLength, clipped.originalLength);
    }
  }
  if ("raw_result" in next) {
    const clipped = truncateStructuredDisplayValue(next.raw_result, options);
    if (clipped.truncated) {
      next = { ...next, raw_result: clipped.value };
      truncated = true;
      originalLength = Math.max(originalLength, clipped.originalLength);
    }
  }
  if (!truncated) return next;
  return {
    ...next,
    truncated: true,
    original_length: originalLength,
    raw_output_path: options.rawLogPath || null,
  };
}

function truncateDisplayEvent(event, options) {
  if (!event || !options.limit || options.limit < 1) return event;
  const next = JSON.parse(JSON.stringify(event));
  const target = next.type === "sdk_event" && next.event ? next.event : next;
  if (Array.isArray(target?.message?.content)) {
    target.message.content = target.message.content
      .map((block) => truncateToolUseBlock(block, options))
      .map((block) => truncateToolResultBlock(block, options));
  }
  if (target?.type === "tool_use") {
    const clipped = truncateToolUseBlock(target, options);
    if (next.type === "sdk_event" && next.event) next.event = clipped;
    else return clipped;
  }
  if (target?.type === "tool_result") {
    const clipped = truncateToolResultBlock(target, options);
    if (next.type === "sdk_event" && next.event) next.event = clipped;
    else return clipped;
  }
  return next;
}

function isCancellationExit(code, signal) {
  return code === 130 || signal === "SIGTERM" || signal === "SIGINT";
}

function jsonCharLength(value) {
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return String(value || "").length;
  }
}

function contentBlocksFromEvent(rawEvent) {
  const target = rawEvent?.type === "sdk_event" && rawEvent.event ? rawEvent.event : rawEvent;
  if (Array.isArray(target?.message?.content)) return target.message.content;
  if (Array.isArray(target?.content)) return target.content;
  return [];
}

function insertTopByChars(list, item, limit = CONTEXT_BLOAT_TOP_EVENTS) {
  list.push(item);
  list.sort((a, b) => (b.chars || b.payload_chars || 0) - (a.chars || a.payload_chars || 0));
  if (list.length > limit) list.length = limit;
}

function isBroadGlobUse(block) {
  if (block?.type !== "tool_use" || block.name !== "Glob") return false;
  const input = block.input || {};
  const pattern = String(input.pattern || "");
  const targetPath = String(input.path || "");
  return pattern === "**/*" || pattern === "**" || (pattern.includes("**") && !targetPath.includes("src"));
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
  runIdleWarningMs = 120 * 1000,
  logInlineLimit = 12_000,
  contextBloatEventChars = 100_000,
  contextBloatTotalChars = 500_000,
  exitCloseGraceMs = 1000,
  stderrTailLimit = 8 * 1024,
  diagnosticsSeed = null,
}) {
  const child = spawn("node", [binary, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = [];
  const warnings = [];
  let promptDiagnostics = null;
  const stderrTail = createStderrTail({ limit: stderrTailLimit });
  let finalPayload = null;
  let errorMessage = null;
  let resultError = null;
  let explicitFailureKind = null;
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
  let persistTimer = null;
  let timeoutTimer = null;
  let idleTimer = null;
  let timedOut = false;
  const startedAt = Date.now();
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
      db.prepare("UPDATE task_runs SET raw_output_path = ? WHERE id = ?").run(rawLogPath, runId);
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
    const rawEvent = { ...parsed, _event_seq: parsed._event_seq ?? events.length + 1 };
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
    resetIdleTimer();
    if (contextWarning) emitEvent(contextWarning);
    return { rawEvent, event };
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
      emitEvent({
        type: "runtime_warning",
        warning_kind: "idle",
        message: `No worker events for ${runIdleWarningMs}ms.`,
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
    if (rawEvent.type === "final") finalPayload = rawEvent;
    if (rawEvent.type === "error") {
      errorMessage = rawEvent.message;
      explicitFailureKind = rawEvent.failureKind || rawEvent.failure_kind || explicitFailureKind;
    }
    if (rawEvent.type === "cancelled") {
      cancelInitiator = cancelInitiator || rawEvent.initiator || rawEvent.cancel_initiator || null;
      cancelReason = cancelReason || rawEvent.reason || rawEvent.cancel_reason || null;
      workerCancelSignal = workerCancelSignal || rawEvent.signal || null;
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
      const durationMs = Date.now() - startedAt;
      let processStatus = "succeeded";
      if (timedOut) processStatus = "failed";
      else if (cancelRequested || isCancellationExit(code, signal)) processStatus = "cancelled";
      else if (signal === "SIGKILL" && !code) processStatus = "abandoned";
      else if (code !== 0 || resultError) processStatus = "failed";
      const status = processStatusToLegacyStatus(processStatus);
      const failureKind = processStatus === "succeeded"
        ? null
        : (classifyFailure({
            exitCode: code,
            errorText: errorMessage || resultError || "",
            stderrTail: stderrTail.toString(),
            timedOut,
            cancelRequested,
            cancelInitiator,
            signal,
            resultParseError: !!resultError,
            hint: explicitFailureKind,
          }) || "spawn");
      const result = finalPayload?.worklab_result || null;
      const finalWarnings = Array.isArray(finalPayload?.warnings) ? finalPayload.warnings : [];
      const allWarnings = [...warnings, ...finalWarnings];
      const providerSessionId = finalPayload?.provider_session_id
        || finalPayload?.providerSessionId
        || null;
      const execenvPath = env.WORKLAB_EXECENV_PATH || null;
      const costUsd = numberOrNull(
        finalPayload?.cost_usd
          ?? finalPayload?.costUsd
          ?? finalPayload?.usage?.cost_usd
          ?? finalPayload?.usage?.costUsd,
      );
      const stderrTailText = stderrTail.toString();
      const diagnostics = {
        ...(diagnosticsSeed || {}),
        ...(promptDiagnostics || {}),
        ...contextBloatDiagnostics(),
        ...(finalPayload?.diagnostics || {}),
        provider_session_id: providerSessionId,
        execenv_path: execenvPath,
        warning_count: allWarnings.length,
        cancel_initiator: cancelInitiator,
        cancel_reason: cancelReason,
        ...(signal ? { exit_signal: signal } : {}),
        ...(workerCancelSignal ? { worker_cancel_signal: workerCancelSignal } : {}),
        ...(stderrTailText ? { stderr_tail: stderrTailText } : {}),
        ...(failureKind ? { failure_kind: failureKind } : {}),
      };

      db.prepare(
        `UPDATE task_runs
         SET status = ?, process_status = ?, ended_at = ?, exit_code = ?,
             error_text = ?, decision = ?, failure_kind = ?, summary = ?,
             details = ?, result_json = ?,
             cancel_initiator = ?, cancel_reason = ?,
             warnings_json = ?, diagnostics_json = ?,
             provider_session_id = ?, execenv_path = ?, cost_usd = ?
         WHERE id = ?`,
      ).run(
        status,
        processStatus,
        Date.now(),
        code,
        errorMessage || resultError,
        result?.decision || null,
        failureKind,
        result?.summary || null,
        result?.details || null,
        result ? JSON.stringify(result) : null,
        cancelInitiator,
        cancelReason,
        JSON.stringify(allWarnings),
        Object.keys(diagnostics).length ? JSON.stringify(diagnostics) : null,
        providerSessionId,
        execenvPath,
        costUsd,
        runId,
      );

      db.prepare(
        `UPDATE agent_logs
         SET events = ?, model = ?, effort = ?, input_tokens = ?,
             output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?,
             cost_usd = ?, duration_ms = ?, num_turns = ?, status = ?
         WHERE id = ?`,
      ).run(
        JSON.stringify(events),
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
        logId,
      );

      broker.broadcast(runId, { type: "done", exitCode: code });

      resolve({
        exitCode: code,
        events,
        warnings: allWarnings,
        diagnostics,
        finalText: finalPayload?.text || null,
        worklabResult: result,
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
    sendLiveMessage,
    get warnings() { return [...warnings]; },
    get exitWatchdogFired() { return exitWatchdogFired; },
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
