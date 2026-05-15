import {
  artifactPaths,
  artifactsForRunRow,
  createRunEventStore,
  normalizeLiveInputBody,
  resolveRunArtifactDir,
  runArtifactSummary,
  runTodoStateSummary,
  safeRunArtifactPath,
  supportsLiveInputProvider,
  collectGitDiffArtifactsForRun,
} from "../../core/runtime/index.js";
import { newCommentId } from "../../core/platform/index.js";
import { getRunById, getRunRawOutputPath } from "../../core/db/queries/runs.js";
import { getAgentLogByRunId } from "../../core/db/queries/agent-logs.js";
import { listApprovalsForRun } from "../../core/db/queries/task-run-approvals.js";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

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

export function registerRunRoutes(app, { db, broker, dataDir, watcher }) {
  const runEvents = createRunEventStore({ dataDir });

  app.get("/api/runs/:id", (req, res) => {
    const row = getRunById(db, req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    const liveInputState = watcher?.getRunLiveInputState?.(row.id) || null;
    const eventMode = runEvents.eventMode(req.query?.events);
    const logRow = getAgentLogByRunId(db, req.params.id, { includeEvents: eventMode !== "none" });
    const rawEvents = eventMode === "full" ? runEvents.readRawEvents(row) : null;
    const log = runEvents.shapeLog(logRow, req.query || {}, { rawEvents });
    const run = normalizeRun(row, liveInputState, Array.isArray(log?.events) ? log.events : null);
    res.json({ run, log });
  });

  app.get("/api/runs/:id/approvals", (req, res) => {
    const row = getRunById(db, req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
    const approvals = listApprovalsForRun(db, row.id);
    res.json({ runId: row.id, approvals });
  });

  app.post("/api/runs/:id/approvals/:requestId/decision", async (req, res, next) => {
    try {
      const row = getRunById(db, req.params.id);
      if (!row) return res.status(404).json({ error: { code: "not_found", message: "run not found" } });
      const requestId = String(req.params.requestId || "");
      const decision = String(req.body?.decision || "");
      if (!["approve", "deny", "always"].includes(decision)) {
        return res.status(400).json({ error: { code: "invalid_decision", message: "decision must be approve|deny|always" } });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
      const decidedBy = typeof req.body?.decided_by === "string" ? req.body.decided_by : "user";
      if (typeof watcher?.sendRunApprovalDecision !== "function") {
        return res.status(409).json({ error: { code: "approval_unavailable", message: "approvals are unavailable" } });
      }
      const result = await watcher.sendRunApprovalDecision(row.id, { requestId, decision, reason, decidedBy });
      if (!result?.ok) {
        return res.status(409).json({
          error: { code: result?.code || "decision_failed", message: result?.message || "failed to deliver approval decision" },
        });
      }
      res.status(202).json({ delivered: true, runId: row.id, requestId, decision, approval: result.row });
    } catch (err) {
      next(err);
    }
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
    try {
      res.type("text/plain").send(runEvents.readRawText(row));
    } catch (err) {
      const status = err?.code === "forbidden" ? 403 : 404;
      return res.status(status).json({
        error: {
          code: err?.code || "not_found",
          message: err?.message || "raw log not available",
        },
      });
    }
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
