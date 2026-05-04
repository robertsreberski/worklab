import {
  DEFAULT_MAX_FAILURES,
  DEFAULT_MAX_REJECTIONS,
  nextStage,
} from "../core/state-machine.js";
import { appendFileSync } from "node:fs";
import { newCommentId, newTaskId } from "../core/ids.js";
import { parseVerdict } from "../core/review.js";
import { formatWorklabResultText, stripWorklabResultJson, synthesizeWorklabResult } from "../ai/result/contract.js";
import { applyTaskSideEffects, taskStage } from "../core/task-side-effects.js";
import { resumeWaitingParents } from "../core/task-joins.js";
import { nextTaskKey, resolveTaskId } from "../core/task-keys.js";
import { readSettings } from "../core/settings.js";
import { recordRunResultLearning } from "../core/agent-learning.js";
import { supportsLiveInputProvider } from "../core/live-input.js";
import { buildRunLifecycleEvent } from "../core/run-events.js";
import { agentForTaskStage, missingAgentMessageForTaskStage } from "../core/task-agents.js";
import { kbCreate, kbRead, kbUpdate } from "../core/kb.js";
import { slugify } from "../core/slugs.js";
import { retryableProviderFailureInfo } from "../ai/failure.js";
import { delegationDepth } from "../core/delegation.js";
import { reconcileRunWorktree } from "../core/worktrees.js";
import { loadTaskArtifacts } from "../core/run-artifacts.js";
import { crossCheckVerificationEvidence } from "../core/verification-evidence.js";
import { getTaskById, setTaskParentReviewPolicy } from "../core/db/queries/tasks.js";
import {
  getRunById,
  getRunCoreFields,
  getRunDiagnostics,
  getRunTranscriptTail,
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
  agentCommentBody,
  assistantTextsFromEvents,
  conciseCommentForLinkedAnswer,
  firstMeaningfulParagraph,
  richFinalAnswerFromRun,
  sanitizeAgentText,
  structuredFinalText,
} from "./watcher/final-text.js";
import {
  appendKbLink,
  firstKnowledgeSlugFromText,
  runResultKbBody,
  runResultKbSlug,
  runResultKbTags,
  runResultKbTitle,
  successfulKbWriteFromEvents,
} from "./watcher/kb-publisher.js";
import {
  appendDelegationDoneCriteria,
  detectSubtaskCycles,
  enforceProjectAgentAllowlist,
  isQaChildAgent,
  looksLikePlanBody,
  resolveParentReviewPolicy,
} from "./watcher/delegation-handler.js";
import { loadProjectAgentAllowlist } from "../core/projects.js";
import { compactRecoveryRunSummary } from "./watcher/failure-classifier.js";
import {
  buildFallbackResult,
  modeForStage,
  runProcessStatus,
  safeParseJson,
} from "./watcher/run-handler.js";
import { checkBudget, recordPerRunBudgetOverage } from "./watcher/budget.js";
import { spawnTaskRun } from "./watcher/spawn-run.js";
import { findDrainedResumeCandidates, reconcileStaleRunningRuns } from "./watcher/stale-runs.js";

const AUTO_RUN_POLICY = "auto_plan_execute";

// intelligence-ramp Phase 5.4: build a short markdown block (parent task ref +
// parent's final_text + summary) that gets appended to each child's
// instructions so the child agent has the parent's reasoning + last outcome
// without rerunning the parent's investigation. Returns "" when there's
// nothing useful to add. Exported for unit testing.
export function buildDelegationContextBlock({ parentTask, parentRunId, parentResult } = {}) {
  if (!parentTask) return "";
  const lines = ["## Parent task context"];
  const parentRef = parentTask.task_key || parentTask.id;
  lines.push(`Delegated by parent task **${parentRef}** ("${parentTask.title || ""}").`);
  if (parentRunId) lines.push(`Parent run id: \`${parentRunId}\``);
  const summary = parentResult?.summary && String(parentResult.summary).trim();
  const finalText = parentResult?.final_text && String(parentResult.final_text).trim();
  const details = parentResult?.details && String(parentResult.details).trim();
  if (summary) lines.push(`Parent summary: ${summary}`);
  if (finalText) {
    lines.push("", "**Parent final_text (read this; don't redo work it already covers):**", finalText);
  } else if (details) {
    lines.push("", "**Parent details:**", details.slice(0, 2000));
  }
  lines.push(
    "",
    "Use this context to skip rediscovery of work the parent already did. Build on it; don't restart from zero. If the parent's findings conflict with what you observe, surface the conflict in your final result rather than silently overriding.",
  );
  return lines.join("\n");
}

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
    if (!["plan", "execute", "review"].includes(stage)) return false;
    if (!agentForTaskStage(task, stage)) return false;
    if (active.has(taskId) || pendingStarts.has(taskId)) return false;
    if (hasOpenBlocker(taskId)) return false;
    return true;
  }

  function scheduleAutoStart(taskId, onError) {
    if (!canAutoStart(taskId)) return;
    if (active.has(taskId) || pendingStarts.has(taskId)) return;
    pendingStarts.add(taskId);
    setTimeout(() => {
      pendingStarts.delete(taskId);
      if (!canAutoStart(taskId)) return;
      handleRunRequested(taskId).catch(onError);
    }, 0);
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

  reconcileStaleRunningRuns(db, logger);

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
      const budget = checkBudget({ db, agentName, taskId });
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

  function persistRunResultKnowledge({ task, runId, stage, agentName, result, finalText, events, commentBody }) {
    if (!dataDir || stage !== "execute" || result?.decision !== "advance") return null;
    const richText = richFinalAnswerFromRun({ finalText, events, commentBody });
    if (!richText) return null;
    const slug = runResultKbSlug(runId);
    const title = runResultKbTitle({ task, agentName });
    const body = runResultKbBody({ task, runId, stage, agentName, richText });
    const patch = {
      title,
      body,
      tags: runResultKbTags({ task, stage, agentName }),
      category: "run-results",
      project_id: task?.project_id || null,
      pinned: false,
    };
    try {
      if (kbRead({ dataDir, slug })) {
        kbUpdate({ dataDir, slug, patch });
      } else {
        kbCreate({ dataDir, slug, author: agentName || "agent", ...patch });
      }
      broker?.broadcast?.("global", { type: "kb_updated", slug });
      return { slug, title, richText };
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err), runId, slug }, "failed to persist rich final answer");
      return null;
    }
  }

  function postAgentFinalComment(taskId, agentName, result, finalText, options = {}) {
    let body = agentCommentBody(result, finalText);
    const linkedSlug = firstKnowledgeSlugFromText(body) || firstKnowledgeSlugFromText(finalText);
    const kbWrite = linkedSlug ? { wrote: true, slug: linkedSlug } : successfulKbWriteFromEvents(options.events);
    if (kbWrite.wrote) {
      if (kbWrite.slug) body = appendKbLink(body, kbWrite.slug);
    } else {
      const kbEntry = persistRunResultKnowledge({
        ...options,
        agentName,
        result,
        finalText,
        commentBody: body,
      });
      if (kbEntry) body = appendKbLink(conciseCommentForLinkedAnswer(result, kbEntry.richText) || body, kbEntry.slug);
    }
    if (!body) return;
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author_type, author_id, body, created_at)
       VALUES (?, ?, 'agent', ?, ?, ?)`,
    ).run(newCommentId(), taskId, agentName, body, Date.now());
  }

  function updateRunResult(runId, result) {
    if (!result) return;
    db.prepare(
      `UPDATE task_runs
       SET decision = ?, summary = COALESCE(summary, ?), details = COALESCE(details, ?),
           result_json = COALESCE(result_json, ?)
       WHERE id = ?`,
    ).run(result.decision || null, result.summary || null, result.details || null, JSON.stringify(result), runId);
  }

  function planBodyFromRun(result, finalText) {
    const structuredPlan = sanitizeAgentText(result?.details);
    if (looksLikePlanBody(structuredPlan)) return structuredPlan;
    const rawPlan = sanitizeAgentText(finalText);
    if (looksLikePlanBody(rawPlan)) return rawPlan;
    for (const candidate of [structuredPlan, result?.summary, rawPlan]) {
      const body = sanitizeAgentText(candidate);
      if (body) return body;
    }
    return "";
  }

  function planBodySideEffect(runId, agentName, result, finalText) {
    const body = planBodyFromRun(result, finalText);
    if (!body) return null;
    return {
      type: "set_plan_body",
      body,
      runId,
      updatedBy: agentName || "agent",
    };
  }

  function postSystemComment(taskId, body) {
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author_type, body, created_at)
       VALUES (?, ?, 'system', ?, ?)`,
    ).run(newCommentId(), taskId, body, Date.now());
  }

  // R9: append a warning to the run's warnings_json. Used to surface non-
  // fatal events (e.g. delegation outside the project allowlist permitted
  // by the override flag) without changing run status.
  function appendRunWarning(runId, warning) {
    const row = db
      .prepare("SELECT warnings_json FROM task_runs WHERE id = ?")
      .get(runId);
    if (!row) return;
    const warnings = safeParseJson(row.warnings_json, []);
    warnings.push(warning);
    db.prepare("UPDATE task_runs SET warnings_json = ? WHERE id = ?")
      .run(JSON.stringify(warnings), runId);
  }

  function loadResumeSnapshot(runId) {
    if (!runId) return null;
    try {
      const row = getRunTranscriptTail(db, runId);
      if (!row?.transcript_tail_json) return null;
      const parsed = safeParseJson(row.transcript_tail_json, null);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
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

  function setRunWorktreeMetadata(runId, metadata) {
    db.prepare("UPDATE task_runs SET worktree_json = ? WHERE id = ?")
      .run(metadata ? JSON.stringify(metadata) : null, runId);
  }

  function shortSha(value) {
    return value ? String(value).slice(0, 7) : null;
  }

  function baseWorktreeBlockMessage(result) {
    const status = result?.status || "worktree_merge_blocked";
    if (status === "missing_worktree_metadata" || status === "missing_worktree") {
      return "Worktree merge paused because the run's AI worktree metadata is missing. Retry the execute run after checking the run workspace.";
    }
    if (status === "blocked_dirty_source") {
      return `Worktree merge paused because the source checkout has uncommitted changes: ${(result.dirty_paths || []).join(", ") || "unknown paths"}.`;
    }
    if (status === "blocked_uncommitted_worktree") {
      return `Worktree merge paused because the AI worktree has uncommitted changes: ${(result.dirty_paths || []).join(", ") || "unknown paths"}. Commit or discard those changes before retrying.`;
    }
    if (status === "merge_conflict") {
      return `Worktree merge paused because current source changes conflict with AI work: ${(result.conflict_paths || []).join(", ") || "unknown paths"}. Resolve in the AI worktree with the source checkout treated as authoritative, then retry.`;
    }
    if (status === "source_moved") {
      return "Worktree merge paused because the source checkout moved during reconciliation. Retry when the source checkout is stable.";
    }
    return `Worktree merge paused: ${status}.`;
  }

  function worktreeAuditMessage(audit, result) {
    const branch = audit.branch || "the AI branch";
    const branchHead = shortSha(audit.branch_head);
    const sourceBefore = shortSha(audit.source_head_before);
    const sourceAfter = shortSha(audit.source_head_after);
    if (audit.status === "merged") {
      return `Worktree merged into source checkout: ${sourceBefore || "unknown"} -> ${sourceAfter || "unknown"} from ${branch} (${branchHead || "unknown"}). AI branch preserved; temporary worktree ${audit.cleaned ? "cleaned" : "not cleaned"}.`;
    }
    if (audit.status === "already_up_to_date") {
      return `Worktree already in source checkout at ${sourceAfter || branchHead || "unknown"}; AI branch ${branch} is preserved.`;
    }
    const base = baseWorktreeBlockMessage(result);
    if (!audit.branch && !audit.branch_head) {
      return `${base} AI branch state could not be verified; source checkout was not changed.`;
    }
    return `${base} AI commits remain on ${branch}${branchHead ? ` at ${branchHead}` : ""}; source checkout was not changed.`;
  }

  function buildWorktreeAudit({ runId, taskId, metadata, reconcile, now = Date.now() }) {
    const status = reconcile?.status || "worktree_merge_blocked";
    const audit = {
      status,
      ok: !!reconcile?.ok,
      branch: reconcile?.metadata?.branch || metadata?.branch || null,
      source_workdir: reconcile?.metadata?.source_workdir || metadata?.source_workdir || null,
      source_git_root: reconcile?.metadata?.source_git_root || metadata?.source_git_root || null,
      worktree_root: reconcile?.metadata?.worktree_root || metadata?.worktree_root || null,
      source_head_before: reconcile?.previous_source_head || reconcile?.source_head || metadata?.source_head || null,
      source_head_after: reconcile?.ok ? (reconcile?.source_head || null) : null,
      branch_head: reconcile?.branch_head || null,
      cleaned: reconcile?.cleaned === true,
      merged_at: reconcile?.ok ? (reconcile?.merged_at || now) : null,
      dirty_paths: reconcile?.dirty_paths || [],
      conflict_paths: reconcile?.conflict_paths || [],
      run_id: runId,
      task_id: taskId,
    };
    audit.message = worktreeAuditMessage(audit, reconcile);
    return audit;
  }

  function worktreeAuditEvent(audit) {
    return {
      type: "worktree_reconcile",
      source: "worklab_coordinator",
      runId: audit.run_id,
      taskId: audit.task_id,
      status: audit.status,
      ok: audit.ok,
      message: audit.message,
      branch: audit.branch,
      sourceWorkdir: audit.source_workdir,
      sourceGitRoot: audit.source_git_root,
      worktreeRoot: audit.worktree_root,
      sourceHeadBefore: audit.source_head_before,
      sourceHeadAfter: audit.source_head_after,
      branchHead: audit.branch_head,
      cleaned: audit.cleaned,
      dirtyPaths: audit.dirty_paths,
      conflictPaths: audit.conflict_paths,
      ts: audit.merged_at || Date.now(),
    };
  }

  function appendCoordinatorRunEvent(runId, event) {
    const row = db.prepare("SELECT raw_output_path FROM task_runs WHERE id = ?").get(runId);
    const log = db.prepare("SELECT id, events FROM agent_logs WHERE task_run_id = ?").get(runId);
    const events = safeParseJson(log?.events, []);
    const safeEvents = Array.isArray(events) ? events : [];
    const maxSeq = safeEvents.reduce((max, item, index) => {
      const seq = Number(item?._event_seq);
      return Math.max(max, Number.isFinite(seq) ? seq : index + 1);
    }, 0);
    const nextEvent = {
      ...event,
      _event_seq: event._event_seq ?? maxSeq + 1,
      ts: event.ts || Date.now(),
    };
    if (log?.id) {
      db.prepare("UPDATE agent_logs SET events = ? WHERE id = ?")
        .run(JSON.stringify([...safeEvents, nextEvent]), log.id);
    }
    if (row?.raw_output_path) {
      try {
        appendFileSync(row.raw_output_path, `${JSON.stringify(nextEvent)}\n`);
      } catch (err) {
        logger?.warn?.({ err: err?.message || String(err), runId, rawLogPath: row.raw_output_path }, "raw run log write failed");
      }
    }
    broker?.broadcast?.(runId, nextEvent);
    broker?.broadcast?.("global", {
      type: "run_progress",
      runId,
      eventSeq: nextEvent._event_seq,
      eventCount: safeEvents.length + 1,
      lastEvent: nextEvent,
    });
    return nextEvent;
  }

  function reconcileSuccessfulWorktreeRun({ taskId, runId, run, stage, result }) {
    if (stage !== "execute" || result?.decision !== "advance") return { ok: true, skipped: true };
    if (run?.workspace_mode !== "worktree") return { ok: true, skipped: true };
    const metadata = safeParseJson(run.worktree_json, null);
    const reconcile = metadata?.worktree_root
      ? reconcileRunWorktree({ metadata, cleanup: true })
      : { ok: false, status: "missing_worktree_metadata", metadata };
    const audit = buildWorktreeAudit({ runId, taskId, metadata, reconcile });
    const nextMetadata = reconcile.metadata
      ? {
        ...reconcile.metadata,
        ...audit,
        last_reconcile_status: reconcile.status,
        last_reconcile_at: Date.now(),
      }
      : metadata;
    setRunWorktreeMetadata(runId, nextMetadata);
    patchRunDiagnostics(runId, { worktree: audit });
    appendCoordinatorRunEvent(runId, worktreeAuditEvent(audit));
    if (reconcile.ok) return { ...reconcile, audit };

    postSystemComment(taskId, audit.message);
    applySideEffects(taskId, [
      { type: "clear_error_text" },
      { type: "set_stage_reason", reason: audit.message },
      { type: "set_pending_actions", pendingActions: [audit.message] },
      { type: "clear_pending_questions" },
      { type: "clear_blocking_issues" },
    ], taskStage(getTaskById(db, taskId)), "awaiting_user");
    return { ...reconcile, audit };
  }

  function continuationParentRun(run) {
    const diagnostics = safeParseJson(run?.diagnostics_json, {});
    const diagnosticParentId = diagnostics.continuation_of_run_id || null;
    if (diagnosticParentId) {
      return db.prepare("SELECT id, parent_run_id, mode, stage, diagnostics_json FROM task_runs WHERE id = ?").get(diagnosticParentId) || null;
    }
    if (!run?.parent_run_id) return null;
    const parent = db.prepare("SELECT id, parent_run_id, mode, stage, diagnostics_json FROM task_runs WHERE id = ?").get(run.parent_run_id);
    if (!parent) return null;
    const runMode = run.mode || null;
    const parentMode = parent.mode || null;
    const runStage = run.stage || runMode;
    const parentStage = parent.stage || parentMode;
    if (runMode && parentMode && runMode !== parentMode) return null;
    if (runStage && parentStage && runStage !== parentStage) return null;
    return parent;
  }

  function hasRecoveryContinuation(runId) {
    return Boolean(db.prepare(`
      SELECT id
      FROM task_runs
      WHERE parent_run_id = ?
         OR (CASE
           WHEN diagnostics_json IS NOT NULL AND json_valid(diagnostics_json)
           THEN json_extract(diagnostics_json, '$.continuation_of_run_id')
           ELSE NULL
         END) = ?
      LIMIT 1
    `).get(runId, runId));
  }

  function continuationLineage(run) {
    const seen = new Set();
    const lineage = [run.id];
    let parent = continuationParentRun(run);
    while (parent && !seen.has(parent.id) && lineage.length < 50) {
      seen.add(parent.id);
      lineage.push(parent.id);
      parent = continuationParentRun(parent);
    }
    return {
      rootRunId: lineage[lineage.length - 1] || run.id,
      depth: lineage.length - 1,
      lineage,
    };
  }

  function providerRecoveryDelay(settings, attempt) {
    const base = Number(settings.agent_provider_recovery_base_delay_ms ?? 30000);
    if (!Number.isFinite(base) || base <= 0) return 0;
    const raw = Math.min(300000, Math.floor(base * (2 ** Math.max(0, attempt - 1))));
    const jitter = Math.floor(raw * 0.2 * Math.random());
    return raw + jitter;
  }

  function warningKindSet(value) {
    const warnings = Array.isArray(value) ? value : [];
    return new Set(warnings.map((warning) => warning?.kind || warning?.warning_kind || warning?.warningKind).filter(Boolean));
  }

  function schemaCorrectionFailure({ failureKind, res, run }) {
    if (failureKind === "invalid_delegation") return true;
    if (failureKind !== "invalid_result") return false;
    if (res?.resultError) return true;
    const diagnostics = {
      ...safeParseJson(run?.diagnostics_json, {}),
      ...(res?.diagnostics || {}),
    };
    const errorDetails = diagnostics.error_details || {};
    if (
      errorDetails.structured_output_retry_exhausted
      || errorDetails.claude_error_subtype === "error_max_structured_output_retries"
      || diagnostics.claude_error_subtype === "error_max_structured_output_retries"
    ) {
      return true;
    }
    const kinds = warningKindSet([
      ...safeParseJson(run?.warnings_json, []),
      ...(Array.isArray(res?.warnings) ? res.warnings : []),
    ]);
    return kinds.has("worklab_result_validation")
      || kinds.has("review_result_parse")
      || kinds.has("unstructured_result_fallback");
  }

  function recoveryReason({ failureKind, res, run, settings }) {
    if (failureKind === "usage_limit") {
      return { reason: "usage_limit", providerInfo: null };
    }
    if (schemaCorrectionFailure({ failureKind, res, run })) {
      return { reason: "schema_correction", providerInfo: null };
    }
    if (failureKind !== "provider_unavailable") return null;
    if (settings.agent_provider_recovery_enabled === false) return null;
    const diagnostics = {
      ...safeParseJson(run?.diagnostics_json, {}),
      ...(res?.diagnostics || {}),
    };
    const providerInfo = diagnostics.retryable_provider_error
      ? {
          retryable: true,
          subkind: diagnostics.provider_error_subkind || "retryable_request",
          requestId: diagnostics.provider_request_id || null,
        }
      : retryableProviderFailureInfo({
          errorText: res?.error || run?.error_text || "",
          stderrTail: diagnostics.stderr_tail || "",
          failureKind,
        });
    if (!providerInfo.retryable) return null;
    // R2 — terminated_after_completion: the audit observed Codex runs that
    // completed real work (final journal_summary call, clean worktree after a
    // commit) and *then* dropped the provider connection before emitting the
    // worklab.v2 envelope. The default provider_retry path discards the work
    // and re-runs from scratch. Detect this pattern from the captured
    // error_details and switch to a one-shot finalisation continuation that
    // just inspects the workdir and emits the JSON envelope.
    const errorDetails = diagnostics.error_details || {};
    const lastToolName = errorDetails.last_tool_name || diagnostics.last_tool_name || null;
    const hadPartialProgress = !!(errorDetails.had_partial_progress || diagnostics.had_partial_progress);
    if (hadPartialProgress && lastToolName === "journal_summary") {
      return {
        reason: "finalisation",
        providerInfo: {
          ...providerInfo,
          subkind: "terminated_after_completion",
        },
      };
    }
    return {
      reason: diagnostics.context_risk === "high" ? "provider_retryable_context_risk" : "provider_retryable",
      providerInfo,
    };
  }

  function maybeStartRecoveryContinuation({ taskId, runId, res, task, run, stage, failureKind, processStatus, nextStageValue }) {
    if (processStatus !== "failed") return null;
    if (!["plan", "execute", "review"].includes(stage)) return null;
    if (hasRecoveryContinuation(runId)) return null;
    const settings = readSettings(db);
    const recovery = recoveryReason({ failureKind, res, run, settings });
    if (!recovery) return null;
    const baseContinuationLimit = Number(settings.agent_recovery_continuation_limit ?? 3);
    // Schema-correction is bounded tighter than provider-recovery: if the
    // agent can't emit valid worklab.v2 JSON twice in a row, escalate to the
    // operator instead of burning the full provider-recovery budget on what
    // is almost certainly a stuck reviewer. Finalisation is single-shot: the
    // work is already done, all the agent has to do is re-emit the envelope.
    const continuationLimit = recovery.reason === "schema_correction"
      ? Math.min(2, baseContinuationLimit)
      : recovery.reason === "finalisation"
        ? Math.min(1, baseContinuationLimit)
        : baseContinuationLimit;
    if (continuationLimit <= 0) return null;
    const lineage = continuationLineage(run);
    if (lineage.depth >= continuationLimit) {
      postSystemComment(taskId, `Automatic continuation skipped: recovery continuation limit reached (${lineage.depth}/${continuationLimit}).`);
      patchRunDiagnostics(runId, {
        continuation_skipped: true,
        continuation_skip_reason: "limit_reached",
        continuation_reason: recovery.reason,
        continuation_depth: lineage.depth,
        continuation_limit: continuationLimit,
        continuation_root_run_id: lineage.rootRunId,
      });
      if (failureKind === "provider_unavailable") {
        const attempts = lineage.depth + 1;
        overrideRunFailureKind(db, runId, {
          failureKind: "provider_unavailable_exhausted",
          errorText: `Auto-recovery exhausted after ${attempts} attempts.`,
          details: `Auto-recovery exhausted after ${attempts} attempts.`,
        });
        const currentTask = getTaskById(db, taskId);
        const currentStage = taskStage(currentTask);
        applySideEffects(
          taskId,
          [{ type: "set_stage_reason", reason: "Provider repeatedly terminated; manual retry required." }],
          currentStage,
          currentStage,
        );
      }
      return null;
    }

    const agentName = run.agent_name || agentForTaskStage(task, stage);
    if (!agentName) return null;
    const mode = run.mode || modeForStage(stage);
    const reviewSubjectRunId = mode === "review" ? reviewSubjectRunIdFor(run, taskId) : null;
    if (mode === "review" && !reviewSubjectRunId) {
      postSystemComment(taskId, "Automatic continuation skipped: no execute run is available for review.");
      patchRunDiagnostics(runId, {
        continuation_skipped: true,
        continuation_skip_reason: "missing_review_subject",
        continuation_reason: recovery.reason,
        continuation_depth: lineage.depth,
        continuation_limit: continuationLimit,
        continuation_root_run_id: lineage.rootRunId,
      });
      return null;
    }
    const budget = checkBudget({ db, agentName, taskId });
    if (!budget.ok) {
      postSystemComment(taskId, `Automatic continuation skipped: ${budget.message}`);
      return null;
    }

    const continuationStage = ["plan", "execute", "review"].includes(nextStageValue) ? nextStageValue : stage;
    const attempt = lineage.depth + 1;
    const delayMs = recovery.reason === "usage_limit"
      || recovery.reason === "schema_correction"
      || recovery.reason === "finalisation"
      ? 0
      : providerRecoveryDelay(settings, attempt);
    const resumeSnapshot = recovery.reason === "provider_retryable" || recovery.reason === "finalisation"
      ? loadResumeSnapshot(runId)
      : null;
    const summary = compactRecoveryRunSummary({
      runId,
      res,
      reason: recovery.reason === "usage_limit"
        || recovery.reason === "schema_correction"
        || recovery.reason === "finalisation"
        ? recovery.reason
        : "provider_retryable",
      providerInfo: recovery.providerInfo,
    });
    const diagnostics = {
      ...safeParseJson(run?.diagnostics_json, {}),
      ...(res?.diagnostics || {}),
    };
    const delegationRetryGuidance = failureKind === "invalid_delegation"
      ? [
          `The previous delegation request exceeded policy: ${diagnostics.delegation_validation_error || res?.error || "invalid delegation"}.`,
          diagnostics.delegation_max_children
            ? `The max children is ${diagnostics.delegation_max_children}. Return at most that many subtasks; merge adjacent subtasks owned by the same agent or touching the same files.`
            : "Return at most the configured max children; merge adjacent subtasks owned by the same agent or touching the same files.",
          "Preserve the original work by combining instructions, acceptance criteria, expected artifacts, and depends_on references inside the fewer subtasks.",
        ]
      : [];
    const heading = recovery.reason === "usage_limit"
      ? "Automatic continuation after context-window overflow."
      : recovery.reason === "schema_correction"
        ? "Automatic schema-correction continuation after malformed Worklab result."
      : recovery.reason === "finalisation"
        ? "Automatic finalisation continuation: prior run completed work but dropped before emitting the worklab.v2 envelope."
      : mode === "review"
        ? `Automatic review continuation after retryable provider error${recovery.providerInfo?.subkind ? ` (${recovery.providerInfo.subkind})` : ""}.`
        : `Automatic continuation after retryable provider error${recovery.providerInfo?.subkind ? ` (${recovery.providerInfo.subkind})` : ""}.`;
    const retryGuidance = recovery.reason === "schema_correction"
      ? [
          ...delegationRetryGuidance,
          "Return exactly one valid `worklab.v2` JSON object that preserves your prior decision.",
          "Escape double quotes inside strings, especially in `summary`, `details`, and `final_text`.",
          "Do not use XML, tool-call syntax, or `<parameter name=...>` tags; every field must be a top-level JSON property.",
          "Do not include markdown fences or prose before or after the JSON.",
          "Do not redo completed work; inspect the prior run log, workspace, journal, or KB entries only as needed to re-emit the envelope.",
        ]
      : recovery.reason === "finalisation"
      ? [
          "The previous run already completed the work — committed the changes, called `journal_summary`, and the workdir is clean — but the provider connection dropped before it could emit the worklab.v2 envelope.",
          "Do NOT redo the work. Inspect the workdir (`git status`, `git log -1`, the journal tail), confirm the work matches the task instructions, and emit a single `worklab.v2` JSON envelope reporting the existing commit hash.",
          "If the workdir is dirty or the work is incomplete, emit a `worklab.v2` envelope with `decision: \"pause\"` and pending_actions describing what's missing — do not start a fresh implementation.",
        ]
      : [
          "Continue from the current workspace state. Do not repeat completed work. Do not repeat broad repository scans such as `Glob **/*`; inspect targeted files only and avoid generated/vendor directories.",
        ];
    postSystemComment(taskId, [
      heading,
      delayMs > 0 ? `Retrying in ${Math.round(delayMs / 1000)} seconds.` : "",
      mode === "review" && reviewSubjectRunId ? `Retrying the review against execute run \`${reviewSubjectRunId}\`.` : "",
      "",
      summary,
      "",
      ...retryGuidance,
    ].filter(Boolean).join("\n").trim());
    applySideEffects(taskId, [
      { type: "clear_error_text" },
      { type: "set_stage_reason", reason: `continuing after ${recovery.reason}` },
      { type: "increment_lifetime_recovery_continuation_count" },
    ], nextStageValue, continuationStage, { running: true });

    patchRunDiagnostics(runId, {
      continuation_scheduled: true,
      continuation_delay_ms: delayMs,
      continuation_depth: lineage.depth,
      continuation_limit: continuationLimit,
      continuation_reason: recovery.reason,
      continuation_root_run_id: lineage.rootRunId,
      retryable_provider_error: recovery.providerInfo?.retryable || undefined,
      provider_error_subkind: recovery.providerInfo?.subkind || undefined,
      provider_request_id: recovery.providerInfo?.requestId || undefined,
    });

    const startContinuation = () => {
      if (active.has(taskId)) {
        patchRunDiagnostics(runId, {
          continuation_skipped: true,
          continuation_skip_reason: "task_already_running",
        });
        return null;
      }
      const continuation = spawnRun({
        task: { ...task, stage: continuationStage },
        stage: continuationStage,
        mode,
        agentName,
        parentRunId: mode === "review" ? reviewSubjectRunId : runId,
        diagnosticsSeed: {
          continuation_of_run_id: runId,
          continuation_root_run_id: lineage.rootRunId,
          continuation_reason: recovery.reason,
          continuation_depth: attempt,
          continuation_limit: continuationLimit,
          recovery_attempt: attempt,
          recovery_delay_ms: delayMs,
          retryable_provider_error: recovery.providerInfo?.retryable || undefined,
          provider_error_subkind: recovery.providerInfo?.subkind || undefined,
          provider_request_id: recovery.providerInfo?.requestId || undefined,
          resume_snapshot: resumeSnapshot || undefined,
        },
      });
      patchRunDiagnostics(runId, {
        continuation_run_id: continuation.runId,
        continuation_depth: lineage.depth,
        continuation_limit: continuationLimit,
        continuation_reason: recovery.reason,
        continuation_root_run_id: lineage.rootRunId,
      });
      return continuation;
    };

    if (delayMs > 0) {
      pendingStarts.add(taskId);
      const timer = setTimeout(() => {
        recoveryTimers.delete(timer);
        pendingStarts.delete(taskId);
        try {
          startContinuation();
        } catch (err) {
          postSystemComment(taskId, `Automatic continuation failed to start: ${err.message || String(err)}`);
        }
      }, delayMs);
      timer.unref?.();
      recoveryTimers.add(timer);
      return { scheduled: true, delayMs };
    }

    try {
      return startContinuation();
    } catch (err) {
      postSystemComment(taskId, `Automatic continuation failed to start: ${err.message || String(err)}`);
      return null;
    }
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

    // R9: per-project agent allowlist enforcement. Loaded only when the
    // task is bound to a project — tasks without a project_id fall through
    // to "no project scope" (back-compat). An empty allowlist also falls
    // through inside enforceProjectAgentAllowlist.
    const projectAllowlist = parentTask.project_id
      ? loadProjectAgentAllowlist(db, parentTask.project_id)
      : null;
    const allowlistResult = enforceProjectAgentAllowlist({
      subtasks: items,
      parentOwnerAgent: parentTask.owner_agent,
      projectAllowlist,
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
      deleteSubtaskEdgesForParent(db, parentTask.id);

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
             owner_agent, project_id, title, instructions, stage, run_policy, join_policy, subtask_order,
             required, reviewer_agent, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'execute', ?, 'all_required', ?, ?, ?, ?, ?, ?)
        `).run(
          childId,
          taskKey,
          rootTaskId,
          parentTask.id,
          runId,
          agentName,
          agentName,
          parentTask.project_id || null,
          subtask.title.trim(),
          instructions,
          parentTask.run_policy || "manual",
          index,
          required,
          parentTask.reviewer_agent || null,
          JSON.stringify(["delegated"]),
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

  function scheduleDelegatedChildren(parentTaskId, children = null) {
    const settings = readSettings(db);
    if (settings.delegation_auto_run_children === false) return;
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

  function maybeRunDelegatedChildren(parentTaskId, children) {
    scheduleDelegatedChildren(parentTaskId, children);
  }

  function maybeRunMoreDelegatedSiblings(childTaskId) {
    const parents = db.prepare(`
      SELECT p.id
      FROM task_edges e
      JOIN tasks p ON p.id = e.parent_task_id
      WHERE e.child_task_id = ? AND e.edge_type = 'subtask'
    `).all(childTaskId);
    for (const parent of parents) {
      const row = db.prepare("SELECT stage FROM tasks WHERE id = ?").get(parent.id);
      if (taskStage(row) === "awaiting_children") scheduleDelegatedChildren(parent.id);
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

  function handleSuccessfulExit(taskId, runId, res, task, run) {
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
      // R9: when delegation_allow_unlisted is on the project, surface a
      // soft warning + system comment but proceed with the round.
      if (Array.isArray(validation.warnings)) {
        for (const warning of validation.warnings) {
          appendRunWarning(runId, warning);
          postSystemComment(taskId, warning.message);
        }
      }
    }

    updateRunResult(runId, result);
    const worktreeReconcile = reconcileSuccessfulWorktreeRun({ taskId, runId, run, stage, result });
    if (worktreeReconcile && worktreeReconcile.ok === false) return;
    postAgentFinalComment(taskId, agentName, result, res.finalText, {
      task,
      run,
      runId,
      stage,
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
      verificationMode = readSettings(db)?.agent_verification_gate_mode || "warn";
      if (verificationMode !== "off") {
        try {
          const taskArtifacts = loadTaskArtifacts(db, taskId, { excludeRunId: runId, fallbackToLogs: false });
          hasArtifacts = (taskArtifacts?.artifacts?.length || 0) > 0;
        } catch {
          hasArtifacts = false;
        }
        try {
          evidenceCrossCheck = crossCheckVerificationEvidence(db, {
            reviewRunId: runId,
            parentRunId: run.parent_run_id || null,
            evidence: result?.verification_evidence,
          });
        } catch {
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
      const planSideEffect = planBodySideEffect(runId, agentName, result, res.finalText);
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
    maybeStartRecoveryContinuation({
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

  function onWorkerExit(taskId, runId, res) {
    const entry = active.get(taskId);
    if (entry?.runId === runId) active.delete(taskId);
    activeByRunId.delete(runId);
    const task = getTaskById(db, taskId);
    if (!task) return;
    const run = getRunById(db, runId);
    if (!run) return;

    const processStatus = runProcessStatus(res);
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
      handleSuccessfulExit(taskId, runId, res, task, run);
    } else {
      handleFailedExit(taskId, runId, res, task, run);
    }
    recordPerRunBudgetOverage({ db, runId, agentName: run.agent_name, costUsd: res.costUsd ?? res.cost_usd });

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

  async function shutdown({ drainTimeoutMs: overrideDrainMs } = {}) {
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
    const lineage = continuationLineage(run);
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
    getRunLiveInputState,
    sendRunMessage,
    maybeAutoStart: maybeAutoStartTask,
    maybeAutoStartDependents,
    scheduleCoordinatorResumeContinuations,
    get coordinatorResumeBootstrap() { return coordinatorResumeBootstrapPromise; },
  };
}
