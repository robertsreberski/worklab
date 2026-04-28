import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { newAgentLogId } from "../core/ids.js";
import { processStatusToLegacyStatus } from "../core/state-machine.js";
import { normalizeLiveInputBody } from "../core/live-input.js";

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
    target.message.content = target.message.content.map((block) => truncateToolResultBlock(block, options));
  }
  if (target?.type === "tool_result") {
    const clipped = truncateToolResultBlock(target, options);
    if (next.type === "sdk_event" && next.event) next.event = clipped;
    else return clipped;
  }
  return next;
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
}) {
  const child = spawn("node", [binary, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = [];
  let finalPayload = null;
  let errorMessage = null;
  let resultError = null;
  let explicitFailureKind = null;
  let exitCode = null;
  let cancelRequested = false;
  let sigkillTimer = null;
  let finalized = false;
  let exitFallbackTimer = null;
  let persistTimer = null;
  let timeoutTimer = null;
  let idleTimer = null;
  let timedOut = false;
  const startedAt = Date.now();
  const logId = newAgentLogId();
  let rawLogPath = null;
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
    appendRawEvent(rawEvent);
    const event = truncateDisplayEvent(rawEvent, { limit: logInlineLimit, rawLogPath });
    events.push(event);
    schedulePersist();
    broker.broadcast(runId, event);
    resetIdleTimer();
    return { rawEvent, event };
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
      errorMessage = errorMessage || `run timed out after ${runTimeoutMs}ms`;
      emitEvent({
        type: "runtime_warning",
        warning_kind: "timeout",
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
    if (rawEvent.type === "worklab_result_error") {
      resultError = rawEvent.message || "invalid worklab_result";
      explicitFailureKind = "invalid_result";
    }
  });

  child.stderr.on("data", (chunk) => {
    logger?.info?.({ runId, stderr: chunk.toString() }, "worker stderr");
  });

  // Capture spawn failures (ENOENT on the binary, EACCES, etc). Without this
  // listener Node would fire 'error' then 'close' with code=null and we would
  // record a generic "exited 0" for what was really a spawn failure.
  child.on("error", (err) => {
    if (!errorMessage) errorMessage = err?.message || String(err);
    logger?.error?.({ err, runId }, "worker child process error");
  });

  function cancel() {
    if (cancelRequested) return;
    cancelRequested = true;
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
    function finalize(code) {
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
      else if (cancelRequested || code === 130) processStatus = "cancelled";
      else if (code !== 0 || resultError) processStatus = "failed";
      const status = processStatusToLegacyStatus(processStatus);
      const failureKind = timedOut ? "timeout" : resultError ? "invalid_result" : (processStatus === "failed" ? explicitFailureKind || "spawn" : null);
      const result = finalPayload?.worklab_result || null;

      db.prepare(
        `UPDATE task_runs
         SET status = ?, process_status = ?, ended_at = ?, exit_code = ?,
             error_text = ?, decision = ?, failure_kind = ?, summary = ?,
             details = ?, result_json = ?
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
        finalPayload?.usage?.input_tokens ?? null,
        finalPayload?.usage?.output_tokens ?? null,
        finalPayload?.usage?.cache_read_tokens ?? null,
        finalPayload?.usage?.cache_creation_tokens ?? null,
        finalPayload?.usage?.cost_usd ?? null,
        finalPayload?.durationMs ?? durationMs,
        finalPayload?.numTurns ?? null,
        status,
        logId,
      );

      broker.broadcast(runId, { type: "done", exitCode: code });

      resolve({
        exitCode: code,
        events,
        finalText: finalPayload?.text || null,
        worklabResult: result,
        usage: finalPayload?.usage || {},
        error: errorMessage || resultError,
        resultError,
        failureKind,
        status,
        processStatus,
      });
    }

    child.on("exit", (code) => {
      exitCode = code;
      // Prefer close so stdout/stderr buffers have drained. The fallback keeps
      // tests and unusual child behavior from hanging forever if close is lost.
      exitFallbackTimer = setTimeout(() => finalize(exitCode), 250);
    });

    child.on("close", (code) => {
      finalize(code ?? exitCode);
    });
  });

  return { pid: child.pid, done, cancel, sendLiveMessage };
}
