import { legacyRunStatusToProcessStatus } from "../core/state-machine.js";
import { newCommentId } from "../core/ids.js";
import { normalizeLiveInputBody, supportsLiveInputProvider } from "../core/live-input.js";
import { artifactPaths, artifactsForRunRow, runArtifactSummary } from "../core/run-artifacts.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEvents(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRun(row, liveInputState = null, events = null) {
  const processStatus = row.status !== "running" && row.process_status === "running"
    ? legacyRunStatusToProcessStatus(row.status)
    : row.process_status;
  const supported = supportsLiveInputProvider(row.provider_kind);
  const artifacts = artifactsForRunRow(row, { events });
  return {
    ...row,
    process_status: processStatus,
    artifact_paths: artifactPaths(artifacts),
    artifacts,
    artifact_summary: runArtifactSummary(artifacts),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    live_input: {
      supported,
      active: !!(supported && liveInputState?.active),
      reason: supported ? (liveInputState?.reason || null) : "unsupported_provider",
    },
  };
}

function runProcessStatus(row) {
  return row.status !== "running" && row.process_status === "running"
    ? legacyRunStatusToProcessStatus(row.status)
    : row.process_status;
}

function runEventLimit(value) {
  const parsed = Number(value || 200);
  if (!Number.isInteger(parsed) || parsed < 1) return 200;
  return Math.min(parsed, 500);
}

function shapeRunLog(logRow, query = {}) {
  if (!logRow) return null;
  const events = JSON.parse(logRow.events || "[]");
  if (query.events !== "tail") return { ...logRow, events };
  const limit = runEventLimit(query.limit);
  const tail = events.slice(-limit);
  return {
    ...logRow,
    events: tail,
    event_count: events.length,
    events_truncated: events.length > tail.length,
  };
}

export function registerRunRoutes(app, { db, broker, dataDir, watcher }) {
  app.get("/api/runs/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    const liveInputState = watcher?.getRunLiveInputState?.(row.id) || null;
    const logRow = db.prepare("SELECT * FROM agent_logs WHERE task_run_id = ?").get(req.params.id);
    const run = normalizeRun(row, liveInputState, parseEvents(logRow?.events));
    const log = shapeRunLog(logRow, req.query || {});
    res.json({ run, log });
  });

  app.post("/api/runs/:id/messages", async (req, res, next) => {
    try {
      const row = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(req.params.id);
      if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });

      const normalized = normalizeLiveInputBody(req.body?.body);
      if (!normalized.ok) {
        return res.status(400).json({ error: { code: normalized.code, message: normalized.error } });
      }
      if (!row.task_id) {
        return res.status(409).json({ error: { code: "run_not_task_bound", message: "run is not attached to a task" } });
      }
      if (runProcessStatus(row) !== "running") {
        return res.status(409).json({ error: { code: "run_not_active", message: "run is not running" } });
      }
      if (!supportsLiveInputProvider(row.provider_kind)) {
        return res.status(409).json({
          error: { code: "live_input_unsupported", message: "live input is not supported for this provider" },
        });
      }
      if (typeof watcher?.sendRunMessage !== "function") {
        return res.status(409).json({ error: { code: "live_input_unavailable", message: "live input is unavailable" } });
      }
      const state = watcher.getRunLiveInputState?.(row.id);
      if (state && !state.active) {
        return res.status(409).json({ error: { code: "run_not_active", message: "run is not active" } });
      }

      const now = Date.now();
      const commentId = newCommentId();
      db.prepare(
        `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
         VALUES (?, ?, 'human', ?, ?)`,
      ).run(commentId, row.task_id, normalized.body, now);
      broker.broadcast("global", { type: "task_updated", id: row.task_id });

      const delivery = await watcher.sendRunMessage(row.id, {
        id: commentId,
        body: normalized.body,
        createdAt: now,
        authorType: "human",
      });
      const message = { id: commentId, body: normalized.body, created_at: now };
      if (!delivery?.ok) {
        return res.status(409).json({
          delivered: false,
          message,
          error: {
            code: delivery?.code || "delivery_failed",
            message: delivery?.message || "failed to deliver message to worker",
          },
        });
      }
      res.status(202).json({ delivered: true, message });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/runs/:id/raw-log", (req, res) => {
    const row = db.prepare("SELECT raw_output_path FROM task_runs WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    if (!row.raw_output_path) {
      return res.status(404).json({ error: { code: "not_found", message: "raw log not available" } });
    }
    const rawPath = resolve(row.raw_output_path);
    if (dataDir) {
      const root = resolve(dataDir);
      if (!rawPath.startsWith(`${root}/`) && rawPath !== root) {
        return res.status(403).json({ error: { code: "forbidden", message: "raw log path is outside data dir" } });
      }
    }
    if (!existsSync(rawPath)) {
      return res.status(404).json({ error: { code: "not_found", message: "raw log file not found" } });
    }
    res.type("text/plain").send(readFileSync(rawPath, "utf8"));
  });

  app.get("/api/runs/:id/stream", (req, res) => {
    broker.subscribe(req.params.id, res);
  });
}
