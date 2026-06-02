// Task-graph tools available to agents during a run. Lets a parent task
// inspect its delegated subtasks and read their structured worklab_result.

import { z } from "zod";
import { safeParse, withDb } from "./shared.js";
import { getTaskById } from "../../../core/db/queries/tasks.js";
import { isSubtaskEdge } from "../../../core/db/queries/task-edges.js";

const listChildrenSchema = z.object({ task_id: z.string().optional() });
const getChildResultSchema = z.object({
  child_task_id: z.string().min(1, "child_task_id is required"),
});

export const definitions = [
  {
    name: "list_children",
    description:
      "List subtasks delegated under a parent task. Defaults to the current task's children when called from a task run. Returns title, stage, owner, and required flag for each child edge.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Parent task id (optional; defaults to the current task)" },
      },
    },
  },
  {
    name: "get_child_result",
    description:
      "Read a child task's most recent run summary, decision, failure kind, and structured worklab_result. Errors with `forbidden` when the named task isn't a subtask of the calling task.",
    inputSchema: {
      type: "object",
      properties: {
        child_task_id: { type: "string", description: "Child task id (must be a subtask of the current task when invoked during a run)" },
      },
      required: ["child_task_id"],
    },
  },
];

export function buildHandlers(context) {
  const { dataDir, taskId } = context;
  return {
    async list_children(input) {
      const { task_id } = listChildrenSchema.parse(input);
      const parentId = task_id || taskId;
      if (!parentId) throw new Error("task_id is required outside of a task run context");
      return await withDb(dataDir, (db) => {
        const rows = db.prepare(`
          SELECT
            t.id, t.task_key, t.title, t.stage, t.stage_reason,
            t.owner_agent, t.reviewer_agent, t.last_failure_kind,
            t.completed_at, t.updated_at,
            e.required AS required, e.edge_type AS edge_type
          FROM task_edges e
          JOIN tasks t ON t.id = e.child_task_id
          WHERE e.parent_task_id = ? AND e.edge_type = 'subtask'
          ORDER BY t.subtask_order ASC, t.created_at ASC
        `).all(parentId);
        return {
          parent_task_id: parentId,
          children: rows.map((row) => ({
            ...row,
            required: row.required !== 0,
          })),
        };
      });
    },

    async get_child_result(input) {
      const { child_task_id } = getChildResultSchema.parse(input);
      return await withDb(dataDir, (db) => {
        const child = getTaskById(db, child_task_id);
        if (!child) throw new Error(`not_found: ${child_task_id}`);
        if (taskId && !isSubtaskEdge(db, taskId, child_task_id)) {
          throw new Error(`forbidden: ${child_task_id} is not a subtask of ${taskId}`);
        }
        const lastRun = db.prepare(`
          SELECT id, mode, stage, status, process_status, decision, failure_kind, summary, details, result_json,
                 cost_usd, started_at, ended_at
          FROM task_runs
          WHERE task_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1
        `).get(child_task_id);
        return {
          child_task_id,
          title: child.title,
          stage: child.stage,
          stage_reason: child.stage_reason,
          completed_at: child.completed_at,
          last_failure_kind: child.last_failure_kind,
          last_run: lastRun ? {
            ...lastRun,
            result: lastRun.result_json ? safeParse(lastRun.result_json) : null,
          } : null,
        };
      });
    },
  };
}
