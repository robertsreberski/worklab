import {
  DEFAULT_MAX_FAILURES,
  DEFAULT_MAX_REJECTIONS,
  nextStage,
} from "../core/state-machine.js";
import { newCommentId, newTaskId } from "../core/ids.js";
import { parseVerdict } from "../core/review.js";
import { formatWorklabResultText, stripWorklabResultJson, synthesizeWorklabResult } from "../ai/result/contract.js";
import { applyTaskSideEffects, taskStage } from "../core/task-side-effects.js";
import { resumeWaitingParents } from "../core/task-joins.js";
import { nextTaskKey, resolveTaskId } from "../core/task-keys.js";
import { readSettings } from "../core/settings.js";
import { supportsLiveInputProvider } from "../core/live-input.js";
import { buildRunLifecycleEvent } from "../core/run-events.js";
import { agentForTaskStage, missingAgentMessageForTaskStage } from "../core/task-agents.js";
import { kbCreate, kbRead, kbUpdate } from "../core/kb.js";
import { slugify } from "../core/slugs.js";
import { retryableProviderFailureInfo } from "../ai/failure.js";
import { delegationDepth } from "../core/delegation.js";
import { getTaskById } from "../core/db/queries/tasks.js";
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
  looksLikePlanBody,
} from "./watcher/delegation-handler.js";
import { compactRecoveryRunSummary } from "./watcher/failure-classifier.js";
import {
  buildFallbackResult,
  modeForStage,
  runProcessStatus,
  safeParseJson,
} from "./watcher/run-handler.js";
import { checkBudget, recordPerRunBudgetOverage } from "./watcher/budget.js";
import { spawnTaskRun } from "./watcher/spawn-run.js";
import { reconcileStaleRunningRuns } from "./watcher/stale-runs.js";

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
  runIdleWarningMs = 120 * 1000,
  logInlineLimit = 12_000,
  maxFailures = null,
  events,
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
    if (failureKind !== "invalid_result") return false;
    if (res?.resultError) return true;
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
    const continuationLimit = Number(settings.agent_recovery_continuation_limit ?? 3);
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
    const delayMs = recovery.reason === "usage_limit" || recovery.reason === "schema_correction"
      ? 0
      : providerRecoveryDelay(settings, attempt);
    const resumeSnapshot = recovery.reason === "provider_retryable"
      ? loadResumeSnapshot(runId)
      : null;
    const summary = compactRecoveryRunSummary({
      runId,
      res,
      reason: recovery.reason === "usage_limit" || recovery.reason === "schema_correction"
        ? recovery.reason
        : "provider_retryable",
      providerInfo: recovery.providerInfo,
    });
    const heading = recovery.reason === "usage_limit"
      ? "Automatic continuation after context-window overflow."
      : recovery.reason === "schema_correction"
        ? "Automatic schema-correction continuation after malformed Worklab result."
      : mode === "review"
        ? `Automatic review continuation after retryable provider error${recovery.providerInfo?.subkind ? ` (${recovery.providerInfo.subkind})` : ""}.`
        : `Automatic continuation after retryable provider error${recovery.providerInfo?.subkind ? ` (${recovery.providerInfo.subkind})` : ""}.`;
    const retryGuidance = recovery.reason === "schema_correction"
      ? [
          "Return exactly one valid `worklab.v2` JSON object that preserves your prior decision.",
          "Escape double quotes inside strings, especially in `summary`, `details`, and `final_text`.",
          "Do not include markdown fences or prose before or after the JSON.",
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
      return { ok: false, error: `delegation requested ${items.length} subtasks, max is ${maxChildren}` };
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

    return { ok: true, settings, subtasks: items };
  }

  function createDelegatedSubtasks(parentTask, runId, subtasks) {
    if (!Array.isArray(subtasks) || subtasks.length === 0) return [];

    const created = [];
    const byTitle = new Map();
    const rootTaskId = parentTask.root_task_id || parentTask.id;
    const now = Date.now();
    const warnings = [];

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
        const instructions = appendDelegationDoneCriteria(subtask.instructions || "", subtask);
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
    });
    tx();

    if (warnings.length > 0) {
      postSystemComment(parentTask.id, `Delegation warnings:\n- ${warnings.join("\n- ")}`);
    }
    if (created.length > 0) {
      const lines = created.map((child) => `- ${child.taskKey}: ${child.title} (${child.agentName || "unassigned"}${child.required ? ", required" : ", optional"})`);
      postSystemComment(parentTask.id, `Delegated ${created.length} subtask${created.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
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
        handleFailedExit(taskId, runId, {
          ...res,
          error: `invalid delegation: ${validation.error}`,
          processStatus: "failed",
          failureKind: "invalid_result",
        }, task, run);
        return;
      }
      result.subtasks = validation.subtasks;
    }

    updateRunResult(runId, result);
    postAgentFinalComment(taskId, agentName, result, res.finalText, {
      task,
      run,
      runId,
      stage,
      events: res.events,
    });

    const next = nextStage(taskStage(task), {
      type: "run_succeeded",
      stage,
      result,
      reviewerAgent: stage === "review" ? null : (task.reviewer_agent || null),
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
      const children = createDelegatedSubtasks({ ...task, stage: next.stage }, runId, delegated.subtasks);
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

  async function shutdown() {
    for (const timer of recoveryTimers) clearTimeout(timer);
    recoveryTimers.clear();
    pendingStarts.clear();
    const promises = [];
    for (const entry of active.values()) {
      entry.handle.cancel({
        initiator: "coordinator_shutdown",
        reason: "coordinator stopping",
      });
      promises.push(entry.handle.done);
    }
    await Promise.allSettled(promises);
  }

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
  };
}
