// Run-local todo tools. These are progress scratchpads owned by the current
// agent run, distinct from durable Worklab tasks/subtasks.

import { z } from "zod";
import { withDb } from "./shared.js";
import {
  RUN_TODO_MAX_ACTIVE_FORM_LENGTH,
  RUN_TODO_MAX_CONTENT_LENGTH,
  RUN_TODO_MAX_ITEMS,
  RUN_TODO_STATUSES,
  createRunTodoState,
  runTodoStateSummary,
  serializeRunTodoState,
} from "../../../core/index.js";
import { getRunTodoStateRow, setRunTodoState } from "../../../core/db/queries/runs.js";

const todoItemSchema = z.object({
  content: z.string().min(1, "content is required").max(RUN_TODO_MAX_CONTENT_LENGTH),
  status: z.enum(RUN_TODO_STATUSES),
  active_form: z.string().min(1).max(RUN_TODO_MAX_ACTIVE_FORM_LENGTH).optional(),
});

export const todoReadSchema = z.object({});
export const todoWriteSchema = z.object({
  todos: z.array(todoItemSchema).max(RUN_TODO_MAX_ITEMS),
});

export const definitions = [
  {
    name: "todo_read",
    description:
      "Read the current run's lightweight checklist. Use it to regain your execution state after long tool sequences.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "todo_write",
    description:
      "Replace the current run's lightweight checklist. Keep it short, with at most one in_progress item; use tasks/subtasks for durable delegated work.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: RUN_TODO_MAX_ITEMS,
          items: {
            type: "object",
            properties: {
              content: { type: "string", maxLength: RUN_TODO_MAX_CONTENT_LENGTH },
              status: { type: "string", enum: RUN_TODO_STATUSES },
              active_form: { type: "string", maxLength: RUN_TODO_MAX_ACTIVE_FORM_LENGTH },
            },
            required: ["content", "status"],
          },
          description: "Complete replacement list. Empty array clears the checklist.",
        },
      },
      required: ["todos"],
    },
  },
];

function assertCurrentRun(row, { runId, taskId, agent }) {
  if (!row) throw new Error(`run not found: ${runId}`);
  if (taskId && row.task_id && row.task_id !== taskId) {
    throw new Error(`forbidden: ${runId} does not belong to task ${taskId}`);
  }
  if (agent && row.agent_name && row.agent_name !== agent) {
    throw new Error(`forbidden: ${runId} does not belong to agent ${agent}`);
  }
}

export function buildHandlers(context) {
  const { dataDir, runId, taskId, agent } = context;
  return {
    async todo_read(input) {
      todoReadSchema.parse(input);
      if (!runId) throw new Error("run_id is required for todo_read");
      return await withDb(dataDir, (db) => {
        const row = getRunTodoStateRow(db, runId);
        assertCurrentRun(row, { runId, taskId, agent });
        return { todo_state: runTodoStateSummary(row.todo_state_json) };
      });
    },

    async todo_write(input) {
      const { todos } = todoWriteSchema.parse(input);
      if (!runId) throw new Error("run_id is required for todo_write");
      return await withDb(dataDir, (db) => {
        const row = getRunTodoStateRow(db, runId);
        assertCurrentRun(row, { runId, taskId, agent });
        const todoState = createRunTodoState(todos, { previousState: row.todo_state_json });
        setRunTodoState(db, runId, serializeRunTodoState(todoState));
        return {
          ok: true,
          todo_state: runTodoStateSummary(todoState),
        };
      });
    },
  };
}
