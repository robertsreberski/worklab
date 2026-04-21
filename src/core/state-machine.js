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
    default:
      return unchanged([{ type: "error", message: `unknown event ${event.type}` }]);
  }
}
