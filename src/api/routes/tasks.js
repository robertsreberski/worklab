import {
  buildNextTaskRunPreview,
  buildRunLifecycleEvent,
  enrichCommentRows,
  loadTaskArtifacts,
  newCommentId,
  newTaskId,
  nextStage,
  nextTaskKey,
  resolveProjectId,
  resolveTaskRow,
  runtimeTaskVisibility,
  STAGES,
  taskStage,
} from "../../core/index.js";
import { renderToolSurfaceMarkdown } from "../../mcp/agent/tools/index.js";
import { withMentions } from "../lib/with-mentions.js";

const WORKLAB_TOOL_SURFACE_MARKDOWN = renderToolSurfaceMarkdown(null);
import {
  applyStaleRunReconcileToTask,
  getMaxSubtaskOrder,
  getTaskById,
  getTaskByClientRequestId,
  getTaskHealth,
  insertManualSubtask,
  insertTask,
  listFilteredTasks,
  listRuntimeTaskRows,
  markParentAwaitingChildren,
  touchTaskUpdatedAt,
} from "../../core/db/queries/tasks.js";
import {
  applyStaleRunReconcileToRun,
  getCostSummaryByAgentSince,
  getCostSummarySince,
  getStaleRunningRunForTask,
} from "../../core/db/queries/runs.js";
import {
  insertSubtaskEdge,
} from "../../core/db/queries/task-edges.js";
import { resolveTeamByIdOrSlug } from "../../core/db/queries/teams.js";
import {
  deleteCommentByIdAndTaskId,
  getCommentById,
  getTaskCommentById,
  insertAuthoredComment,
  listTaskComments,
} from "../../core/db/queries/comments.js";
import { DEFAULT_RUN_POLICY } from "./tasks/constants.js";
import { routeError, sendRouteError } from "./tasks/errors.js";
import {
  applyRouteSideEffects,
  applyTaskPatchById,
  bulkSummary,
  deleteTaskById,
  latestRetryStage,
  normaliseClientRequestId,
  normalizeBulkIds,
  normalizeProjectPatchValue,
  normalizeRunPolicy,
  nullableAgentName,
  replaceTaskDependencies,
  requestCommentRerun,
  resultError,
  taskOr404,
  validateBulkPatch,
  validateDependencyIds,
} from "./tasks/mutations.js";
import {
  attachContinuationLinks,
  attachLiveInputState,
  enrichTask,
  enrichTaskList,
  rowToTask,
  selectRunsWithLog,
} from "./tasks/serialization.js";

function safeArrayJson(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeQuestionAnswers(questions, rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw routeError(400, "validation", "answers object is required");
  }

  const normalized = {};
  for (const question of questions) {
    const id = String(question.id || "").trim();
    if (!id) throw routeError(400, "validation", "pending question is missing an id");
    const raw = rawAnswers[id];
    const objectValue = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const selectedValue = "selected" in objectValue ? objectValue.selected : raw;
    const text = typeof objectValue.text === "string" ? objectValue.text.trim() : "";
    const selectedRaw = Array.isArray(selectedValue)
      ? selectedValue
      : (typeof selectedValue === "string" ? [selectedValue] : []);
    const selectedInputs = selectedRaw.map((entry) => String(entry || "").trim()).filter(Boolean);
    if (!question.multi_select && selectedInputs.length > 1) {
      throw routeError(400, "validation", `question ${id} accepts only one answer`);
    }
    const options = Array.isArray(question.options) ? question.options : [];
    const labelToId = new Map();
    const validIds = new Set();
    for (const option of options) {
      const optionId = String(option.id || "").trim();
      const label = String(option.label || "").trim();
      if (optionId) validIds.add(optionId);
      if (label && optionId) labelToId.set(label, optionId);
    }
    const selected = selectedInputs.map((entry) => {
      if (validIds.has(entry)) return entry;
      if (labelToId.has(entry)) return labelToId.get(entry);
      throw routeError(400, "validation", `invalid answer for question ${id}`);
    });
    if (!question.allow_free_text && text) {
      throw routeError(400, "validation", `free-text answer is not allowed for question ${id}`);
    }
    if (selected.length === 0 && (!question.allow_free_text || !text)) {
      throw routeError(400, "validation", `answer is required for question ${id}`);
    }
    normalized[id] = { selected, text };
  }
  return normalized;
}

function formatQuestionOption(question, optionId) {
  const option = (question.options || []).find((entry) => entry.id === optionId);
  if (!option) return optionId;
  return option.description ? `${option.label} - ${option.description}` : option.label;
}

function formatQuestionAnswerComment(questions, answers) {
  const lines = ["Answered planning questions:"];
  questions.forEach((question, index) => {
    const answer = answers[question.id] || { selected: [], text: "" };
    const selected = (answer.selected || []).map((optionId) => formatQuestionOption(question, optionId));
    const parts = [];
    if (selected.length) parts.push(selected.join(", "));
    if (answer.text) parts.push(answer.text);
    lines.push("", `${index + 1}. ${question.question}`, `Answer: ${parts.join("; ")}`);
  });
  return lines.join("\n");
}


export function registerTaskRoutes(app, { db, broker, watcher, logger, dataDir, repoRoot, config }) {
  function startTaskRun(taskRow, { reason = "manual" } = {}) {
    if (taskRow?.is_team_root) {
      if (typeof watcher?.spawnLeadCycle !== "function") {
        throw routeError(501, "not_configured", "lead-cycle watcher not wired");
      }
      if (!taskRow.team_id || !taskRow.project_id) {
        throw routeError(400, "invalid_state", "team root task is missing team_id or project_id");
      }
      const out = watcher.spawnLeadCycle({ teamId: taskRow.team_id, projectId: taskRow.project_id, reason });
      if (!out?.ok) {
        throw routeError(400, out?.skipped || "invalid_state", out?.error || "lead cycle could not start");
      }
      return out;
    }
    return watcher.handleRunRequested(taskRow.id);
  }

  app.get("/api/runs/cost-summary", (req, res) => {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const weekStart = todayStart.getTime() - 6 * 24 * 60 * 60 * 1000;
    const today = getCostSummarySince(db, todayStart.getTime());
    const week = getCostSummarySince(db, weekStart);
    const byAgent = getCostSummaryByAgentSince(db, todayStart.getTime());
    res.json({
      today: {
        total_usd: Number(today.total || 0),
        run_count: today.runs,
        unpriced_run_count: Number(today.unpriced_runs || 0),
      },
      week: {
        total_usd: Number(week.total || 0),
        run_count: week.runs,
        unpriced_run_count: Number(week.unpriced_runs || 0),
      },
      today_by_agent: byAgent.map((row) => ({
        agent: row.agent_name,
        total_usd: Number(row.total || 0),
        run_count: row.runs,
        unpriced_run_count: Number(row.unpriced_runs || 0),
      })),
    });
  });

  app.get("/api/tasks", (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      return res.status(400).json({
        error: { code: "validation", message: "status is not supported; use stage" },
      });
    }
    if (req.query.stage) {
      if (!STAGES.includes(req.query.stage)) {
        return res.status(400).json({ error: { code: "validation", message: `invalid stage: ${req.query.stage}` } });
      }
      where.push("stage = ?");
      params.push(req.query.stage);
    }
    if (req.query.agent) {
      where.push("(owner_agent = ? OR planner_agent = ? OR reviewer_agent = ?)");
      params.push(req.query.agent, req.query.agent, req.query.agent);
    }
    const projectFilter = req.query.project_id || req.query.project;
    if (projectFilter) {
      if (projectFilter === "none" || projectFilter === "__none__") {
        where.push("project_id IS NULL");
      } else {
        try {
          where.push("project_id = ?");
          params.push(resolveProjectId(db, projectFilter));
        } catch (error) {
          return sendRouteError(res, error);
        }
      }
    }
    const teamFilter = req.query.team_id || req.query.team;
    if (teamFilter) {
      if (teamFilter === "none" || teamFilter === "__none__") {
        where.push(`(
          tasks.team_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM projects team_filter_project
            WHERE team_filter_project.id = tasks.project_id
              AND team_filter_project.team_id IS NOT NULL
          )
        )`);
      } else {
        const team = resolveTeamByIdOrSlug(db, teamFilter);
        if (!team) {
          return res.status(400).json({ error: { code: "validation", message: `team not found: ${teamFilter}` } });
        }
        where.push(`(
          tasks.team_id = ?
          OR (
            tasks.team_id IS NULL
            AND EXISTS (
              SELECT 1 FROM projects team_filter_project
              WHERE team_filter_project.id = tasks.project_id
                AND team_filter_project.team_id = ?
            )
          )
        )`);
        params.push(team.id, team.id);
      }
    }
    const includeTeamRoots = req.query.include_team_roots === "true" || req.query.include_team_roots === "1";
    const view = String(req.query.view || "full");
    if (!["full", "summary"].includes(view)) {
      return res.status(400).json({ error: { code: "validation", message: "invalid view" } });
    }
    const scope = String(req.query.scope || "all");
    if (!["all", "runtime"].includes(scope)) {
      return res.status(400).json({ error: { code: "validation", message: "invalid scope" } });
    }
    const rows = scope === "runtime"
      ? listRuntimeTaskRows(db, { filters: where, params, includeTeamRoots })
      : listFilteredTasks(db, { filters: where, params, includeTeamRoots });
    const baseTasks = rows.map(rowToTask);
    const tasks = scope === "runtime" || view !== "summary"
      ? enrichTaskList(db, baseTasks, config, { compactRuns: scope === "runtime" })
      : baseTasks;
    if (scope === "runtime") {
      const requestedDoneLimit = Number(req.query.done_limit ?? 0);
      const doneLimit = Math.max(0, Math.min(Number.isFinite(requestedDoneLimit) ? requestedDoneLimit : 0, 200));
      const runtime = runtimeTaskVisibility(tasks, { doneLimit });
      return res.json({ tasks: runtime.tasks, summary: runtime.summary });
    }
    res.json({ tasks });
  });

  app.post("/api/tasks", (req, res) => {
    if ("executor_agent" in (req.body || {})) {
      return res.status(400).json({
        error: { code: "validation", message: "executor_agent is not supported; use owner_agent" },
      });
    }
    if ("status" in (req.body || {})) {
      return res.status(400).json({
        error: { code: "validation", message: "status is not supported; use stage" },
      });
    }
    const {
      title,
      instructions = "",
      reviewer_agent = null,
      owner_agent = null,
      planner_agent = null,
      stage = "plan",
      run_policy = DEFAULT_RUN_POLICY,
      tags = [],
      blocked_by_ids = [],
      client_request_id = null,
      project_id = null,
      team_id: teamIdInput = undefined,
    } = req.body || {};
    const requestId = normaliseClientRequestId(client_request_id);
    if (requestId) {
      const existing = getTaskByClientRequestId(db, requestId);
      if (existing) return res.status(200).json({ task: enrichTask(db, rowToTask(existing), config) });
    }
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    if (!STAGES.includes(stage)) {
      return res.status(400).json({ error: { code: "validation", message: `invalid stage: ${stage}` } });
    }
    let normalizedRunPolicy = DEFAULT_RUN_POLICY;
    try {
      normalizedRunPolicy = normalizeRunPolicy(run_policy);
    } catch (error) {
      return res.status(400).json({ error: { code: error.code || "validation", message: error.message } });
    }
    let dependencyIds = [];
    let projectId = null;
    let teamId = null;
    try {
      dependencyIds = validateDependencyIds(db, null, blocked_by_ids);
      projectId = normalizeProjectPatchValue(db, project_id);
      if (teamIdInput !== undefined) {
        if (teamIdInput === null || teamIdInput === "") {
          teamId = null;
        } else {
          const row = resolveTeamByIdOrSlug(db, teamIdInput);
          if (!row) throw Object.assign(new Error(`team not found: ${teamIdInput}`), { status: 400, code: "validation" });
          teamId = row.id;
        }
      }
    } catch (error) {
      return res.status(400).json({ error: { code: error.code || "validation", message: error.message } });
    }
    const now = Date.now();
    let id;
    try {
      db.transaction(() => {
        id = newTaskId();
        insertTask(db, {
          id,
          taskKey: nextTaskKey(db),
          projectId,
          teamId,
          rootTaskId: id,
          clientRequestId: requestId,
          title,
          instructions,
          stage,
          ownerAgent: owner_agent,
          plannerAgent: planner_agent,
          reviewerAgent: reviewer_agent,
          runPolicy: normalizedRunPolicy,
          tagsJson: JSON.stringify(tags),
          createdAt: now,
          updatedAt: now,
        });
        replaceTaskDependencies(db, id, dependencyIds);
      })();
    } catch (error) {
      if (requestId && String(error?.code || "").includes("SQLITE_CONSTRAINT")) {
        const existing = getTaskByClientRequestId(db, requestId);
        if (existing) return res.status(200).json({ task: enrichTask(db, rowToTask(existing), config) });
      }
      throw error;
    }
    const row = getTaskById(db, id);
    const task = enrichTask(db, rowToTask(row), config);
    broker.broadcast("global", { type: "task_created", id, taskKey: task.task_key || null });
    if (!String(owner_agent || "").trim()) {
      watcher?.maybeScheduleUnassignedTeamTask?.(id, "task_created_unassigned");
    }
    watcher?.maybeAutoStart?.(id);
    res.status(201).json({ task });
  });

  app.post("/api/tasks/bulk", async (req, res) => {
    let ids;
    try {
      ids = normalizeBulkIds(req.body?.ids);
      const operation = req.body?.operation;
      if (!["patch", "delete", "run"].includes(operation)) {
        throw routeError(400, "validation", "operation must be patch, delete, or run");
      }
      if (operation === "patch") validateBulkPatch(req.body?.patch);
      if (operation === "run" && !watcher?.handleRunRequested) {
        throw routeError(501, "not_configured", "watcher not wired");
      }

      const results = [];
      for (const inputId of ids) {
        try {
          const taskRow = taskOr404(db, inputId);
          if (operation === "delete") {
            deleteTaskById({ db, broker, watcher, taskId: taskRow.id });
            results.push({ id: inputId, task_id: taskRow.id, ok: true });
            continue;
          }
          if (operation === "run") {
            const run = await watcher.handleRunRequested(taskRow.id);
            results.push({ id: inputId, task_id: taskRow.id, ok: true, runId: run?.runId || null });
            continue;
          }
          const task = applyTaskPatchById({
            db,
            broker,
            watcher,
            logger,
            taskId: taskRow.id,
            patch: req.body.patch,
            config,
          });
          results.push({ id: inputId, task_id: taskRow.id, ok: true, task });
        } catch (error) {
          const normalizedError = operation === "run" && !error.status
            ? Object.assign(error, { status: 400, code: error.code || "invalid_state" })
            : error;
          results.push({ id: inputId, ok: false, error: resultError(normalizedError) });
        }
      }

      res.json({ summary: bulkSummary(results), results });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/tasks/:id", (req, res) => {
    const row = resolveTaskRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const comments = enrichCommentRows(db, listTaskComments(db, row.id));
    const runs = attachLiveInputState(
      attachContinuationLinks(selectRunsWithLog(db, "WHERE r.task_id = ?", row.id)),
      watcher,
    );
    const task = enrichTask(db, rowToTask(row), config);
    const taskArtifacts = loadTaskArtifacts(db, row.id);
    task.artifacts = taskArtifacts.artifacts;
    task.artifact_summary = taskArtifacts.summary;
    // §9.3 is_locked: derived from coordinator.active.has(taskId). Null when
    // the watcher isn't wired so the UI can't falsely flag a stuck task.
    task.is_locked = watcher?.isActive ? !!watcher.isActive(row.id) : null;
    // R4: lifetime counters that survive `reset_failure_count`. The UI badge
    // can render "needed N retries" without scanning task_runs.
    task.health = getTaskHealth(db, row.id) || null;
    res.json(withMentions(
      { db, dataDir },
      { task, comments, runs },
      [task.title, task.instructions, comments.map((c) => c.body)],
    ));
  });

  app.patch("/api/tasks/:id", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      const task = applyTaskPatchById({
        db,
        broker,
        watcher,
        logger,
        taskId: taskRow.id,
        patch: req.body || {},
        config,
      });
      res.json({ task });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/tasks/:id/subtasks", (req, res) => {
    const parent = resolveTaskRow(db, req.params.id);
    if (!parent) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });

    const body = req.body || {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return res.status(400).json({ error: { code: "validation", message: "title is required" } });
    }
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    const ownerAgent = nullableAgentName(body.owner_agent, parent.owner_agent || null);
    const plannerAgent = nullableAgentName(body.planner_agent, parent.planner_agent || null);
    const reviewerAgent = nullableAgentName(body.reviewer_agent, parent.reviewer_agent || null);
    const required = body.required === false ? 0 : 1;
    const now = Date.now();
    const childId = newTaskId();
    const rootTaskId = parent.root_task_id || parent.id;
    const subtaskOrder = Number(getMaxSubtaskOrder(db, parent.id)) + 1;
    const shouldWait = required === 1 && !["done", "blocked"].includes(taskStage(parent));

    try {
      db.transaction(() => {
        insertManualSubtask(db, {
          id: childId,
          taskKey: nextTaskKey(db),
          rootTaskId,
          parentTaskId: parent.id,
          ownerAgent,
          plannerAgent,
          reviewerAgent,
          projectId: parent.project_id || null,
          title,
          instructions,
          runPolicy: parent.run_policy || DEFAULT_RUN_POLICY,
          subtaskOrder,
          required,
          tagsJson: JSON.stringify([]),
          createdAt: now,
          updatedAt: now,
        });
        insertSubtaskEdge(db, {
          parentTaskId: parent.id,
          childTaskId: childId,
          required,
          createdByRunId: null,
          createdAt: now,
        });
        if (shouldWait) {
          markParentAwaitingChildren(db, parent.id, now);
        } else {
          touchTaskUpdatedAt(db, parent.id, now);
        }
      })();
    } catch (error) {
      if (String(error?.code || "").includes("SQLITE_CONSTRAINT")) {
        return res.status(400).json({ error: { code: "validation", message: error.message } });
      }
      throw error;
    }

    const child = enrichTask(db, rowToTask(getTaskById(db, childId)), config);
    const updatedParent = enrichTask(db, rowToTask(getTaskById(db, parent.id)), config);
    broker.broadcast("global", { type: "task_created", id: childId, taskKey: child.task_key || null });
    broker.broadcast("global", { type: "task_updated", id: parent.id, taskKey: updatedParent.task_key || null });
    watcher?.maybeAutoStart?.(childId);
    res.status(201).json({ task: child, parent: updatedParent });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      deleteTaskById({ db, broker, watcher, taskId: taskRow.id });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.post("/api/tasks/:id/comments", async (req, res) => {
    const existing = resolveTaskRow(db, req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const { body, rerun } = req.body || {};
    if (!body || typeof body !== "string") {
      return res.status(400).json({ error: { code: "validation", message: "body is required" } });
    }
    const id = newCommentId();
    const now = Date.now();
    insertAuthoredComment(db, {
      id,
      taskId: existing.id,
      authorType: "human",
      authorId: null,
      body,
      createdAt: now,
    });
    touchTaskUpdatedAt(db, existing.id, now);
    broker.broadcast("global", { type: "task_updated", id: existing.id, taskKey: existing.task_key || null });
    const row = enrichCommentRows(db, [getCommentById(db, id)])[0];
    const payload = { comment: row };
    if (rerun === true) {
      payload.rerun = await requestCommentRerun({ db, broker, watcher, logger, taskId: existing.id });
    }
    res.status(201).json(payload);
  });

  app.post("/api/tasks/:id/pending-questions/answer", async (req, res) => {
    try {
      const existing = taskOr404(db, req.params.id);
      const questions = safeArrayJson(existing.pending_questions_json);
      if (taskStage(existing) !== "awaiting_user" || questions.length === 0) {
        throw routeError(400, "invalid_state", "task has no pending planning questions");
      }
      const answers = normalizeQuestionAnswers(questions, req.body?.answers);
      const currentStage = taskStage(existing);
      const targetStage = latestRetryStage(db, existing.id, "plan");
      const transition = nextStage(currentStage, {
        type: "human_move",
        target: targetStage,
        reason: "answered planning questions",
      });
      const errorSideEffect = transition.sideEffects.find((se) => se.type === "error");
      if (errorSideEffect) {
        throw routeError(400, "invalid_transition", errorSideEffect.message);
      }

      const id = newCommentId();
      const now = Date.now();
      const body = formatQuestionAnswerComment(questions, answers);
      db.transaction(() => {
        insertAuthoredComment(db, {
          id,
          taskId: existing.id,
          authorType: "human",
          authorId: null,
          body,
          createdAt: now,
        });
        touchTaskUpdatedAt(db, existing.id, now);
      })();
      applyRouteSideEffects(db, broker, logger, existing.id, transition.sideEffects, currentStage, transition.stage);

      const row = enrichCommentRows(db, [getCommentById(db, id)])[0];
      const payload = { comment: row, answers };
      payload.rerun = await requestCommentRerun({ db, broker, watcher, logger, taskId: existing.id });
      res.status(200).json(payload);
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.delete("/api/tasks/:id/comments/:commentId", (req, res) => {
    try {
      const existing = taskOr404(db, req.params.id);
      const requestedCommentId = String(req.params.commentId || "");
      let comment = getTaskCommentById(db, requestedCommentId, existing.id);
      if (!comment && requestedCommentId.startsWith("c-")) {
        comment = getTaskCommentById(db, requestedCommentId.slice(2), existing.id);
      }
      if (!comment) throw routeError(404, "not_found", "comment not found");
      if (comment.author_type !== "human") {
        throw routeError(403, "forbidden", "only human comments can be deleted");
      }
      const now = Date.now();
      db.transaction(() => {
        deleteCommentByIdAndTaskId(db, comment.id, existing.id);
        touchTaskUpdatedAt(db, existing.id, now);
      })();
      broker.broadcast("global", { type: "task_updated", id: existing.id, taskKey: existing.task_key || null });
      res.status(204).end();
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  app.get("/api/tasks/:id/runs", (req, res) => {
    const existing = resolveTaskRow(db, req.params.id);
    if (!existing) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const runs = attachLiveInputState(
      attachContinuationLinks(selectRunsWithLog(db, "WHERE r.task_id = ?", existing.id)),
      watcher,
    );
    res.json({ runs });
  });

  app.get("/api/tasks/:id/run-preview", (req, res) => {
    try {
      const taskRow = taskOr404(db, req.params.id);
      if (taskRow.is_team_root) {
        throw routeError(400, "invalid_state", "team root tasks use lead-cycle runs; normal run input preview is not available");
      }
      const preview = buildNextTaskRunPreview({
        db,
        taskId: taskRow.id,
        config: {
          ...(config || {}),
          dataDir: config?.dataDir || dataDir,
          repoRoot: config?.repoRoot || repoRoot,
        },
        worklabToolSurfaceMarkdown: WORKLAB_TOOL_SURFACE_MARKDOWN,
      });
      res.json({ preview });
    } catch (error) {
      if (error?.status) return sendRouteError(res, error);
      throw error;
    }
  });

  app.post("/api/tasks/:id/run", async (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    try {
      const taskRow = taskOr404(db, req.params.id);
      const currentStage = taskStage(taskRow);
      const hasFailureStreak = (taskRow.failure_count || 0) > 0 || taskRow.last_failure_kind != null;
      if (hasFailureStreak && ["plan", "execute", "review"].includes(currentStage)) {
        const transition = nextStage(currentStage, { type: "human_retry" });
        const errorSideEffect = transition.sideEffects.find((se) => se.type === "error");
        if (!errorSideEffect) {
          applyRouteSideEffects(db, broker, logger, taskRow.id, transition.sideEffects, currentStage, transition.stage);
        }
      }
      const result = await startTaskRun(taskRow);
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: { code: err.code || "invalid_state", message: err.message } });
    }
  });

  app.post("/api/tasks/:id/retry", async (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    try {
      const taskRow = taskOr404(db, req.params.id);
      const currentStage = taskStage(taskRow);
      if (["blocked", "awaiting_user"].includes(currentStage)) {
        const targetStage = latestRetryStage(db, taskRow.id, "execute");
        const transition = nextStage(currentStage, { type: "human_move", target: targetStage, reason: "retry from API" });
        const errorSideEffect = transition.sideEffects.find((se) => se.type === "error");
        if (errorSideEffect) {
          return res.status(400).json({ error: { code: "invalid_transition", message: errorSideEffect.message } });
        }
        applyRouteSideEffects(db, broker, logger, taskRow.id, transition.sideEffects, currentStage, transition.stage);
      } else if (!["plan", "execute", "review"].includes(currentStage)) {
        return res.status(400).json({ error: { code: "invalid_state", message: `cannot retry from ${currentStage}` } });
      }
      const result = await startTaskRun(taskRow, { reason: "manual_retry" });
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: { code: err.code || "invalid_state", message: err.message } });
    }
  });

  app.post("/api/tasks/:id/cancel", (req, res) => {
    if (!watcher) return res.status(501).json({ error: { code: "not_configured", message: "watcher not wired" } });
    const taskRow = resolveTaskRow(db, req.params.id);
    if (!taskRow) return res.status(404).json({ error: { code: "not_found", message: "task not found" } });
    const taskId = taskRow.id;
    // R10: structured cancel reason. Operators were leaving cancel events
    // unlabelled, which made the audit's "why was this cancelled?" pass much
    // slower. Accept an enum + optional free-text note. The free-text path
    // stays open for now (back-compat) but emits a runtime_warning so we can
    // measure adoption before tightening to a hard 400.
    const REASON_KINDS = new Set([
      "wrong_direction",
      "agent_stuck",
      "context_bloat",
      "scope_change",
      "other",
    ]);
    const reasonKindInput = typeof req.body?.reason_kind === "string" ? req.body.reason_kind.trim() : "";
    const reasonNoteInput = typeof req.body?.reason_note === "string"
      ? req.body.reason_note.trim().slice(0, 500)
      : (typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "");
    if (reasonKindInput && !REASON_KINDS.has(reasonKindInput)) {
      return res.status(400).json({
        error: {
          code: "invalid_cancel_reason",
          message: `reason_kind must be one of: ${[...REASON_KINDS].join(", ")}`,
        },
      });
    }
    const reason = reasonKindInput
      ? (reasonNoteInput ? `${reasonKindInput}: ${reasonNoteInput}` : reasonKindInput)
      : (reasonNoteInput || null);
    const cancelled = watcher.cancel(taskId, { initiator: "api_cancel", reason });
    if (cancelled) return res.status(204).end();

    // No live worker — check for a stale `running` row left behind by a crashed
    // worker or coordinator restart. If found, reconcile so the UI can move on.
    const staleRun = getStaleRunningRunForTask(db, taskId);
    if (!staleRun) return res.status(404).json({ error: { code: "not_running", message: "no active run" } });

    const now = Date.now();
    db.transaction(() => {
      applyStaleRunReconcileToRun(db, {
        runId: staleRun.id,
        endedAt: now,
        errorText: "worker exited",
        reason: reason || "stale run reconciled by API cancel",
      });
      applyStaleRunReconcileToTask(db, {
        taskId,
        retryStage: staleRun.stage || "execute",
        errorTextFallback: "Previous run did not finish",
        updatedAt: now,
      });
    })();

    broker.broadcast("global", buildRunLifecycleEvent(db, "run_ended", staleRun.id, {
      taskId,
      taskKey: taskRow.task_key || null,
    }));
    broker.broadcast("global", { type: "task_updated", id: taskId, taskKey: taskRow.task_key || null });
    res.status(204).end();
  });
}
