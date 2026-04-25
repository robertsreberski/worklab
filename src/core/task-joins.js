import { nextStage } from "./state-machine.js";
import { taskStage } from "./task-side-effects.js";

export function resumeWaitingParents({ db, childTaskId, applySideEffects, onParentReady }) {
  const parents = db.prepare(`
    SELECT p.*
    FROM task_edges e
    JOIN tasks p ON p.id = e.parent_task_id
    WHERE e.child_task_id = ? AND e.edge_type = 'subtask'
  `).all(childTaskId);
  const resumed = [];

  for (const parent of parents) {
    if (taskStage(parent) !== "awaiting_children") continue;
    const requiredChildren = db.prepare(`
      SELECT c.id, c.title, c.stage
      FROM task_edges e
      JOIN tasks c ON c.id = e.child_task_id
      WHERE e.parent_task_id = ? AND e.edge_type = 'subtask' AND e.required = 1
    `).all(parent.id);

    if (requiredChildren.length === 0) continue;

    const blocked = requiredChildren.find((child) => taskStage(child) === "blocked");
    if (blocked) {
      const sm = nextStage("awaiting_children", {
        type: "child_blocked",
        message: `Required child blocked: ${blocked.title}`,
      });
      applySideEffects(parent.id, sm.sideEffects, "awaiting_children", sm.stage);
      resumed.push({ parentId: parent.id, stage: sm.stage, reason: "child_blocked" });
      continue;
    }

    if (requiredChildren.every((child) => taskStage(child) === "done")) {
      const sm = nextStage("awaiting_children", { type: "children_completed" });
      applySideEffects(parent.id, sm.sideEffects, "awaiting_children", sm.stage);
      resumed.push({ parentId: parent.id, stage: sm.stage, reason: "children_completed" });
      onParentReady?.(parent.id, parent);
    }
  }

  return resumed;
}
