import { newCommentId } from "./ids.js";
import { insertSystemComment } from "./db/queries/comments.js";

export function taskStage(task) {
  return task?.stage || "plan";
}

export function applyTaskSideEffects(db, taskId, sideEffects, currentStage, newStage, { now = Date.now(), logger } = {}) {
  const fields = [];
  const values = [];
  if (currentStage !== newStage) {
    fields.push("stage = ?");
    values.push(newStage);
  }

  for (const sideEffect of sideEffects || []) {
    switch (sideEffect.type) {
      case "set_completed_at":
        fields.push("completed_at = ?");
        values.push(now);
        break;
      case "clear_completed_at":
        fields.push("completed_at = ?");
        values.push(null);
        break;
      case "clear_error_text":
        fields.push("error_text = ?");
        values.push(null);
        break;
      case "set_error_text":
        fields.push("error_text = ?");
        values.push(sideEffect.message || "run failed");
        break;
      case "set_stage_reason":
        fields.push("stage_reason = ?");
        values.push(sideEffect.reason || null);
        break;
      case "clear_stage_reason":
        fields.push("stage_reason = ?");
        values.push(null);
        break;
      case "set_pending_actions":
        fields.push("pending_actions_json = ?");
        values.push(JSON.stringify(sideEffect.pendingActions || []));
        break;
      case "clear_pending_actions":
        fields.push("pending_actions_json = ?");
        values.push("[]");
        break;
      case "set_blocking_issues":
        fields.push("blocking_issues_json = ?");
        values.push(JSON.stringify(sideEffect.blockingIssues || []));
        break;
      case "clear_blocking_issues":
        fields.push("blocking_issues_json = ?");
        values.push("[]");
        break;
      case "set_failure_count":
        fields.push("failure_count = ?");
        values.push(sideEffect.count ?? 0);
        break;
      case "reset_failure_count":
        fields.push("failure_count = ?");
        values.push(0);
        break;
      case "set_rejection_count":
        fields.push("rejection_streak = ?");
        values.push(sideEffect.count ?? 0);
        break;
      case "reset_rejection_count":
        fields.push("rejection_streak = ?");
        values.push(0);
        break;
      case "set_last_failure_kind":
        fields.push("last_failure_kind = ?");
        values.push(sideEffect.kind || null);
        break;
      case "clear_last_failure_kind":
        fields.push("last_failure_kind = ?");
        values.push(null);
        break;
      case "post_error_comment":
        insertSystemComment(db, {
          id: newCommentId(),
          taskId,
          body: `ERROR: ${sideEffect.message || "run failed"}`,
          createdAt: now,
        });
        break;
      case "post_cancellation_comment":
        insertSystemComment(db, {
          id: newCommentId(),
          taskId,
          body: sideEffect.message || "Run cancelled.",
          createdAt: now,
        });
        break;
      case "post_review_comment": {
        const body = sideEffect.notes && sideEffect.notes.trim().length > 0
          ? sideEffect.notes
          : "Review rejected.";
        insertSystemComment(db, { id: newCommentId(), taskId, body, createdAt: now });
        break;
      }
      case "post_review_verdict":
        insertSystemComment(db, {
          id: newCommentId(),
          taskId,
          body: `VERDICT: ${sideEffect.verdict}`,
          createdAt: now,
        });
        break;
      case "set_plan_body":
        if (typeof sideEffect.body === "string") {
          fields.push("plan_body = ?");
          values.push(sideEffect.body);
          fields.push("plan_updated_at = ?");
          values.push(now);
          fields.push("plan_updated_by = ?");
          values.push(sideEffect.updatedBy || "agent");
          fields.push("plan_source_run_id = ?");
          values.push(sideEffect.runId || null);
        }
        break;
      // Spawn / cross-table directives are dispatched by the caller (watcher
      // for spawn_worker/spawn_reviewer, watcher for create_subtasks). They
      // appear in the side-effect list so the state machine can describe a
      // complete intended outcome, but the DB tx applier intentionally
      // ignores them. See `task-watcher.js` (`applyTx`).
      case "spawn_worker":
      case "spawn_reviewer":
      case "create_subtasks":
        break;
      case "error":
        logger?.warn?.({ taskId, message: sideEffect.message }, "state machine emitted error side effect");
        break;
      default:
        logger?.warn?.({ taskId, type: sideEffect.type }, "unknown side effect type");
    }
  }

  fields.push("updated_at = ?");
  values.push(now);
  values.push(taskId);
  db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}
