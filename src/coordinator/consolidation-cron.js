import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newRunId } from "../core/ids.js";
import { readSettings } from "../core/settings.js";
import { agentJournalPath, agentMemoryPath } from "../core/journal.js";
import { indexPath } from "../core/embeddings.js";
import { setRunWorkerPid } from "../core/db/queries/runs.js";

const TICK_MS = 60_000;

function hashFile(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function localHourAndDate(date, timezone) {
  const local = timezone
    ? new Date(date.toLocaleString("en-US", { timeZone: timezone }))
    : date;
  return { hour: local.getHours(), date: local.toISOString().slice(0, 10) };
}

export function createConsolidationManager({
  db,
  broker,
  spawn,
  workerBinary,
  logger,
  repoRoot,
  dataDir,
  config = {},
  cancelGraceMs = 5000,
  runTimeoutMs = 30 * 60 * 1000,
  runIdleWarningMs = 120 * 1000,
  logInlineLimit = 12_000,
} = {}) {
  const active = new Map();
  let interval = null;
  let lastTickDate = null;

  function completeRun(agentName, runId, journalHash, res) {
    active.delete(agentName);
    if (res.status === "complete") {
      db.prepare(`
        INSERT INTO agent_consolidations (agent_name, last_journal_hash, last_consolidated_at, last_run_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_name) DO UPDATE SET
          last_journal_hash = excluded.last_journal_hash,
          last_consolidated_at = excluded.last_consolidated_at,
          last_run_id = excluded.last_run_id
      `).run(agentName, journalHash, Date.now(), runId);
      const memoryPath = agentMemoryPath(dataDir, agentName);
      if (existsSync(memoryPath)) {
        indexPath({ db, dataDir, filePath: memoryPath }).catch((err) => {
          logger?.warn?.({ err: err.message, agentName }, "memory reindex after consolidation failed");
        });
      }
    }
    broker?.broadcast?.("global", { type: "run_ended", runId, taskId: null });
    broker?.broadcast?.("global", { type: "agent_consolidated", agent: agentName, runId, status: res.status });
  }

  function runNow(agentName, { force = true } = {}) {
    const agent = db.prepare("SELECT * FROM agents WHERE name = ? AND enabled = 1").get(agentName);
    if (!agent) throw new Error(`enabled agent not found: ${agentName}`);
    if (active.has(agentName)) throw new Error(`consolidation already running for ${agentName}`);
    const journalPath = agentJournalPath(dataDir, agentName);
    const journalHash = hashFile(journalPath);
    if (!journalHash) throw new Error(`agent ${agentName} has no journal entries`);
    const previous = db.prepare("SELECT last_journal_hash FROM agent_consolidations WHERE agent_name = ?").get(agentName);
    if (!force && previous?.last_journal_hash === journalHash) return { skipped: true, reason: "journal unchanged" };
    const settings = readSettings(db);

    const runId = newRunId();
    const now = Date.now();
    db.prepare(
      "INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status) VALUES (?, NULL, 'consolidate', ?, ?, 'running')",
    ).run(runId, agentName, now);

    const handle = spawn({
      binary: workerBinary,
      args: ["--mode", "consolidate", "--agent", agentName],
      env: {
        WORKLAB_RUN_ID: runId,
        WORKLAB_DATA_DIR: dataDir || "",
        WORKLAB_REPO_ROOT: repoRoot || "",
      },
      runId,
      taskId: null,
      broker,
      db,
      logger,
      dataDir,
      cancelGraceMs: settings.cancel_grace_ms ?? cancelGraceMs,
      runTimeoutMs: settings.worker_timeout_ms || runTimeoutMs,
      runIdleWarningMs,
      logInlineLimit,
    });
    setRunWorkerPid(db, runId, handle.pid);
    active.set(agentName, { runId, handle });
    broker?.broadcast?.("global", { type: "run_started", runId, taskId: null, mode: "consolidate", agent: agentName });

    handle.done
      .then((res) => completeRun(agentName, runId, journalHash, res))
      .catch((err) => {
        logger?.error?.({ err, agentName, runId }, "consolidation worker rejected");
        completeRun(agentName, runId, journalHash, { status: "error", error: err.message });
      });
    return { runId };
  }

  function tick(now = new Date()) {
    const settings = readSettings(db);
    if (!settings.consolidation_enabled) return { skipped: true, reason: "disabled" };
    const { hour, date } = localHourAndDate(now, config.timezone);
    if (hour !== Number(settings.consolidation_hour)) return { skipped: true, reason: "wrong hour" };
    if (lastTickDate === date) return { skipped: true, reason: "already checked today" };
    lastTickDate = date;
    const agents = db.prepare("SELECT name FROM agents WHERE enabled = 1 ORDER BY name").all();
    const started = [];
    for (const agent of agents) {
      try {
        const result = runNow(agent.name, { force: false });
        if (result.runId) started.push({ agent: agent.name, runId: result.runId });
      } catch (err) {
        logger?.warn?.({ err: err.message, agent: agent.name }, "scheduled consolidation skipped");
      }
    }
    return { started, at: now.toISOString() };
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => tick(), TICK_MS);
    interval.unref?.();
  }

  async function shutdown() {
    if (interval) clearInterval(interval);
    interval = null;
    const waits = [];
    for (const entry of active.values()) {
      entry.handle.cancel();
      waits.push(entry.handle.done);
    }
    await Promise.allSettled(waits);
  }

  return {
    runNow,
    tick,
    start,
    shutdown,
    isActive: (agentName) => active.has(agentName),
  };
}
