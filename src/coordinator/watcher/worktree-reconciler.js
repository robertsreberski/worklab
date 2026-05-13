import { appendFileSync } from "node:fs";
import { agentForTaskStage } from "../../core/task-agents.js";
import { taskStage } from "../../core/task-side-effects.js";
import { effectiveTeamForTask } from "../../core/teams.js";
import { reconcileRunWorktree } from "../../core/worktrees.js";
import { getRunDiagnostics } from "../../core/db/queries/runs.js";
import { getTaskById } from "../../core/db/queries/tasks.js";
import { checkBudget } from "./budget.js";
import { safeParseJson } from "./run-handler.js";

export function createWorktreeReconciler({
  db,
  broker,
  logger,
  spawnRun,
  postSystemComment,
  applySideEffects,
  patchRunDiagnostics,
}) {
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

  function worktreeConflictRetryAlreadyUsed(run) {
    if (run?.parent_relationship === "worktree_conflict_retry") return true;
    const diagnostics = safeParseJson(run?.diagnostics_json, {});
    return diagnostics?.worktree_conflict_retry === true
      || diagnostics?.worktree_conflict_retry_of_run_id
      || diagnostics?.worktree_conflict_retry?.retry_run_id;
  }

  function patchWorktreeConflictRetryDiagnostics(runId, patch) {
    const row = getRunDiagnostics(db, runId);
    const existing = safeParseJson(row?.diagnostics_json, {});
    const previous = existing?.worktree_conflict_retry && typeof existing.worktree_conflict_retry === "object"
      ? existing.worktree_conflict_retry
      : {};
    patchRunDiagnostics(runId, {
      worktree_conflict_retry: {
        ...previous,
        ...patch,
      },
    });
  }

  function worktreeConflictRetrySeed({ runId, audit }) {
    return {
      worktree_conflict_retry: true,
      worktree_conflict_retry_of_run_id: runId,
      source_workdir: audit.source_workdir || null,
      source_git_root: audit.source_git_root || null,
      source_head: audit.source_head_before || null,
      previous_branch: audit.branch || null,
      previous_branch_head: audit.branch_head || null,
      previous_worktree_root: audit.worktree_root || null,
      conflict_paths: audit.conflict_paths || [],
      guidance: [
        "The previous AI worktree conflicted with the current source checkout during merge-back.",
        "Treat the source checkout as authoritative. Use the previous AI branch only as reference.",
        "Reapply only the current task's intended changes and commit them on this fresh AI worktree branch.",
      ].join(" "),
    };
  }

  function worktreeConflictRetryComment({ audit, retryRunId }) {
    const branchHead = shortSha(audit.branch_head);
    const sourceHead = shortSha(audit.source_head_before);
    const conflicts = (audit.conflict_paths || []).map((path) => `\`${path}\``).join(", ") || "unknown paths";
    return [
      "Automatic worktree conflict retry started.",
      `Retry run: \`${retryRunId}\`.`,
      audit.branch ? `Previous AI branch: \`${audit.branch}\`${branchHead ? ` at ${branchHead}` : ""}.` : "",
      sourceHead ? `Source checkout head: ${sourceHead}.` : "",
      `Conflict paths: ${conflicts}.`,
      "The source checkout is authoritative; the retry starts from a fresh worktree based on current source truth and should use the previous AI branch only as reference.",
    ].filter(Boolean).join("\n");
  }

  function maybeStartWorktreeConflictRetry({ taskId, runId, run, task, stage, audit }) {
    if (stage !== "execute" || audit?.status !== "merge_conflict") return { started: false, reason: "not_retryable" };
    if (worktreeConflictRetryAlreadyUsed(run)) {
      patchWorktreeConflictRetryDiagnostics(runId, {
        skipped: true,
        skip_reason: "already_retried",
        conflict_paths: audit.conflict_paths || [],
        previous_branch: audit.branch || null,
        previous_branch_head: audit.branch_head || null,
        source_head: audit.source_head_before || null,
      });
      return { started: false, reason: "already_retried" };
    }

    const agentName = run?.agent_name || agentForTaskStage(task, "execute");
    if (!agentName) return { started: false, reason: "missing_agent" };
    const teamId = effectiveTeamForTask(db, task);
    const budget = checkBudget({ db, agentName, teamId });
    if (!budget.ok) {
      patchWorktreeConflictRetryDiagnostics(runId, {
        skipped: true,
        skip_reason: "budget_exceeded",
        message: budget.message,
      });
      return { started: false, reason: "budget_exceeded", message: budget.message };
    }

    const diagnosticsSeed = worktreeConflictRetrySeed({ runId, audit });
    try {
      const retry = spawnRun({
        task: { ...task, stage: "execute" },
        stage: "execute",
        mode: run?.mode || "execute",
        agentName,
        parentRunId: runId,
        diagnosticsSeed,
      });
      patchWorktreeConflictRetryDiagnostics(runId, {
        scheduled: true,
        retry_run_id: retry.runId,
        conflict_paths: audit.conflict_paths || [],
        previous_branch: audit.branch || null,
        previous_branch_head: audit.branch_head || null,
        previous_worktree_root: audit.worktree_root || null,
        source_head: audit.source_head_before || null,
      });
      postSystemComment(taskId, worktreeConflictRetryComment({ audit, retryRunId: retry.runId }));
      applySideEffects(taskId, [
        { type: "clear_error_text" },
        { type: "set_stage_reason", reason: "retrying after worktree merge conflict" },
        { type: "clear_pending_actions" },
        { type: "clear_pending_questions" },
        { type: "clear_blocking_issues" },
      ], taskStage(getTaskById(db, taskId)), "execute", { running: true });
      return { started: true, runId: retry.runId };
    } catch (err) {
      patchWorktreeConflictRetryDiagnostics(runId, {
        skipped: true,
        skip_reason: "spawn_failed",
        message: err?.message || String(err),
      });
      postSystemComment(taskId, `Automatic worktree conflict retry failed to start: ${err?.message || String(err)}`);
      return { started: false, reason: "spawn_failed", message: err?.message || String(err) };
    }
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

    const retry = maybeStartWorktreeConflictRetry({ taskId, runId, run, task: getTaskById(db, taskId), stage, audit });
    if (retry?.started) return { ...reconcile, audit, autoRetry: retry };

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

  return { reconcileSuccessfulWorktreeRun };
}
