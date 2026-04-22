import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { newAgentLogId } from "../core/ids.js";

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
}) {
  const child = spawn("node", [binary, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const events = [];
  let finalPayload = null;
  let errorMessage = null;
  let cancelRequested = false;
  let sigkillTimer = null;
  const startedAt = Date.now();

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
    events.push(parsed);
    broker.broadcast(runId, parsed);
    if (parsed.type === "final") finalPayload = parsed;
    if (parsed.type === "error") errorMessage = parsed.message;
  });

  child.stderr.on("data", (chunk) => {
    logger?.info?.({ runId, stderr: chunk.toString() }, "worker stderr");
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
    child.on("exit", (code) => {
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      const durationMs = Date.now() - startedAt;
      let status = "complete";
      if (cancelRequested || code === 130) status = "cancelled";
      else if (code !== 0) status = "error";

      db.prepare(
        `UPDATE task_runs SET status = ?, ended_at = ?, exit_code = ?, error_text = ? WHERE id = ?`,
      ).run(status, Date.now(), code, errorMessage, runId);

      db.prepare(
        `INSERT INTO agent_logs
          (id, task_run_id, events, model, effort, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, num_turns, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newAgentLogId(),
        runId,
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
        Date.now(),
      );

      broker.broadcast(runId, { type: "done", exitCode: code });

      resolve({
        exitCode: code,
        events,
        finalText: finalPayload?.text || null,
        usage: finalPayload?.usage || {},
        error: errorMessage,
        status,
      });
    });
  });

  return { pid: child.pid, done, cancel };
}
