import { nextStage } from "./state-machine.js";
import { taskStage } from "./task-side-effects.js";

const REQUIRED_CHILD_BLOCKED_REASON = "required_child_blocked";

function requiredChildrenForParent(db, parentTaskId) {
  return db.prepare(`
    SELECT c.id, c.title, c.stage
    FROM task_edges e
    JOIN tasks c ON c.id = e.child_task_id
    WHERE e.parent_task_id = ? AND e.edge_type = 'subtask' AND e.required = 1
  `).all(parentTaskId);
}

function reconcileRequiredChildren({ db, parent, applySideEffects, onParentReady }) {
  const parentStage = taskStage(parent);
  const isWaiting = parentStage === "awaiting_children";
  const isRequiredChildBlock = (
    parentStage === "blocked"
    && parent.stage_reason === REQUIRED_CHILD_BLOCKED_REASON
  );
  if (!isWaiting && !isRequiredChildBlock) return null;

  const requiredChildren = requiredChildrenForParent(db, parent.id);
  if (requiredChildren.length === 0) return null;

  const blocked = requiredChildren.find((child) => taskStage(child) === "blocked");
  if (blocked) {
    if (!isWaiting) return null;
    const sm = nextStage("awaiting_children", {
      type: "child_blocked",
      message: `Required child blocked: ${blocked.title}`,
    });
    applySideEffects(parent.id, sm.sideEffects, parentStage, sm.stage);
    return { parentId: parent.id, stage: sm.stage, reason: "child_blocked" };
  }

  if (requiredChildren.every((child) => taskStage(child) === "done")) {
    const sm = nextStage("awaiting_children", { type: "children_completed" });
    applySideEffects(parent.id, sm.sideEffects, parentStage, sm.stage);
    onParentReady?.(parent.id, parent);
    return { parentId: parent.id, stage: sm.stage, reason: "children_completed" };
  }

  if (isRequiredChildBlock) {
    const sideEffects = [
      { type: "clear_error_text" },
      { type: "clear_blocking_issues" },
      { type: "set_stage_reason", reason: "waiting for required children" },
    ];
    applySideEffects(parent.id, sideEffects, parentStage, "awaiting_children");
    return { parentId: parent.id, stage: "awaiting_children", reason: "children_unblocked" };
  }

  return null;
}

export function resumeWaitingParents({ db, childTaskId, applySideEffects, onParentReady }) {
  const parents = db.prepare(`
    SELECT p.*
    FROM task_edges e
    JOIN tasks p ON p.id = e.parent_task_id
    WHERE e.child_task_id = ? AND e.edge_type = 'subtask'
  `).all(childTaskId);
  const resumed = [];

  for (const parent of parents) {
    const result = reconcileRequiredChildren({ db, parent, applySideEffects, onParentReady });
    if (result) resumed.push(result);
  }

  return resumed;
}

export function reconcileRequiredChildBlockedParents({ db, applySideEffects, onParentReady }) {
  const parents = db.prepare(`
    SELECT *
    FROM tasks
    WHERE stage = 'blocked' AND stage_reason = ?
  `).all(REQUIRED_CHILD_BLOCKED_REASON);
  const reconciled = [];

  for (const parent of parents) {
    const result = reconcileRequiredChildren({ db, parent, applySideEffects, onParentReady });
    if (result) reconciled.push(result);
  }

  return reconciled;
}
