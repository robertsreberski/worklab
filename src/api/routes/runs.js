import {
  artifactPaths,
  artifactsForRunRow,
  newCommentId,
  normalizeLiveInputBody,
  resolveRunArtifactDir,
  runArtifactSummary,
  runTodoStateSummary,
  safeRunArtifactPath,
  supportsLiveInputProvider,
  tailRunEventsByVisibleItems,
  collectGitDiffArtifactsForRun,
} from "../../core/index.js";
import { getRunById, getRunRawOutputPath } from "../../core/db/queries/runs.js";
import { getAgentLogByRunId } from "../../core/db/queries/agent-logs.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function parseEvents(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonlEvents(value) {
  const out = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // Ignore malformed fragments so a partially-written raw log does not
      // break run detail hydration.
    }
  }
  return out;
}

function rawPathInsideDataDir(rawPath, dataDir) {
  if (!dataDir) return rawPath;
  const root = resolve(dataDir);
  const target = resolve(rawPath);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? target : null;
}

function readRawRunEvents(row, dataDir) {
  if (!row?.raw_output_path) return null;
  const rawPath = rawPathInsideDataDir(row.raw_output_path, dataDir);
  if (!rawPath || !existsSync(rawPath)) return null;
  return parseJsonlEvents(readFileSync(rawPath, "utf8"));
}

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeRun(row, liveInputState = null, events = null) {
  const processStatus = row.process_status || "running";
  const supported = supportsLiveInputProvider(row.provider_kind);
  const artifacts = artifactsForRunRow(row, {
    events,
    extraArtifacts: collectGitDiffArtifactsForRun(row),
  });
  return {
    ...row,
    process_status: processStatus,
    workspace_mode: row.workspace_mode || "direct",
    source_workdir: row.source_workdir || null,
    worktree: safeJson(row.worktree_json, null),
    artifact_paths: artifactPaths(artifacts),
    artifacts,
    artifact_summary: runArtifactSummary(artifacts),
    todo_state: runTodoStateSummary(row.todo_state_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    live_input: {
      supported,
      active: !!(supported && liveInputState?.active),
      reason: supported ? (liveInputState?.reason || null) : "unsupported_provider",
    },
  };
}

function runProcessStatus(row) {
  return row.process_status || "running";
}

function runEventLimit(value) {
  const parsed = Number(value || 200);
  if (!Number.isInteger(parsed) || parsed < 1) return 200;
  return Math.min(parsed, 500);
}

function runEventMode(value) {
  if (value === "tail") return "tail";
  if (value === "none") return "none";
  return "full";
}

function logPayloadFidelity(logRow) {
  if (logRow?.events_compaction_strategy || logRow?.events_compacted_at) return "compacted";
  return "display";
}

function shapeRunLog(logRow, query = {}, { rawEvents = null } = {}) {
  const mode = runEventMode(query.events);
  if (mode === "full" && Array.isArray(rawEvents)) {
    return {
      ...(logRow || {}),
      events: rawEvents,
      event_count: rawEvents.length,
      events_truncated: false,
      source: "raw_output_path",
      payload_fidelity: "full",
    };
  }
  if (!logRow) return null;
  const payloadFidelity = logPayloadFidelity(logRow);
  if (mode === "none") {
    const eventCount = Number(logRow.event_count || 0);
    return {
      ...logRow,
      events: [],
      event_count: eventCount,
      events_truncated: eventCount > 0,
      source: "agent_logs.events",
      payload_fidelity: payloadFidelity,
    };
  }
  const events = parseEvents(logRow.events);
  if (mode !== "tail") {
    const eventCount = Number(logRow.event_count ?? events.length);
    return {
      ...logRow,
      events,
      event_count: eventCount,
      events_truncated: payloadFidelity === "compacted" || eventCount > events.length,
      source: "agent_logs.events",
      payload_fidelity: payloadFidelity,
    };
  }
  const limit = runEventLimit(query.limit);
  const tail = tailRunEventsByVisibleItems(events, limit);
  const eventCount = Number(logRow.event_count ?? events.length);
  return {
    ...logRow,
    events: tail,
    event_count: eventCount,
    events_truncated: eventCount > tail.length || events.length > tail.length,
    source: "agent_logs.events",
    payload_fidelity: payloadFidelity,
  };
}

export function registerRunRoutes(app, { db, broker, dataDir, watcher }) {
  app.get("/api/runs/:id", (req, res) => {
    const row = getRunById(db, req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    const liveInputState = watcher?.getRunLiveInputState?.(row.id) || null;
    const eventMode = runEventMode(req.query?.events);
    const logRow = getAgentLogByRunId(db, req.params.id, { includeEvents: eventMode !== "none" });
    const rawEvents = eventMode === "full" ? readRawRunEvents(row, dataDir) : null;
    const log = shapeRunLog(logRow, req.query || {}, { rawEvents });
    const run = normalizeRun(row, liveInputState, Array.isArray(log?.events) ? log.events : null);
    res.json({ run, log });
  });

  app.post("/api/runs/:id/messages", async (req, res, next) => {
    try {
      const row = getRunById(db, req.params.id);
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
      const messageId = newCommentId();

      const delivery = await watcher.sendRunMessage(row.id, {
        id: messageId,
        body: normalized.body,
        createdAt: now,
        authorType: "human",
      });
      const message = { id: messageId, body: normalized.body, created_at: now };
      if (!delivery?.ok) {
        return res.status(409).json({
          delivered: false,
          runId: row.id,
          message,
          error: {
            code: delivery?.code || "delivery_failed",
            message: delivery?.message || "failed to deliver message to worker",
          },
        });
      }
      res.status(202).json({ delivered: true, runId: row.id, message });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/runs/:id/raw-log", (req, res) => {
    const row = getRunRawOutputPath(db, req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    if (!row.raw_output_path) {
      return res.status(404).json({ error: { code: "not_found", message: "raw log not available" } });
    }
    const rawPath = resolve(row.raw_output_path);
    if (dataDir) {
      if (!rawPathInsideDataDir(rawPath, dataDir)) {
        return res.status(403).json({ error: { code: "forbidden", message: "raw log path is outside data dir" } });
      }
    }
    if (!existsSync(rawPath)) {
      return res.status(404).json({ error: { code: "not_found", message: "raw log file not found" } });
    }
    res.type("text/plain").send(readFileSync(rawPath, "utf8"));
  });

  app.get("/api/runs/:id/artifact-file", (req, res, next) => {
    const row = getRunById(db, req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    if (!row.workdir) {
      return res.status(404).json({ error: { code: "not_found", message: "run artifact directory not available" } });
    }
    const requested = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path;
    const artifactDir = resolveRunArtifactDir({ workdir: row.workdir, runId: row.id });
    const artifactPath = safeRunArtifactPath(artifactDir, requested);
    if (!artifactPath) {
      return res.status(403).json({ error: { code: "forbidden", message: "artifact path is outside the run artifact directory" } });
    }
    try {
      if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
        return res.status(404).json({ error: { code: "not_found", message: "artifact file not found" } });
      }
    } catch {
      return res.status(404).json({ error: { code: "not_found", message: "artifact file not found" } });
    }
    return res.sendFile(artifactPath, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  app.get("/api/runs/:id/stream", (req, res) => {
    broker.subscribe(req.params.id, res);
  });
}
