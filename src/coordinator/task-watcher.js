import {
  DEFAULT_MAX_FAILURES,
  DEFAULT_MAX_REJECTIONS,
  nextStage,
} from "../core/state-machine.js";
import { newCommentId, newTaskId } from "../core/ids.js";
import { applyTaskSideEffects, taskStage } from "../core/task-side-effects.js";
import {
  reconcileRequiredChildBlockedParents,
  resumeWaitingParents,
} from "../core/task-joins.js";
import { nextTaskKey, resolveTaskId } from "../core/task-keys.js";
import { readSettings } from "../core/settings.js";
import { recordRunResultLearning } from "../core/agent-learning.js";
import { supportsLiveInputProvider } from "../core/live-input.js";
import { buildRunLifecycleEvent } from "../core/run-events.js";
import { agentForTaskStage, missingAgentMessageForTaskStage } from "../core/task-agents.js";
import { delegationDepth } from "../core/delegation.js";
import { loadTaskArtifacts } from "../core/run-artifacts.js";
import {
  crossCheckVerificationEvidence,
  crossCheckVerificationEvidenceWithAdjudicator,
} from "../core/verification-evidence.js";
import { getTaskById, setTaskParentReviewPolicy } from "../core/db/queries/tasks.js";
import {
  getRunById,
  getRunCoreFields,
  getRunDiagnostics,
  overrideRunFailureKind,
} from "../core/db/queries/runs.js";
import {
  enabledAgentExists,
  getAgentSelfReviewFlag,
} from "../core/db/queries/agents.js";
import {
  findOpenBlocker,
  insertDependency,
  listDependentsOf,
} from "../core/db/queries/task-dependencies.js";
import {
  deleteSubtaskEdgesForParent,
  insertSubtaskEdge,
  listSubtaskChildAgents,
} from "../core/db/queries/task-edges.js";
import {
  appendDelegationDoneCriteria,
  detectSubtaskCycles,
  enforceTeamRoster,
  isQaChildAgent,
  resolveParentReviewPolicy,
} from "./watcher/delegation-handler.js";
import {
  effectiveTeamForTask,
} from "../core/teams.js";
import {
  buildFallbackResult,
  modeForStage,
  runProcessStatus,
  safeParseJson,
} from "./watcher/run-handler.js";
import { checkBudget, recordPerRunBudgetOverage } from "./watcher/budget.js";
import { spawnTaskRun } from "./watcher/spawn-run.js";
import { createAcpRunInteractionDispatcher } from "./watcher/acp-interactions.js";
import { findDrainedResumeCandidates, reconcileStaleRunningRuns } from "./watcher/stale-runs.js";
import { createLeadCycleCoordinator } from "./watcher/lead-cycle-coordinator.js";
import { createWorktreeReconciler } from "./watcher/worktree-reconciler.js";
import { createRecoveryContinuation } from "./watcher/recovery-continuation.js";
import { buildDelegationContextBlock } from "./watcher/delegation-context.js";
import { planBodySideEffect } from "./watcher/plan-body.js";
import {
  appendRunWarning,
  postAgentFinalComment,
  updateRunResult,
} from "./watcher/run-result-effects.js";
import { createPendingTaskScheduler } from "./watcher/auto-start-scheduler.js";

export { buildDelegationContextBlock } from "./watcher/delegation-context.js";

const AUTO_RUN_POLICY = "auto_plan_execute";

export function createTaskWatcher({
  db,
  broker,
  spawn,
  workerBinary,
  logger,
  repoRoot,
  dataDir,
  workspace,
  runTimeoutMs = 30 * 60 * 1000,
  runIdleWarningMs = 240 * 1000,
  logInlineLimit = 12_000,
  maxFailures = null,
  events,
  drainTimeoutMs = 60_000,
  leadCycleFollowupIntervalMs = 60_000,
}) {
  const active = new Map();
  const activeByRunId = new Map();
  // Tasks for which an auto-start has been scheduled (via setTimeout) but the
  // worker has not yet been spawned. Prevents duplicate kicks when sibling
  // children complete in the same tick or a child finishes during a fresh
  // delegation round.
  const pendingStarts = new Set();
  const recoveryTimers = new Set();

  function canAutoStart(taskId) {
    const task = getTaskById(db, taskId);
    if (!task) return false;
    const stage = taskStage(task);
    if (task.run_policy !== AUTO_RUN_POLICY) return false;
    if (task.last_failure_kind === "review_unverified") return false;
    if (!["plan", "execute", "review"].includes(stage)) return false;
    if (!agentForTaskStage(task, stage)) return false;
    if (active.has(taskId) || pendingStarts.has(taskId)) return false;
    if (hasOpenBlocker(taskId)) return false;
    return true;
  }

  const autoStartScheduler = createPendingTaskScheduler({
    active,
    pendingStarts,
    canStart: canAutoStart,
    run: handleRunRequested,
  });

  function scheduleAutoStart(taskId, onError) {
    autoStartScheduler.schedule(taskId, onError);
  }

  function maybeAutoStartTask(taskId, onError) {
    scheduleAutoStart(taskId, onError || ((err) => {
      logger?.warn?.({ err, taskId }, "task auto-run failed");
      annotateTaskFailure(taskId, { message: `Auto-run failed: ${err.message}`, failureKind: "spawn" });
    }));
  }

  function maybeAutoStartDependents(taskId, onError) {
    const rows = listDependentsOf(db, taskId);
    for (const row of rows) {
      scheduleAutoStart(row.task_id, onError || ((err) => {
        logger?.warn?.({ err, taskId: row.task_id, dependencyId: taskId }, "dependent task auto-run failed");
        annotateTaskFailure(row.task_id, { message: `Auto-run failed: ${err.message}`, failureKind: "spawn" });
      }));
    }
  }

  reconcileStaleRunningRuns(db, logger, { dataDir });

  // R5: drained-resume reconcile. Scheduling defers to a microtask so the
  // watcher closures (spawnRun, postSystemComment, …) are bound before we
  // try to reuse them. Lives in `coordinatorResumeBootstrapPromise` so
  // tests can await the boot path deterministically.
  let coordinatorResumeBootstrapPromise = null;
  function scheduleCoordinatorResumeBootstrap() {
    coordinatorResumeBootstrapPromise = Promise.resolve().then(() => {
      try {
        scheduleCoordinatorResumeContinuations();
      } catch (err) {
        logger?.warn?.({ err: err.message }, "drained-resume bootstrap failed");
      }
    });
  }

  // Apply a list of side-effects to the DB inside a single transaction, plus
  // associated task-comments. spawn_worker / spawn_reviewer / create_subtasks
  // are owned by the caller (they need spawn machinery / DB writes outside
  // this transaction) and are handled as no-ops here.
  const applyTx = db.transaction((taskId, sideEffects, currentStage, newStage, options = {}) => {
    applyTaskSideEffects(db, taskId, sideEffects, currentStage, newStage, { logger });
  });

  function maxFailureLimit() {
    const settings = readSettings(db);
    return Number(maxFailures ?? settings.max_failure_streak ?? DEFAULT_MAX_FAILURES);
  }

  function maxRejectionLimit() {
    const settings = readSettings(db);
    return Number(settings.max_rejection_streak ?? DEFAULT_MAX_REJECTIONS);
  }

  function applySideEffects(taskId, sideEffects, currentStage, newStage, options = {}) {
    applyTx(taskId, sideEffects, currentStage, newStage, options);
    broker.broadcast("global", { type: "task_updated", id: taskId });
  }

  function reconcileRequiredChildBlocksAtBoot() {
    const reconciled = reconcileRequiredChildBlockedParents({
      db,
      applySideEffects,
      onParentReady: (parentId) => {
        scheduleAutoStart(parentId, (err) => {
          logger?.warn?.({ err, parentTaskId: parentId }, "parent resume run failed");
          annotateTaskFailure(parentId, {
            message: `Parent resume failed: ${err.message}`,
            failureKind: "spawn",
            retryStage: "execute",
          });
        });
      },
    });
    if (reconciled.length > 0) {
      logger?.info?.(
        { count: reconciled.length },
        "reconciled required-child-blocked parents at boot",
      );
    }
    return reconciled;
  }

  reconcileRequiredChildBlocksAtBoot();

  function annotateTaskFailure(taskId, { message, failureKind = "spawn", retryStage }) {
    const task = getTaskById(db, taskId);
    if (!task) return;
    const stage = retryStage || taskStage(task);
    const next = nextStage(taskStage(task), {
      type: "run_failed",
      retryStage: stage,
      failureKind,
      message,
      failureCount: task.failure_count || 0,
      maxFailures: maxFailureLimit(),
    });
    applySideEffects(taskId, next.sideEffects, taskStage(task), next.stage);
  }

  function hasOpenBlocker(taskId) {
    return findOpenBlocker(db, taskId);
  }

  function latestPriorExecuteRunId(taskId) {
    return db.prepare(`
      SELECT id
      FROM task_runs
      WHERE task_id = ?
        AND mode = 'execute'
      ORDER BY ended_at DESC, started_at DESC, rowid DESC
      LIMIT 1
    `).get(taskId)?.id || null;
  }

  function reviewSubjectRunIdFor(run, taskId) {
    if (run?.parent_run_id) {
      const parent = db.prepare("SELECT id, mode FROM task_runs WHERE id = ?").get(run.parent_run_id);
      if (parent?.mode === "execute") return parent.id;
    }
    return latestPriorExecuteRunId(taskId);
  }

  function spawnRun(options) {
    return spawnTaskRun({
      db,
      broker,
      spawn,
      workerBinary,
      logger,
      repoRoot,
      dataDir,
      workspace,
      runTimeoutMs,
      runIdleWarningMs,
      logInlineLimit,
      active,
      activeByRunId,
      onWorkerExit,
      events,
      ...options,
    });
  }

  const leadCycle = createLeadCycleCoordinator({
    db,
    broker,
    logger,
    active,
    pendingStarts,
    leadCycleFollowupIntervalMs,
    spawnRun,
    postSystemComment,
    patchRunDiagnostics,
    maybeAutoStartTask,
    validateDelegationRequest,
    createDelegatedSubtasks,
    maybeRunDelegatedChildren,
    autoRunPolicy: AUTO_RUN_POLICY,
  });

  const worktreeReconciler = createWorktreeReconciler({
    db,
    broker,
    logger,
    spawnRun,
    postSystemComment,
    applySideEffects,
    patchRunDiagnostics,
  });

  const recovery = createRecoveryContinuation({
    db,
    logger,
    active,
    pendingStarts,
    recoveryTimers,
    spawnRun,
    postSystemComment,
    patchRunDiagnostics,
    applySideEffects,
    reviewSubjectRunIdFor,
  });

  async function handleRunRequested(taskId, options = {}) {
    const task = getTaskById(db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (active.has(taskId)) throw new Error("task already running");

    const stage = options.stage || taskStage(task);
    const blocker = hasOpenBlocker(taskId);
    if (blocker) throw new Error(`task is blocked by "${blocker.title}"`);

    const mode = options.mode || modeForStage(stage);
    const agentName = options.agentName || agentForTaskStage(task, stage);
    if (!agentName) throw new Error(missingAgentMessageForTaskStage(stage));

    const result = nextStage(stage, { type: "run_requested", stage, mode, agentName });
    const errorSideEffect = result.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) throw new Error(errorSideEffect.message);

    const parentRunId = options.parentRunId || (mode === "review" ? latestPriorExecuteRunId(taskId) : null);
    if (mode === "review" && !parentRunId) throw new Error("no execute run to review");

    if (mode === "review") {
      const reviewerCheck = enforceNoSelfReview({ taskId, reviewerAgent: agentName });
      if (!reviewerCheck.ok) {
        const err = new Error(reviewerCheck.message);
        err.code = "self_review_disallowed";
        throw err;
      }
    }

    if (!options.skipBudgetCheck) {
      const teamId = effectiveTeamForTask(db, task);
      const budget = checkBudget({ db, agentName, teamId });
      if (!budget.ok) {
        annotateTaskFailure(taskId, {
          message: budget.message,
          failureKind: "budget_exceeded",
          retryStage: stage,
        });
        const err = new Error(budget.message);
        err.code = "budget_exceeded";
        throw err;
      }
    }

    const run = spawnRun({ task, stage, mode, agentName, parentRunId });
    applySideEffects(taskId, result.sideEffects, stage, result.stage, { running: true });
    return run;
  }

  function enforceNoSelfReview({ taskId, reviewerAgent }) {
    const reviewer = getAgentSelfReviewFlag(db, reviewerAgent);
    if (reviewer?.allow_self_review) return { ok: true };
    const lastExecutor = db.prepare(`
      SELECT agent_name
      FROM task_runs
      WHERE task_id = ? AND mode = 'execute'
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get(taskId);
    if (!lastExecutor) return { ok: true };
    if (lastExecutor.agent_name === reviewerAgent) {
      return {
        ok: false,
        message: `${reviewerAgent} cannot review their own execute run; assign a different reviewer or enable allow_self_review on the agent.`,
      };
    }
    return { ok: true };
  }

  function postSystemComment(taskId, body) {
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
       VALUES (?, ?, 'system', ?, ?)`,
    ).run(newCommentId(), taskId, body, Date.now());
  }

  function patchRunDiagnostics(runId, patch) {
    const row = getRunDiagnostics(db, runId);
    if (!row) return;
    const existing = safeParseJson(row.diagnostics_json, {});
    db.prepare("UPDATE task_runs SET diagnostics_json = ? WHERE id = ?").run(
      JSON.stringify({
        ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
        ...patch,
      }),
      runId,
    );
  }

  function validateDelegationRequest(parentTask, subtasks) {
    const settings = readSettings(db);
    const items = Array.isArray(subtasks) ? subtasks.filter(Boolean) : [];
    if (settings.delegation_enabled === false) {
      return { ok: false, error: "delegation is disabled by settings" };
    }
    const maxDepth = Number(settings.delegation_max_depth ?? 1);
    const depth = delegationDepth(db, parentTask);
    if (depth >= maxDepth) {
      return { ok: false, error: `delegation depth limit reached (${depth}/${maxDepth})` };
    }
    if (items.length === 0) {
      return { ok: false, error: "delegate requires at least one subtask" };
    }
    const maxChildren = Number(settings.delegation_max_children_per_round ?? 5);
    if (items.length > maxChildren) {
      const error = `delegation requested ${items.length} subtasks, max is ${maxChildren}`;
      return {
        ok: false,
        error,
        failureKind: "invalid_delegation",
        diagnostics: {
          delegation_requested_children: items.length,
          delegation_max_children: maxChildren,
          delegation_validation_error: error,
        },
      };
    }
    if (detectSubtaskCycles(items)) {
      return { ok: false, error: "delegated subtasks form a dependency cycle" };
    }

    const titles = new Set();
    for (const [index, subtask] of items.entries()) {
      const title = String(subtask?.title || "").trim();
      if (!title) return { ok: false, error: `subtask ${index + 1} is missing a title` };
      if (titles.has(title)) return { ok: false, error: `duplicate subtask title: ${title}` };
      titles.add(title);

      const suggested = String(subtask?.suggested_agent || parentTask.owner_agent || "").trim();
      if (!suggested) return { ok: false, error: `subtask "${title}" has no owner agent` };
      const agent = enabledAgentExists(db, suggested) ? { name: suggested } : null;
      if (!agent) {
        return { ok: false, error: `subtask "${title}" suggested agent "${suggested}" was not found or is disabled` };
      }

      for (const dep of subtask.depends_on || []) {
        const depRef = String(dep || "").trim();
        if (!depRef) continue;
        if (depRef === title) return { ok: false, error: `subtask "${title}" cannot depend on itself` };
        if (items.some((candidate) => String(candidate?.title || "").trim() === depRef)) continue;
        if (!resolveTaskId(db, depRef)) {
          return { ok: false, error: `subtask "${title}" depends_on "${depRef}" did not resolve` };
        }
      }
    }

    // v33: roster enforcement runs against the parent task's effective team.
    // Tasks with no effective team fall through (no restriction). Lead-cycle
    // delegations always have a team and so are always checked.
    const teamId = effectiveTeamForTask(db, parentTask);
    const allowlistResult = enforceTeamRoster({
      db,
      teamId,
      subtasks: items,
      parentOwnerAgent: parentTask.owner_agent,
    });
    if (!allowlistResult.ok) {
      return {
        ok: false,
        error: allowlistResult.error,
        failureKind: allowlistResult.failureKind,
      };
    }

    return {
      ok: true,
      settings,
      subtasks: items,
      warnings: Array.isArray(allowlistResult.warnings) ? allowlistResult.warnings : [],
    };
  }

  function createDelegatedSubtasks(parentTask, runId, subtasks, options = {}) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return [];

    const created = [];
    const byTitle = new Map();
    const rootTaskId = parentTask.root_task_id || parentTask.id;
    const now = Date.now();
    const warnings = [];
    const replaceExistingEdges = options.replaceExistingEdges !== false;
    const childRunPolicy = options.childRunPolicy || parentTask.run_policy || "manual";
    const childTags = Array.isArray(options.childTags) && options.childTags.length
      ? options.childTags
      : ["delegated"];
    const childTeamId = Object.prototype.hasOwnProperty.call(options, "childTeamId")
      ? (options.childTeamId || null)
      : (parentTask.team_id || null);
    const subtaskOrderOffset = replaceExistingEdges
      ? 0
      : Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM task_edges
        WHERE parent_task_id = ? AND edge_type = 'subtask'
      `).get(parentTask.id)?.count || 0);

    // intelligence-ramp Phase 5.4: bridge parent → child context. The audit's
    // QA-execute pattern (children re-discovering work the parent already
    // did) happens because each subtask spawns as a fully independent run
    // with no view of the parent's transcript. Threading the parent's final
    // text + summary into each child's instructions gives the executor
    // enough breadcrumbs to skip rediscovery.
    const parentContextBlock = buildDelegationContextBlock({
      parentTask,
      parentRunId: runId,
      parentResult: options.parentResult || null,
    });

    // R6: resolve and persist parent_review_policy as part of the same tx
    // so a successful delegation always leaves the parent with a coherent
    // policy recorded. The watcher's later execute → review transition
    // reads this column.
    const resolvedReviewPolicy = resolveParentReviewPolicy({
      requested: options.requestedReviewPolicy,
      subtasks,
    });

    const tx = db.transaction(() => {
      // Supersede prior delegation: drop old subtask edges so
      // maybeResumeWaitingParents only tracks the current round.
      if (replaceExistingEdges) deleteSubtaskEdgesForParent(db, parentTask.id);

      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index] || {};
        if (!subtask.title || typeof subtask.title !== "string") continue;
        const suggested = subtask.suggested_agent || parentTask.owner_agent;
        const agentName = enabledAgentExists(db, suggested) ? suggested : null;
        const childId = newTaskId();
        const taskKey = nextTaskKey(db);
        const required = subtask.required === false ? 0 : 1;
        const baseInstructions = appendDelegationDoneCriteria(subtask.instructions || "", subtask);
        const instructions = parentContextBlock
          ? `${baseInstructions}\n\n${parentContextBlock}`
          : baseInstructions;
        db.prepare(`
          INSERT INTO tasks
            (id, task_key, root_task_id, parent_task_id, delegated_by_run_id, delegated_to_agent,
             owner_agent, project_id, team_id, title, instructions, stage, run_policy, join_policy, subtask_order,
             required, reviewer_agent, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', ?, 'all_required', ?, ?, ?, ?, ?, ?)
        `).run(
          childId,
          taskKey,
          rootTaskId,
          parentTask.id,
          runId,
          agentName,
          agentName,
          parentTask.project_id || null,
          childTeamId,
          subtask.title.trim(),
          instructions,
          childRunPolicy,
          subtaskOrderOffset + index,
          required,
          parentTask.reviewer_agent || null,
          JSON.stringify(childTags),
          now,
          now,
        );
        insertSubtaskEdge(db, {
          parentTaskId: parentTask.id,
          childTaskId: childId,
          required,
          createdByRunId: runId,
          createdAt: now,
        });
        created.push({ id: childId, taskKey, title: subtask.title.trim(), required: !!required, agentName });
        byTitle.set(subtask.title.trim(), childId);
      }

      for (let index = 0; index < subtasks.length; index += 1) {
        const subtask = subtasks[index] || {};
        const child = created[index];
        if (!child) continue;
        for (const dep of subtask.depends_on || []) {
          const trimmed = (dep || "").trim?.() || dep;
          let depId = byTitle.get(trimmed);
          if (!depId) {
            // Allow referring to an existing task by id (sibling created in
            // this batch already covered above; this handles cross-batch).
            depId = resolveTaskId(db, trimmed);
          }
          if (!depId || depId === child.id) {
            warnings.push(`Subtask "${subtask.title || "?"}": depends_on "${dep}" did not resolve and was dropped.`);
            continue;
          }
          insertDependency(db, child.id, depId, now);
        }
      }
      setTaskParentReviewPolicy(db, parentTask.id, resolvedReviewPolicy, now);
    });
    tx();

    if (warnings.length > 0) {
      postSystemComment(parentTask.id, `Delegation warnings:\n- ${warnings.join("\n- ")}`);
    }
    if (created.length > 0) {
      const lines = created.map((child) => `- ${child.taskKey}: ${child.title} (${child.agentName || "unassigned"}${child.required ? ", required" : ", optional"})`);
      const policyNote = resolvedReviewPolicy && resolvedReviewPolicy !== "default"
        ? `\nparent_review_policy: ${resolvedReviewPolicy}`
        : "";
      postSystemComment(parentTask.id, `Delegated ${created.length} subtask${created.length === 1 ? "" : "s"}:\n${lines.join("\n")}${policyNote}`);
    }

    for (const child of created) broker.broadcast("global", { type: "task_created", id: child.id });
    return created;
  }

  function delegatedChildRows(parentTaskId) {
    return db.prepare(`
      SELECT t.id
      FROM task_edges e
      JOIN tasks t ON t.id = e.child_task_id
      WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
      ORDER BY t.subtask_order ASC, t.created_at ASC
    `).all(parentTaskId);
  }

  function hasTaskRuns(taskId) {
    return !!db.prepare("SELECT 1 FROM task_runs WHERE task_id = ? LIMIT 1").get(taskId);
  }

  function scheduleDelegatedChildren(parentTaskId, children = null, options = {}) {
    const settings = readSettings(db);
    if (!options.force && settings.delegation_auto_run_children === false) return;
    const candidates = children || delegatedChildRows(parentTaskId);
    const childIds = new Set(delegatedChildRows(parentTaskId).map((child) => child.id));
    const activeCount = [...childIds].filter((id) => active.has(id) || pendingStarts.has(id)).length;
    const limit = Math.max(1, Number(settings.delegation_max_parallel_children ?? candidates.length));
    const slots = Math.max(0, limit - activeCount);
    if (slots <= 0) return;
    let scheduled = 0;
    for (const child of candidates) {
      if (scheduled >= slots) break;
      if (active.has(child.id) || pendingStarts.has(child.id)) continue;
      if (hasTaskRuns(child.id)) continue;
      if (!canAutoStart(child.id)) continue;
      scheduled += 1;
      scheduleAutoStart(child.id, (err) => {
        logger?.warn?.({ err, childId: child.id }, "delegated child auto-run failed");
        annotateTaskFailure(child.id, { message: `Auto-start failed: ${err.message}`, failureKind: "spawn", retryStage: "execute" });
      });
    }
  }

  function maybeRunDelegatedChildren(parentTaskId, children, options = {}) {
    scheduleDelegatedChildren(parentTaskId, children, options);
  }

  function maybeRunMoreDelegatedSiblings(childTaskId) {
    const parents = db.prepare(`
      SELECT p.id
      FROM task_edges e
      JOIN tasks p ON p.id = e.parent_task_id
      WHERE e.child_task_id = ? AND e.edge_type = 'subtask'
    `).all(childTaskId);
    for (const parent of parents) {
      const row = db.prepare("SELECT stage, is_team_root FROM tasks WHERE id = ?").get(parent.id);
      if (row?.is_team_root || taskStage(row) === "awaiting_children") {
        scheduleDelegatedChildren(parent.id, null, { force: !!row?.is_team_root });
      }
    }
  }

  function maybeResumeWaitingParents(childTaskId) {
    maybeRunMoreDelegatedSiblings(childTaskId);
    resumeWaitingParents({
      db,
      childTaskId,
      applySideEffects,
      onParentReady: (parentId) => {
        scheduleAutoStart(parentId, (err) => {
          logger?.warn?.({ err, parentTaskId: parentId }, "parent resume run failed");
          annotateTaskFailure(parentId, { message: `Parent resume failed: ${err.message}`, failureKind: "spawn", retryStage: "execute" });
        });
      },
    });
  }

  async function handleSuccessfulExit(taskId, runId, res, task, run) {
    const stage = run.stage || taskStage(task);
    const mode = run.mode || modeForStage(stage);
    const agentName = run.agent_name;
    const result = res.worklabResult || buildFallbackResult({ stage, mode, res });

    if (!result) {
      handleFailedExit(taskId, runId, {
        ...res,
        error: "invalid worklab_result",
        processStatus: "failed",
        failureKind: "invalid_result",
      }, task, run);
      return;
    }

    if (result.decision === "delegate") {
      const validation = validateDelegationRequest(task, result.subtasks);
      if (!validation.ok) {
        // R9: surface delegation_agent_not_allowed as its own failure_kind
        // instead of folding it into invalid_result, so the audit trail
        // distinguishes a planner naming an out-of-fleet agent from a
        // schema/policy mismatch.
        const failureKind = validation.failureKind || "invalid_result";
        const errorPrefix = failureKind === "delegation_agent_not_allowed"
          ? "delegation rejected"
          : "invalid delegation";
        handleFailedExit(taskId, runId, {
          ...res,
          error: `${errorPrefix}: ${validation.error}`,
          processStatus: "failed",
          failureKind,
          diagnostics: validation.diagnostics,
        }, task, run);
        return;
      }
      result.subtasks = validation.subtasks;
      // Surface any non-fatal warnings (currently none for team rosters; kept
      // for forward compatibility with future advisory checks) as soft
      // warnings + system comments without blocking the delegation round.
      if (Array.isArray(validation.warnings)) {
        for (const warning of validation.warnings) {
          appendRunWarning(db, runId, warning);
          postSystemComment(taskId, warning.message);
        }
      }
    }

    updateRunResult(db, runId, result);
    const worktreeReconcile = worktreeReconciler.reconcileSuccessfulWorktreeRun({ taskId, runId, run, stage, result });
    if (worktreeReconcile && worktreeReconcile.ok === false) return;
    postAgentFinalComment(db, {
      taskId,
      agentName,
      result,
      finalText: res.finalText,
      events: res.events,
    });
    if (worktreeReconcile?.audit?.message) {
      postSystemComment(taskId, worktreeReconcile.audit.message);
    }

    // R6: parent_review_policy + auto-approve on executor === reviewer.
    // Only relevant on the execute → review boundary; review-stage
    // transitions don't consult these (they're already inside the review
    // stage or moving to done/blocked via approve/reject). For execute we
    // detect whether any delegated child agent matches the QA pattern and
    // whether the agent that just ran is also the configured reviewer
    // (with self-review allowed) so the state machine can short-circuit
    // the redundant review pass.
    const reviewerAgent = stage === "review" ? null : (task.reviewer_agent || null);
    let parentReviewPolicy = null;
    let hasQaChild = false;
    let autoApproveSelfReview = false;
    if (stage === "execute" && reviewerAgent) {
      parentReviewPolicy = task.parent_review_policy || "default";
      const childAgents = listSubtaskChildAgents(db, taskId);
      hasQaChild = childAgents.some((agent) => isQaChildAgent(agent));
      if (agentName && reviewerAgent === agentName) {
        const reviewerFlag = getAgentSelfReviewFlag(db, reviewerAgent);
        if (reviewerFlag?.allow_self_review) {
          autoApproveSelfReview = true;
        }
      }
    }
    // intelligence-ramp Phase 4: feed the verification gate. The state
    // machine refuses (block) or warns (warn) when the reviewer approves a
    // task with code artifacts but didn't emit verification_evidence — or
    // when its evidence rows don't match any tool call in the run logs
    // (deterministic post-check against fabrication).
    let verificationMode = null;
    let hasArtifacts = false;
    let evidenceCrossCheck = null;
    if (stage === "review") {
      const settings = readSettings(db);
      verificationMode = settings?.agent_verification_gate_mode || "warn";
      if (verificationMode !== "off") {
        try {
          const taskArtifacts = loadTaskArtifacts(db, taskId, { excludeRunId: runId, fallbackToLogs: false });
          hasArtifacts = (taskArtifacts?.artifacts?.length || 0) > 0;
        } catch {
          hasArtifacts = false;
        }
        try {
          const deterministicCrossCheck = crossCheckVerificationEvidence(db, {
            reviewRunId: runId,
            parentRunId: run.parent_run_id || null,
            evidence: result?.verification_evidence,
          });
          evidenceCrossCheck = deterministicCrossCheck;
          const shouldAdjudicate = (settings?.agent_verification_adjudicator_mode || "off") === "on"
            && (deterministicCrossCheck?.unmatchedCount || 0) > 0
            && (deterministicCrossCheck?.matchedCount || 0) === 0;
          if (shouldAdjudicate) {
            evidenceCrossCheck = await crossCheckVerificationEvidenceWithAdjudicator(db, {
              reviewRunId: runId,
              parentRunId: run.parent_run_id || null,
              evidence: result?.verification_evidence,
              dataDir,
              adjudicator: {
                mode: "on",
                model: settings?.agent_verification_adjudicator_model || null,
                timeoutMs: settings?.agent_verification_adjudicator_timeout_ms || null,
                maxRows: 8,
              },
              logger,
            });
          }
          if (evidenceCrossCheck?.totalChecked) {
            patchRunDiagnostics(runId, { verification_cross_check: evidenceCrossCheck });
          }
        } catch (err) {
          logger?.warn?.({ err: err?.message || String(err), runId }, "verification evidence cross-check failed");
          evidenceCrossCheck = null;
        }
      }
    }
    const next = nextStage(taskStage(task), {
      type: "run_succeeded",
      stage,
      result,
      reviewerAgent,
      executorAgent: stage === "execute" ? agentName : null,
      parentReviewPolicy,
      hasQaChild,
      autoApproveSelfReview,
      verificationMode,
      hasArtifacts,
      evidenceCrossCheck,
      rejectionCount: task.rejection_streak || 0,
      maxRejections: maxRejectionLimit(),
    });
    const errorSideEffect = next.sideEffects.find((sideEffect) => sideEffect.type === "error");
    if (errorSideEffect) {
      logger?.error?.({ taskId, runId, message: errorSideEffect.message }, "illegal transition on run exit");
      annotateTaskFailure(taskId, {
        message: errorSideEffect.message,
        failureKind: "invalid_result",
        retryStage: stage,
      });
      return;
    }

    let sideEffects = next.sideEffects;
    if (stage === "plan") {
      const planSideEffect = planBodySideEffect(runId, agentName, result, res.finalText, res.events);
      if (planSideEffect) sideEffects = [planSideEffect, ...sideEffects];
    }

    applySideEffects(taskId, sideEffects, taskStage(task), next.stage);

    const delegated = next.sideEffects.find((sideEffect) => sideEffect.type === "create_subtasks");
    if (delegated) {
      const children = createDelegatedSubtasks(
        { ...task, stage: next.stage },
        runId,
        delegated.subtasks,
        {
          requestedReviewPolicy: result?.parent_review_policy,
          parentResult: result,
        },
      );
      maybeRunDelegatedChildren(taskId, children);
    }

    if (next.stage === "done" || next.stage === "blocked") maybeResumeWaitingParents(taskId);
    if (next.stage === "done" || next.stage === "blocked") leadCycle.maybeScheduleLeadCycle(taskId, next.stage);
    if (next.stage === "done") maybeAutoStartDependents(taskId);
    if (["plan", "execute", "review"].includes(next.stage)) maybeAutoStartTask(taskId);
  }

  function handleFailedExit(taskId, runId, res, task, run) {
    const processStatus = runProcessStatus(res);
    const stage = run.stage || taskStage(task);
    const failureKind = res.failureKind || res.failure_kind || (processStatus === "cancelled" ? "cancelled" : "spawn");
    const eventType = processStatus === "cancelled"
      ? "run_cancelled"
      : processStatus === "abandoned"
        ? "run_abandoned"
        : "run_failed";
    const sm = nextStage(taskStage(task), {
      type: eventType,
      retryStage: stage,
      failureKind,
      message: res.error || (processStatus === "cancelled" ? "Run cancelled." : "run failed"),
      failureCount: task.failure_count || 0,
      maxFailures: maxFailureLimit(),
      cancelInitiator: res.cancelInitiator || res.cancel_initiator || null,
      cancelReason: res.cancelReason || res.cancel_reason || null,
    });
    applySideEffects(taskId, sm.sideEffects, taskStage(task), sm.stage);
    db.prepare(
      `UPDATE task_runs
       SET failure_kind = COALESCE(failure_kind, ?), retry_stage = COALESCE(retry_stage, ?)
       WHERE id = ?`,
    ).run(failureKind, stage, runId);
    if (res?.diagnostics && typeof res.diagnostics === "object" && !Array.isArray(res.diagnostics)) {
      patchRunDiagnostics(runId, res.diagnostics);
    }
    recovery.maybeStartRecoveryContinuation({
      taskId,
      runId,
      res,
      task,
      run,
      stage,
      failureKind,
      processStatus,
      nextStageValue: sm.stage,
    });
    // Wake parents on every child terminal-ish exit. maybeResumeWaitingParents
    // is idempotent and per-child only fires when the child is `blocked` or
    // all required children are `done`, so this is safe even when the child
    // remains at `execute` after a cancel.
    maybeResumeWaitingParents(taskId);
  }

  async function onWorkerExit(taskId, runId, res) {
    const entry = active.get(taskId);
    if (entry?.runId === runId) active.delete(taskId);
    activeByRunId.delete(runId);
    const task = getTaskById(db, taskId);
    if (!task) return;
    const run = getRunById(db, runId);
    if (!run) return;

    const processStatus = runProcessStatus(res);

    if (run.kind === "lead_cycle") {
      leadCycle.handleLeadCycleExit(taskId, runId, res, task, run);
      recordPerRunBudgetOverage({
        db,
        runId,
        agentName: run.agent_name,
        teamId: run.team_id || (task ? effectiveTeamForTask(db, task) : null),
        costUsd: res.costUsd ?? res.cost_usd,
      });
      const endedEventLead = buildRunLifecycleEvent(db, "run_ended", runId, { taskId });
      broker.broadcast("global", endedEventLead);
      events?.emit?.("run:ended", endedEventLead);
      return;
    }

    try {
      const recorded = recordRunResultLearning(db, {
        task,
        run: { ...run, process_status: processStatus, status: res.status || run.status },
        result: res.worklabResult || safeParseJson(run.result_json, null),
        settings: readSettings(db),
      });
      if (recorded.memories?.length) {
        broker?.broadcast?.("global", { type: "agent_memory_updated", name: run.agent_name, count: recorded.memories.length });
      }
    } catch (err) {
      logger?.warn?.({ err: err.message, runId }, "failed to record agent learning memory");
    }
    if (processStatus === "succeeded" || res.status === "complete") {
      await handleSuccessfulExit(taskId, runId, res, task, run);
    } else {
      handleFailedExit(taskId, runId, res, task, run);
    }
    recordPerRunBudgetOverage({
      db,
      runId,
      agentName: run.agent_name,
      teamId: run.team_id || (task ? effectiveTeamForTask(db, task) : null),
      costUsd: res.costUsd ?? res.cost_usd,
    });

    const endedEvent = buildRunLifecycleEvent(db, "run_ended", runId, { taskId });
    broker.broadcast("global", endedEvent);
    events?.emit?.("run:ended", endedEvent);
  }

  function cancel(taskId, options = {}) {
    const entry = active.get(taskId);
    if (!entry) return false;
    entry.handle.cancel({
      initiator: options.initiator || "user",
      reason: options.reason || null,
    });
    return true;
  }

  function getRunLiveInputState(runId) {
    const run = getRunCoreFields(db, runId);
    if (!run) return { supported: false, active: false, reason: "not_found" };
    if (!supportsLiveInputProvider(run.provider_kind)) {
      return { supported: false, active: false, reason: "unsupported_provider" };
    }
    const entry = activeByRunId.get(runId);
    return {
      supported: true,
      active: !!entry,
      reason: entry ? null : "not_active",
    };
  }

  async function sendRunMessage(runId, message) {
    const entry = activeByRunId.get(runId);
    if (!entry) {
      return { ok: false, code: "run_not_active", message: "run is not active" };
    }
    if (!supportsLiveInputProvider(entry.providerKind)) {
      return { ok: false, code: "live_input_unsupported", message: "live input is not supported for this provider" };
    }
    if (typeof entry.handle?.sendLiveMessage !== "function") {
      return { ok: false, code: "live_input_unavailable", message: "worker does not accept live input" };
    }
    return entry.handle.sendLiveMessage(message);
  }
  async function sendRunApprovalDecision(runId, payload) {
    const entry = activeByRunId.get(runId);
    if (!entry) return { ok: false, code: "run_not_active", message: "run is not active" };
    if (typeof entry.handle?.sendApprovalDecision !== "function") {
      return { ok: false, code: "approval_unsupported", message: "worker does not accept approvals" };
    }
    return entry.handle.sendApprovalDecision(payload);
  }
  async function shutdown({ drainTimeoutMs: overrideDrainMs } = {}) {
    leadCycle.shutdown();
    for (const timer of recoveryTimers) clearTimeout(timer);
    recoveryTimers.clear();
    pendingStarts.clear();
    // R5: graceful drain — ask each active worker to wrap up cleanly before
    // we send SIGTERM. The drain channel rides the existing stdin pipe with
    // a `worklab_drain` message. The worker emits a `drained` event, persists
    // a transcript-tail snapshot tagged `resume_kind: "drained"`, and exits
    // cleanly within `drainTimeoutMs`. If a worker doesn't drain in time the
    // handle internally falls back to a hard cancel so shutdown still
    // completes promptly.
    const effectiveDrainMs = Number.isFinite(Number(overrideDrainMs))
      ? Number(overrideDrainMs)
      : drainTimeoutMs;
    const promises = [];
    for (const entry of active.values()) {
      const handle = entry.handle;
      if (typeof handle.drain === "function") {
        try {
          handle.drain({ timeoutMs: effectiveDrainMs, reason: "coordinator_shutdown" });
        } catch (err) {
          logger?.warn?.({ err: err.message, runId: entry.runId }, "drain dispatch failed; falling back to cancel");
          handle.cancel({ initiator: "coordinator_shutdown", reason: "coordinator stopping" });
        }
      } else {
        handle.cancel({
          initiator: "coordinator_shutdown",
          reason: "coordinator stopping",
        });
      }
      promises.push(handle.done);
    }
    await Promise.allSettled(promises);
  }

  // R5: drained-resume continuation. Called once at boot (via
  // scheduleCoordinatorResumeBootstrap) for every task_run row the previous
  // coordinator left tagged `resume_kind: "drained"`. Schedules a fresh run
  // continuation against the same task/agent/stage with `continuation_reason:
  // "coordinator_resume"` and threads the saved transcript_tail into the new
  // worker's diagnosticsSeed so it can pick up where it left off.
  function scheduleCoordinatorResumeContinuations() {
    const candidates = findDrainedResumeCandidates(db);
    if (candidates.length === 0) return [];
    const scheduled = [];
    for (const candidate of candidates) {
      try {
        const result = scheduleSingleCoordinatorResume(candidate);
        if (result) scheduled.push(result);
      } catch (err) {
        logger?.warn?.(
          { err: err.message, runId: candidate.runId, taskId: candidate.taskId },
          "drained-resume scheduling failed",
        );
      }
    }
    if (scheduled.length > 0) {
      logger?.info?.(
        { count: scheduled.length },
        "scheduled coordinator_resume continuations from drained snapshots",
      );
    }
    return scheduled;
  }

  function scheduleSingleCoordinatorResume({ runId, taskId, stage, mode, agentName, snapshot }) {
    const task = getTaskById(db, taskId);
    if (!task) return null;
    const continuationStage = ["plan", "execute", "review"].includes(stage) ? stage : taskStage(task);
    const continuationMode = mode || modeForStage(continuationStage);
    const resolvedAgent = agentName || agentForTaskStage(task, continuationStage);
    if (!resolvedAgent) {
      patchRunDiagnostics(runId, {
        continuation_skipped: true,
        continuation_skip_reason: "missing_agent",
        continuation_reason: "coordinator_resume",
      });
      return null;
    }
    if (active.has(taskId)) {
      // Something else (auto-run, manual retry) already kicked the task; let
      // that path own the run.
      patchRunDiagnostics(runId, {
        continuation_skipped: true,
        continuation_skip_reason: "task_already_running",
        continuation_reason: "coordinator_resume",
      });
      return null;
    }
    const run = getRunById(db, runId);
    if (!run) return null;
    const lineage = recovery.continuationLineage(run);
    const reviewSubjectRunId = continuationMode === "review" ? reviewSubjectRunIdFor(run, taskId) : null;
    if (continuationMode === "review" && !reviewSubjectRunId) {
      patchRunDiagnostics(runId, {
        continuation_skipped: true,
        continuation_skip_reason: "missing_review_subject",
        continuation_reason: "coordinator_resume",
      });
      return null;
    }
    postSystemComment(taskId, [
      "Automatic continuation after coordinator restart: resuming from drained worker snapshot.",
      "",
      "The previous worker was asked to drain on shutdown and persisted a transcript-tail snapshot. The continuation prompt below summarises the recent turns so you can resume rather than restart the work.",
      "",
      "Continue from the captured workspace state. Do not redo completed steps. If the workdir is dirty or unclear, inspect it (`git status`, journal tail) before resuming.",
    ].join("\n").trim());
    applySideEffects(taskId, [
      { type: "clear_error_text" },
      { type: "set_stage_reason", reason: "continuing after coordinator_resume" },
      { type: "increment_lifetime_recovery_continuation_count" },
    ], taskStage(task), continuationStage, { running: true });

    const attempt = lineage.depth + 1;
    patchRunDiagnostics(runId, {
      continuation_scheduled: true,
      continuation_delay_ms: 0,
      continuation_depth: lineage.depth,
      continuation_reason: "coordinator_resume",
      continuation_root_run_id: lineage.rootRunId,
    });
    const continuation = spawnRun({
      task: { ...task, stage: continuationStage },
      stage: continuationStage,
      mode: continuationMode,
      agentName: resolvedAgent,
      parentRunId: continuationMode === "review" ? reviewSubjectRunId : runId,
      diagnosticsSeed: {
        continuation_of_run_id: runId,
        continuation_root_run_id: lineage.rootRunId,
        continuation_reason: "coordinator_resume",
        continuation_depth: attempt,
        recovery_attempt: attempt,
        resume_snapshot: snapshot && typeof snapshot === "object" ? snapshot : undefined,
      },
    });
    patchRunDiagnostics(runId, {
      continuation_run_id: continuation.runId,
      continuation_depth: lineage.depth,
      continuation_reason: "coordinator_resume",
      continuation_root_run_id: lineage.rootRunId,
    });
    return { parentRunId: runId, continuationRunId: continuation.runId };
  }

  // Defer until the closures above are bound. Without this we'd reference
  // spawnRun / postSystemComment before they're hoisted into scope.
  scheduleCoordinatorResumeBootstrap();

  return {
    handleRunRequested,
    cancel,
    shutdown,
    isActive: (taskId) => active.has(taskId),
    isRunActive: (runId) => activeByRunId.has(runId),
    sendRunApprovalDecision,
    ...createAcpRunInteractionDispatcher(activeByRunId),
    getRunLiveInputState,
    sendRunMessage,
    maybeAutoStart: maybeAutoStartTask,
    maybeAutoStartDependents,
    maybeScheduleUnassignedTeamTask: leadCycle.maybeScheduleUnassignedTeamTask,
    tickLeadCycleFollowups: leadCycle.tickLeadCycleFollowups,
    scheduleCoordinatorResumeContinuations,
    get coordinatorResumeBootstrap() { return coordinatorResumeBootstrapPromise; },
    // v33: lead-cycle entry points used by /api/teams/:id/run-lead, the
    // worklab_team_run_lead MCP tool, and team-lead-cron.js.
    spawnLeadCycle: (opts) => leadCycle.spawnLeadCycleRunInternal(opts),
    maybeScheduleLeadCycle: leadCycle.maybeScheduleLeadCycle,
  };
}
