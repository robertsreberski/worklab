export const STAGES = [
  "draft",
  "plan",
  "execute",
  "review",
  "verify",
  "qa",
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
  "abandoned",
  "provider_unavailable",
];

// Compatibility surface for older callers/tests while the UI and API migrate
// to stage/process_status. These values are not canonical workflow state.
export const STATUSES = ["todo", "in_progress", "in_review", "done", "blocked"];

export function legacyStatusToStage(status) {
  switch (status) {
    case "todo":
    case "in_progress":
      return "execute";
    case "in_review":
      return "review";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    default:
      return STAGES.includes(status) ? status : "execute";
  }
}

export function stageToLegacyStatus(stage, { running = false } = {}) {
  if (running) return "in_progress";
  switch (stage) {
    case "review":
    case "verify":
    case "qa":
      return "in_review";
    case "done":
      return "done";
    case "blocked":
    case "awaiting_user":
    case "awaiting_children":
      return "blocked";
    case "draft":
    case "plan":
    case "execute":
    default:
      return "todo";
  }
}

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
  return { stage, status: stageToLegacyStatus(stage), sideEffects };
}

function change(stage, sideEffects = []) {
  return { stage, status: stageToLegacyStatus(stage), sideEffects };
}

function canStartRun(stage) {
  return ["draft", "plan", "execute", "review", "verify", "qa"].includes(stage);
}

export function nextStage(currentStage, event) {
  const current = legacyStatusToStage(currentStage);

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
      if (decision === "delegate") {
        return change("awaiting_children", [
          { type: "clear_error_text" },
          { type: "set_stage_reason", reason: "waiting for delegated subtasks" },
          { type: "create_subtasks", subtasks: result.subtasks || [] },
        ]);
      }
      if (decision === "pause") {
        return change("awaiting_user", [
          { type: "set_stage_reason", reason: result.summary || "awaiting user action" },
          { type: "set_pending_actions", pendingActions: result.pending_actions || [] },
        ]);
      }
      if (decision === "block") {
        return change("blocked", [
          { type: "set_error_text", message: result.summary || "agent blocked" },
          { type: "set_stage_reason", reason: result.summary || "agent blocked" },
          { type: "set_blocking_issues", blockingIssues: result.blocking_issues || [] },
        ]);
      }
      if (event.stage === "review" || current === "review") {
        if (decision === "approve" || decision === "advance") {
          return change("done", [
            { type: "clear_error_text" },
            { type: "clear_stage_reason" },
            { type: "set_completed_at" },
            { type: "post_review_verdict", verdict: "APPROVE", notes: result.summary || "" },
          ]);
        }
        if (decision === "reject") {
          return change("execute", [
            { type: "clear_completed_at" },
            { type: "clear_error_text" },
            { type: "set_stage_reason", reason: "review requested changes" },
            { type: "post_review_comment", notes: result.details || result.summary || "" },
          ]);
        }
      }
      return change(event.nextStage || "review", [
        { type: "clear_error_text" },
        { type: "clear_stage_reason" },
        ...(event.reviewerAgent ? [{ type: "spawn_reviewer", agentName: event.reviewerAgent }] : []),
      ]);
    }

    case "run_failed": {
      const message = event.message || "run failed";
      const retryStage = event.retryStage || current;
      return change(retryStage, [
        { type: "post_error_comment", message },
        { type: "set_error_text", message },
        { type: "set_stage_reason", reason: event.failureKind || "run_failed" },
      ]);
    }

    case "run_cancelled": {
      const message = event.message || "Run cancelled.";
      return change(event.retryStage || current, [
        { type: "post_error_comment", message },
        { type: "set_error_text", message },
        { type: "set_stage_reason", reason: "cancelled" },
      ]);
    }

    case "run_abandoned": {
      const message = event.message || "Previous run did not finish";
      return change(event.retryStage || current, [
        { type: "post_error_comment", message },
        { type: "set_error_text", message },
        { type: "set_stage_reason", reason: "abandoned" },
      ]);
    }

    case "children_completed":
      if (current !== "awaiting_children") {
        return unchanged(current, [{ type: "error", message: `cannot resume children from ${current}` }]);
      }
      return change("execute", [
        { type: "clear_error_text" },
        { type: "set_stage_reason", reason: "required children completed" },
      ]);

    case "child_blocked":
      if (current !== "awaiting_children") return unchanged(current);
      return change("blocked", [
        { type: "set_error_text", message: event.message || "required child blocked" },
        { type: "set_stage_reason", reason: "required_child_blocked" },
      ]);

    case "human_move": {
      const target = legacyStatusToStage(event.target);
      if (!STAGES.includes(target)) {
        return unchanged(current, [{ type: "error", message: `invalid target ${event.target}` }]);
      }
      const sideEffects = [{ type: "set_stage_reason", reason: event.reason || null }];
      if (target === "done") sideEffects.push({ type: "set_completed_at" });
      if (current === "done" && target !== "done") sideEffects.push({ type: "clear_completed_at" });
      if (target !== "blocked") sideEffects.push({ type: "clear_error_text" });
      return change(target, sideEffects);
    }

    default:
      return unchanged(current, [{ type: "error", message: `unknown event ${event.type}` }]);
  }
}

export function nextStatus(current, event) {
  const stage = legacyStatusToStage(current);
  if (event.type === "review_approved") {
    return nextStage(stage, {
      type: "run_succeeded",
      stage: "review",
      result: { decision: "approve", summary: event.notes || "" },
    });
  }
  if (event.type === "review_rejected") {
    return nextStage(stage, {
      type: "run_succeeded",
      stage: "review",
      result: { decision: "reject", summary: event.notes || "" },
    });
  }
  if (event.type === "run_completed") {
    return nextStage(stage, {
      type: "run_succeeded",
      stage,
      reviewerAgent: event.reviewerAgent,
      result: { decision: "advance" },
    });
  }
  if (event.type === "run_failed") {
    return nextStage(stage, event);
  }
  if (event.type === "run_requested") {
    const result = nextStage(stage, {
      type: "run_requested",
      stage,
      mode: stage === "review" ? "review" : "execute",
      agentName: event.executorAgent,
    });
    return {
      ...result,
      sideEffects: result.sideEffects.map((sideEffect) => (
        sideEffect.type === "spawn_worker"
          ? { type: "spawn_executor", agentName: sideEffect.agentName }
          : sideEffect
      )),
    };
  }
  return nextStage(stage, event);
}
