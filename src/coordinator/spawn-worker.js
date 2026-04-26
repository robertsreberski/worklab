import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { newAgentLogId } from "../core/ids.js";
import { processStatusToLegacyStatus } from "../core/state-machine.js";

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
}) {
  const child = spawn("node", [binary, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const events = [];
  let finalPayload = null;
  let errorMessage = null;
  let resultError = null;
  let exitCode = null;
  let cancelRequested = false;
  let sigkillTimer = null;
  let finalized = false;
  let exitFallbackTimer = null;
  let persistTimer = null;
  const startedAt = Date.now();
  const logId = newAgentLogId();
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
    const event = { ...parsed, _event_seq: parsed._event_seq ?? events.length + 1 };
    events.push(event);
    schedulePersist();
    broker.broadcast(runId, event);
    if (event.type === "final") finalPayload = event;
    if (event.type === "error") errorMessage = event.message;
    if (event.type === "worklab_result_error") resultError = event.message || "invalid worklab_result";
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
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    sigkillTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, cancelGraceMs);
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
      const durationMs = Date.now() - startedAt;
      let processStatus = "succeeded";
      if (cancelRequested || code === 130) processStatus = "cancelled";
      else if (code !== 0 || resultError) processStatus = "failed";
      const status = processStatusToLegacyStatus(processStatus);
      const failureKind = resultError ? "invalid_result" : (processStatus === "failed" ? "spawn" : null);
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

  return { pid: child.pid, done, cancel };
}
