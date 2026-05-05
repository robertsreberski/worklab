import {
  applyTaskSideEffects,
  nextStage,
  resolveProjectId,
  resolveTaskId,
  resolveTaskRow,
  resumeWaitingParents,
  STAGES,
  taskStage,
} from "../../../core/index.js";
import {
  cascadeProjectToDescendants,
  deleteTaskByIdRow,
  getTaskById,
  getTaskKeyById,
  updateTaskFields,
} from "../../../core/db/queries/tasks.js";
import {
  getLatestRetryStageRow,
  getRunningRunIdForTask,
  taskHasRunningRun,
} from "../../../core/db/queries/runs.js";
import {
  listDependsOnTaskIds,
  replaceDependenciesForTask,
} from "../../../core/db/queries/task-dependencies.js";
import { resolveTeamByIdOrSlug } from "../../../core/db/queries/teams.js";
import {
  BULK_PATCHABLE,
  DEFAULT_RUN_POLICY,
  PATCHABLE,
  RUN_POLICIES,
  RUNNABLE_STAGES,
} from "./constants.js";
import { routeError, rerunResponseError } from "./errors.js";
import { enrichTask, rowToTask } from "./serialization.js";

function normaliseDependencyIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim().length > 0))];
}

export function normaliseClientRequestId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 160);
}

export function normalizeRunPolicy(value, fallback = DEFAULT_RUN_POLICY) {
  if (value === undefined) return fallback;
  if (RUN_POLICIES.includes(value)) return value;
  throw Object.assign(new Error(`invalid run_policy: ${value}`), { code: "validation" });
}

function pathExists(db, startId, targetId, seen = new Set()) {
  if (startId === targetId) return true;
  if (seen.has(startId)) return false;
  seen.add(startId);
  for (const row of listDependsOnTaskIds(db, startId)) {
    if (pathExists(db, row.depends_on_task_id, targetId, seen)) return true;
  }
  return false;
}

export function validateDependencyIds(db, taskId, dependencyIds) {
  const ids = normaliseDependencyIds(dependencyIds);
  const resolvedIds = [];
  for (const inputId of ids) {
    const dependencyId = resolveTaskId(db, inputId);
    if (!dependencyId) {
      throw Object.assign(new Error(`dependency task not found: ${inputId}`), { code: "validation" });
    }
    if (taskId && dependencyId === taskId) {
      throw Object.assign(new Error("a task cannot depend on itself"), { code: "validation" });
    }
    if (taskId && pathExists(db, dependencyId, taskId)) {
      throw Object.assign(new Error("dependency would create a cycle"), { code: "validation" });
    }
    resolvedIds.push(dependencyId);
  }
  return [...new Set(resolvedIds)];
}

export function normalizeProjectPatchValue(db, value) {
  if (value === "__none__" || value === "none") return null;
  return resolveProjectId(db, value);
}

function cascadeProjectToEligibleDescendants(db, taskId, previousProjectId, nextProjectId, now) {
  return cascadeProjectToDescendants(db, {
    taskId,
    previousProjectId,
    nextProjectId,
    updatedAt: now,
  });
}

export function replaceTaskDependencies(db, taskId, dependencyIds) {
  replaceDependenciesForTask(db, taskId, dependencyIds, Date.now());
}

export function applyRouteSideEffects(db, broker, logger, taskId, sideEffects, currentStage, newStage) {
  const tx = db.transaction(() => {
    applyTaskSideEffects(db, taskId, sideEffects, currentStage, newStage, { logger });
  });
  tx();
  const taskKey = getTaskKeyById(db, taskId);
  broker.broadcast("global", { type: "task_updated", id: taskId, taskKey });
}

export function nullableAgentName(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
export function latestRetryStage(db, taskId, fallback = "execute") {
  const row = getLatestRetryStageRow(db, taskId);
  const stage = row?.retry_stage || row?.stage || fallback;
  return RUNNABLE_STAGES.includes(stage) ? stage : fallback;
}

export async function requestCommentRerun({ db, broker, watcher, logger, taskId }) {
  if (!watcher?.handleRunRequested) {
    return rerunResponseError({ code: "not_configured", message: "watcher not wired" });
  }

  const runningRow = getRunningRunIdForTask(db, taskId);
  if (watcher.isActive?.(taskId) || runningRow) {
    return rerunResponseError({ code: "already_running", message: "task already running" });
  }

  try {
    const task = getTaskById(db, taskId);
    if (!task) return rerunResponseError({ code: "not_found", message: "task not found" }, "not_found");

    const currentStage = taskStage(task);
    if (!["plan", "execute", "review"].includes(currentStage)) {
      const targetStage = currentStage === "awaiting_user"
        ? latestRetryStage(db, taskId, "plan")
        : currentStage === "done"
          ? "execute"
          : latestRetryStage(db, taskId, "execute");
      const result = nextStage(currentStage, { type: "human_move", target: targetStage });
      const errorSideEffect = result.sideEffects.find((se) => se.type === "error");
      if (errorSideEffect) {
        return rerunResponseError({ code: "invalid_transition", message: errorSideEffect.message });
      }
      applyRouteSideEffects(db, broker, logger, taskId, result.sideEffects, currentStage, result.stage);
    }

    const result = await watcher.handleRunRequested(taskId);
    return { requested: true, started: true, runId: result?.runId || null };
  } catch (error) {
    return rerunResponseError(error);
  }
}

export function applyTaskPatchById({ db, broker, watcher, logger, taskId, patch = {}, config = null }) {
  const existing = getTaskById(db, taskId);
  if (!existing) throw routeError(404, "not_found", "task not found");
  if ("executor_agent" in (patch || {})) {
    throw routeError(400, "validation", "executor_agent is not supported; use owner_agent");
  }
  if ("status" in (patch || {})) {
    throw routeError(400, "validation", "status is not supported; use stage");
  }

  const fields = [];
  const values = [];
  let stageTransition = null;

  // Non-status fields
  for (const k of PATCHABLE) {
    if (k in patch) {
      fields.push(`${k} = ?`);
      if (k === "tags") values.push(JSON.stringify(patch[k] ?? []));
      else if (k === "project_id") {
        try {
          values.push(normalizeProjectPatchValue(db, patch[k]));
        } catch (error) {
          throw routeError(error.status || 400, error.code || "validation", error.message);
        }
      }
      else if (k === "team_id") {
        if (patch[k] === null || patch[k] === "") values.push(null);
        else {
          const row = resolveTeamByIdOrSlug(db, patch[k]);
          if (!row) throw routeError(400, "validation", `team not found: ${patch[k]}`);
          values.push(row.id);
        }
      }
      else if (k === "run_policy") {
        try {
          values.push(normalizeRunPolicy(patch[k], existing.run_policy || DEFAULT_RUN_POLICY));
        } catch (error) {
          throw routeError(400, error.code || "validation", error.message);
        }
      } else values.push(patch[k]);
    }
  }

  if ("plan_body" in patch) {
    if (patch.plan_body != null && typeof patch.plan_body !== "string") {
      throw routeError(400, "validation", "plan_body must be a string");
    }
    const now = Date.now();
    fields.push("plan_body = ?");
    values.push(patch.plan_body || "");
    fields.push("plan_updated_at = ?");
    values.push(now);
    fields.push("plan_updated_by = ?");
    values.push("human");
    fields.push("plan_source_run_id = ?");
    values.push(null);
  }

  if ("stage" in patch) {
    const requested = patch.stage;
    if (!STAGES.includes(requested)) {
      throw routeError(400, "validation", "invalid stage");
    }
    const currentStage = taskStage(existing);
    const result = nextStage(currentStage, { type: "human_move", target: requested });
    const errorSideEffect = result.sideEffects.find((se) => se.type === "error");
    if (errorSideEffect) {
      throw routeError(400, "invalid_transition", errorSideEffect.message);
    }
    stageTransition = { currentStage, result };
  }

  if ("blocked_by_ids" in patch) {
    try {
      const dependencyIds = validateDependencyIds(db, taskId, patch.blocked_by_ids);
      replaceTaskDependencies(db, taskId, dependencyIds);
    } catch (error) {
      throw routeError(400, error.code || "validation", error.message);
    }
    fields.push("updated_at = ?");
    values.push(Date.now());
  }

  if (fields.length === 0 && !stageTransition) {
    return enrichTask(db, rowToTask(existing), config);
  }

  let projectCascadeCount = 0;
  if (fields.length > 0) {
    const projectIdChanged = "project_id" in patch;
    const nextProjectId = projectIdChanged ? normalizeProjectPatchValue(db, patch.project_id) : null;
    const updatedAt = Date.now();
    if (!fields.includes("updated_at = ?")) {
      fields.push("updated_at = ?");
      values.push(updatedAt);
    }
    values.push(taskId);
    db.transaction(() => {
      updateTaskFields(db, fields, values);
      if (projectIdChanged && nextProjectId !== (existing.project_id || null)) {
        projectCascadeCount = cascadeProjectToEligibleDescendants(
          db,
          taskId,
          existing.project_id || null,
          nextProjectId,
          updatedAt,
        );
      }
    })();
    broker?.broadcast?.("global", { type: "task_updated", id: taskId, taskKey: existing.task_key || null });
  }

  if (stageTransition) {
    applyRouteSideEffects(
      db,
      broker,
      logger,
      taskId,
      stageTransition.result.sideEffects,
      stageTransition.currentStage,
      stageTransition.result.stage,
    );
    if (stageTransition.result.stage === "done" || stageTransition.result.stage === "blocked") {
      resumeWaitingParents({
        db,
        childTaskId: taskId,
        applySideEffects: (parentTaskId, sideEffects, currentStage, newStage) => {
          applyRouteSideEffects(db, broker, logger, parentTaskId, sideEffects, currentStage, newStage);
        },
      });
    }
    if (stageTransition.result.stage === "done") {
      watcher?.maybeAutoStartDependents?.(taskId);
    }
  }
  const shouldCheckTeamAssignment = (
    ("owner_agent" in patch && !String(patch.owner_agent || "").trim())
    || "project_id" in patch
    || "team_id" in patch
  );
  if (shouldCheckTeamAssignment) {
    watcher?.maybeScheduleUnassignedTeamTask?.(taskId, "task_unassigned");
  }
  watcher?.maybeAutoStart?.(taskId);

  const row = getTaskById(db, taskId);
  const enriched = enrichTask(db, rowToTask(row), config);
  if (projectCascadeCount > 0) enriched.cascade = { project_id_descendants: projectCascadeCount };
  return enriched;
}

export function deleteTaskById({ db, broker, watcher, taskId }) {
  const existingTaskKey = getTaskKeyById(db, taskId);
  if (taskHasRunningRun(db, taskId) || watcher?.isActive?.(taskId)) {
    throw routeError(409, "task_running", "cancel the active run before deleting this task");
  }
  const r = deleteTaskByIdRow(db, taskId);
  if (r.changes === 0) throw routeError(404, "not_found", "task not found");
  broker?.broadcast?.("global", { type: "task_deleted", id: taskId, taskKey: existingTaskKey });
}

export function normalizeBulkIds(value) {
  if (!Array.isArray(value)) {
    throw routeError(400, "validation", "ids must be an array");
  }
  const ids = [...new Set(value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
  if (ids.length === 0) {
    throw routeError(400, "validation", "ids are required");
  }
  return ids;
}

export function validateBulkPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw routeError(400, "validation", "patch is required");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw routeError(400, "validation", "patch is required");
  }
  for (const key of keys) {
    if (!BULK_PATCHABLE.includes(key)) {
      throw routeError(400, "validation", `unsupported bulk patch field: ${key}`);
    }
  }
  if ("stage" in patch && !STAGES.includes(patch.stage)) {
    throw routeError(400, "validation", "invalid stage");
  }
  if ("run_policy" in patch) {
    try {
      normalizeRunPolicy(patch.run_policy);
    } catch (error) {
      throw routeError(400, error.code || "validation", error.message);
    }
  }
}

export function bulkSummary(results) {
  const succeeded = results.filter((result) => result.ok).length;
  return {
    requested: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
}

export function resultError(error) {
  return {
    code: error.code || "error",
    message: error.message || "failed",
    status: error.status || 500,
  };
}

export function taskOr404(db, value) {
  const task = resolveTaskRow(db, value);
  if (!task) throw routeError(404, "not_found", "task not found");
  return task;
}
