export const STAGES = [
  "plan",
  "execute",
  "review",
  "awaiting_children",
  "awaiting_user",
  "blocked",
  "done",
];

export const PROCESS_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
];

export const DECISIONS = [
  "advance",
  "approve",
  "reject",
  "block",
  "pause",
  "delegate",
];

export const FAILURE_KINDS = [
  "validation",
  "spawn",
  "timeout",
  "stall",
  "usage_limit",
  "invalid_result",
  "tool_failure",
  "cancelled",
  "cancelled_user",
  "cancelled_stale",
  "cancelled_signal",
  "abandoned",
  "provider_unavailable",
];

// Default failure threshold before a task auto-escalates to `blocked`.
// Override per-event via `event.maxFailures` from the watcher.
export const DEFAULT_MAX_FAILURES = 3;

// Default reviewer-rejection streak before the task escalates to `blocked`.
// Tracked separately from `retry_count` (executor failures) so a flaky reviewer
// can be diagnosed without poisoning execute-side retry budgets.
export const DEFAULT_MAX_REJECTIONS = 3;

export function legacyRunStatusToProcessStatus(status) {
  switch (status) {
    case "complete":
    case "succeeded":
      return "succeeded";
    case "error":
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "abandoned":
      return "abandoned";
    case "queued":
      return "queued";
    case "running":
    default:
      return "running";
  }
}

export function processStatusToLegacyStatus(status) {
  switch (status) {
    case "succeeded":
      return "complete";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "abandoned":
      return "error";
    case "queued":
      return "running";
    case "running":
    default:
      return "running";
  }
}

function unchanged(stage, sideEffects = []) {
  return { stage, sideEffects };
}

function change(stage, sideEffects = []) {
  return { stage, sideEffects };
}

function canStartRun(stage) {
  return ["plan", "execute", "review"].includes(stage);
}

// Side-effects emitted whenever a transition logically resets the user-facing
// "outstanding work" arrays (pending actions, blocking issues). The watcher's
// applyTx writes the JSON columns; UI consumers see them clear immediately.
const RESET_USER_ARRAYS = [
  { type: "clear_pending_actions" },
  { type: "clear_blocking_issues" },
];

export function nextStage(currentStage, event) {
  const current = currentStage;

  switch (event.type) {
    case "run_requested": {
      if (!canStartRun(current)) {
        return unchanged(current, [{ type: "error", message: `cannot run from ${current}` }]);
      }
      if (!event.agentName) {
        return unchanged(current, [{ type: "error", message: "no agent assigned" }]);
      }
      return change(current, [
        { type: "clear_error_text" },
        { type: "set_stage_reason", reason: null },
        { type: "spawn_worker", stage: event.stage || current, mode: event.mode || "execute", agentName: event.agentName },
      ]);
    }

    case "run_succeeded": {
      const result = event.result || {};
      const decision = result.decision || "advance";
      const pendingActions = Array.isArray(result.pending_actions) ? result.pending_actions.filter(Boolean) : [];
      const subtasks = Array.isArray(result.subtasks) ? result.subtasks.filter(Boolean) : [];

      if (decision !== "pause" && pendingActions.length > 0) {
        return unchanged(current, [
          { type: "error", message: `pending_actions can only be used with pause (got "${decision}")` },
        ]);
      }
      if (decision !== "delegate" && subtasks.length > 0) {
        return unchanged(current, [
          { type: "error", message: `subtasks can only be used with delegate (got "${decision}")` },
        ]);
      }

      // Review-stage runs must explicitly approve or reject. "advance" is the
      // worker's parse-failure fallback; if a reviewer falls back to it we
      // refuse to silently approve.
      if (event.stage === "review") {
        if (decision === "approve") {
          return change("done", [
            { type: "clear_error_text" },
            { type: "clear_stage_reason" },
            ...RESET_USER_ARRAYS,
            { type: "reset_failure_count" },
            { type: "reset_rejection_count" },
            { type: "clear_last_failure_kind" },
            { type: "set_completed_at" },
          ]);
        }
        if (decision === "reject") {
          const rejectionCount = (event.rejectionCount ?? 0) + 1;
          const maxRejections = event.maxRejections ?? DEFAULT_MAX_REJECTIONS;
          const rejectionEffects = [
            { type: "clear_completed_at" },
            { type: "clear_error_text" },
            ...RESET_USER_ARRAYS,
            { type: "set_rejection_count", count: rejectionCount },
            { type: "set_last_failure_kind", kind: "review_rejected" },
            { type: "set_stage_reason", reason: "review requested changes" },
            { type: "post_review_comment", notes: result.details || result.summary || "" },
          ];
          if (rejectionCount >= maxRejections) {
            return change("blocked", [
              ...rejectionEffects,
              {
                type: "set_blocking_issues",
                blockingIssues: [`Reached max review rejections (${rejectionCount}). Latest reviewer notes: ${result.details || result.summary || "—"}`],
              },
            ]);
          }
          return change("execute", rejectionEffects);
        }
        return unchanged(current, [
          { type: "error", message: `review must return approve or reject (got "${decision}")` },
        ]);
      }

      // Non-review stages: branch on decision.
      if (decision === "delegate") {
        if (subtasks.length === 0) {
          return unchanged(current, [
            { type: "error", message: "delegate requires at least one subtask" },
          ]);
        }
        return change("awaiting_children", [
          { type: "clear_error_text" },
          ...RESET_USER_ARRAYS,
          { type: "reset_failure_count" },
          { type: "set_stage_reason", reason: "waiting for delegated subtasks" },
          { type: "create_subtasks", subtasks },
        ]);
      }

      if (decision === "pause") {
        if (pendingActions.length === 0) {
          return unchanged(current, [
            { type: "error", message: "pause requires at least one pending_action" },
          ]);
        }
        return change("awaiting_user", [
          { type: "clear_error_text" },
          { type: "clear_blocking_issues" },
          { type: "reset_failure_count" },
          { type: "set_stage_reason", reason: result.summary || "awaiting user action" },
          { type: "set_pending_actions", pendingActions },
        ]);
      }

      if (decision === "block") {
        return change("blocked", [
          { type: "clear_pending_actions" },
          { type: "set_error_text", message: result.summary || "agent blocked" },
          { type: "set_stage_reason", reason: result.summary || "agent blocked" },
          { type: "set_blocking_issues", blockingIssues: result.blocking_issues || [] },
        ]);
      }

      if (decision !== "advance" && decision !== "approve") {
        return unchanged(current, [
          { type: "error", message: `unknown decision: ${decision}` },
        ]);
      }

      // Plan advance means the planner (or owner fallback) has finished
      // planning and the task is ready for actual work.
      if (event.stage === "plan") {
        return change("execute", [
          { type: "clear_error_text" },
          { type: "clear_stage_reason" },
          ...RESET_USER_ARRAYS,
          { type: "reset_failure_count" },
        ]);
      }

      // Execute advance means work is complete. If a reviewer is assigned,
      // hand off; otherwise this run is the final word.
      if (event.reviewerAgent) {
        return change("review", [
          { type: "clear_error_text" },
          { type: "clear_stage_reason" },
          ...RESET_USER_ARRAYS,
        ]);
      }
      return change("done", [
        { type: "clear_error_text" },
        { type: "clear_stage_reason" },
        ...RESET_USER_ARRAYS,
        { type: "reset_failure_count" },
        { type: "reset_rejection_count" },
        { type: "clear_last_failure_kind" },
        { type: "set_completed_at" },
      ]);
    }

    case "run_failed": {
      const message = event.message || "run failed";
      const retryStage = event.retryStage || current;
      const failureCount = (event.failureCount ?? 0) + 1;
      const maxFailures = event.maxFailures ?? DEFAULT_MAX_FAILURES;
      const failureKind = event.failureKind || "run_failed";
      const baseEffects = [
        { type: "post_error_comment", message },
        { type: "set_error_text", message },
        { type: "set_stage_reason", reason: failureKind },
        { type: "set_failure_count", count: failureCount },
        { type: "set_last_failure_kind", kind: failureKind },
      ];
      if (failureCount >= maxFailures) {
        return change("blocked", [
          ...baseEffects,
          {
            type: "set_blocking_issues",
            blockingIssues: [`Reached max failures (${failureCount}). Last error: ${message}`],
          },
        ]);
      }
      return change(retryStage, baseEffects);
    }

    case "run_cancelled": {
      // Cancellation is distinct from failure: do not increment failure_count
      // and do not write error_text. Preserve provenance when available so an
      // unattributed runtime abort is not rendered as a user action.
      const message = event.message || "Run cancelled.";
      const failureKind = event.failureKind || "";
      const initiator = event.cancelInitiator
        || (failureKind === "cancelled_signal"
          ? "signal"
          : failureKind === "cancelled_stale"
            ? "stale_reconcile"
            : failureKind === "cancelled_user"
              ? "user"
              : "runtime");
      const reasonLabel = event.cancelReason
        ? `${initiator}: ${event.cancelReason}`
        : initiator;
      return change(event.retryStage || current, [
        { type: "clear_error_text" },
        { type: "set_stage_reason", reason: `cancelled (${reasonLabel})` },
        { type: "post_cancellation_comment", message },
      ]);
    }

    case "run_abandoned": {
      // Worker died / coordinator restarted. This IS a failure path, but it
      // does not count toward the user-visible retry budget — the run never
      // really executed. Surface error_text so the user knows to re-run.
      const message = event.message || "Previous run did not finish";
      return change(event.retryStage || current, [
        { type: "post_error_comment", message },
        { type: "set_error_text", message },
        { type: "set_stage_reason", reason: "abandoned" },
        { type: "set_last_failure_kind", kind: "abandoned" },
      ]);
    }

    case "children_completed":
      if (current !== "awaiting_children") {
        return unchanged(current, [{ type: "error", message: `cannot resume children from ${current}` }]);
      }
      return change("execute", [
        { type: "clear_error_text" },
        ...RESET_USER_ARRAYS,
        { type: "set_stage_reason", reason: null },
      ]);

    case "child_blocked":
      if (current !== "awaiting_children") return unchanged(current);
      return change("blocked", [
        { type: "clear_pending_actions" },
        { type: "set_error_text", message: event.message || "required child blocked" },
        { type: "set_stage_reason", reason: "required_child_blocked" },
        { type: "set_blocking_issues", blockingIssues: [event.message || "required child blocked"] },
      ]);

    case "human_move": {
      const target = event.target;
      if (!STAGES.includes(target)) {
        return unchanged(current, [{ type: "error", message: `invalid target ${event.target}` }]);
      }
      const sideEffects = [{ type: "set_stage_reason", reason: event.reason || null }];
      if (target === "done") {
        sideEffects.push({ type: "set_completed_at" });
        sideEffects.push(...RESET_USER_ARRAYS);
        sideEffects.push({ type: "reset_failure_count" });
        sideEffects.push({ type: "reset_rejection_count" });
        sideEffects.push({ type: "clear_last_failure_kind" });
      } else {
        // Moving to anything other than done: clear arrays whose semantics
        // belong to states the user is leaving behind.
        if (current === "awaiting_user" && target !== "awaiting_user") {
          sideEffects.push({ type: "clear_pending_actions" });
        }
        if ((current === "blocked" || current === "awaiting_children") && target !== "blocked" && target !== "awaiting_children") {
          sideEffects.push({ type: "clear_blocking_issues" });
        }
      }
      if (current === "done" && target !== "done") sideEffects.push({ type: "clear_completed_at" });
      if (target !== "blocked") sideEffects.push({ type: "clear_error_text" });
      // Manually moving back into a runnable stage clears the failure budget;
      // the user is explicitly choosing to retry.
      if (canStartRun(target)) {
        sideEffects.push({ type: "reset_failure_count" });
        sideEffects.push({ type: "reset_rejection_count" });
        sideEffects.push({ type: "clear_last_failure_kind" });
      }
      return change(target, sideEffects);
    }

    default:
      return unchanged(current, [{ type: "error", message: `unknown event ${event.type}` }]);
  }
}
