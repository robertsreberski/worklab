export const STATUSES = ["todo", "in_progress", "in_review", "done"];

export function nextStatus(current, event) {
  const unchanged = (sideEffects = []) => ({ status: current, sideEffects });
  const change = (status, sideEffects = []) => ({ status, sideEffects });

  switch (event.type) {
    case "run_requested":
      if (current !== "todo" && current !== "in_progress") {
        return unchanged([{ type: "error", message: `cannot run from ${current}` }]);
      }
      if (!event.executorAgent) {
        return unchanged([{ type: "error", message: "no executor assigned" }]);
      }
      return change("in_progress", [{ type: "spawn_executor", agentName: event.executorAgent }]);
    case "run_completed":
      if (current !== "in_progress") {
        return unchanged([{ type: "error", message: `cannot complete from ${current}` }]);
      }
      return change(
        "in_review",
        event.reviewerAgent
          ? [{ type: "spawn_reviewer", agentName: event.reviewerAgent }]
          : [],
      );
    case "run_failed":
      if (current !== "in_progress") {
        return unchanged([{ type: "error", message: `cannot fail from ${current}` }]);
      }
      return unchanged([
        { type: "post_error_comment", message: event.message || "run failed" },
        { type: "mark_badge_red" },
      ]);
    case "review_approved":
      if (current !== "in_review") {
        return unchanged([{ type: "error", message: `cannot approve from ${current}` }]);
      }
      return change("done", [{ type: "set_completed_at" }]);
    case "review_rejected":
      if (current !== "in_review") {
        return unchanged([{ type: "error", message: `cannot reject from ${current}` }]);
      }
      return change("in_progress", [
        { type: "post_review_comment", notes: event.notes || "" },
        { type: "clear_error_text" },
      ]);
    default:
      return unchanged([{ type: "error", message: `unknown event ${event.type}` }]);
  }
}
