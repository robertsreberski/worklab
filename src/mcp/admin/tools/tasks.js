// Task admin tools.

import {
  arrayOfString,
  boolean,
  compactTask,
  compactTaskResponse,
  object,
  patchSchema,
  string,
  taskIdSchema,
  tool,
} from "../../shared/schema-helpers.js";
import { apiRequest, buildSpecHandlers } from "../../shared/tool-registry.js";

const taskCreateInput = object({
  title: string("Task title"),
  instructions: string("Task instructions"),
  owner_agent: string("Owner agent name"),
  planner_agent: string("Planner agent name"),
  reviewer_agent: string("Reviewer agent name"),
  stage: string("Initial workflow stage"),
  run_policy: string("Run policy: manual or auto_plan_execute"),
  project_id: string("Optional project id or slug"),
  tags: arrayOfString("Tags"),
  blocked_by_ids: arrayOfString("Dependency task ids or public task keys"),
  client_request_id: string("Idempotency key"),
}, ["title"]);

export const definitions = [
  tool("worklab_task_list", "List tasks, optionally filtered by stage, agent, or project.", object({
    stage: string("Workflow stage filter"),
    agent: string("Owner or reviewer agent filter"),
    project: string("Project id, slug, or 'none'"),
  })),
  tool("worklab_task_get", "Get a task with comments, runs, and graph context.", object({ id: taskIdSchema }, ["id"])),
  tool("worklab_task_create", "Create a task and return a compact task summary.", taskCreateInput),
  tool("worklab_task_create_many", "Create multiple tasks sequentially and return compact summaries.", object({
    tasks: { type: "array", items: taskCreateInput, description: "Tasks to create" },
  }, ["tasks"])),
  tool("worklab_task_update", "Patch a task. Use the same fields accepted by PATCH /api/tasks/:id.", object({ id: taskIdSchema, patch: patchSchema }, ["id", "patch"])),
  tool("worklab_task_bulk_update", "Patch multiple tasks by id or public task key.", object({
    ids: { type: "array", items: taskIdSchema, description: "Task ids or public task keys" },
    patch: patchSchema,
  }, ["ids", "patch"])),
  tool("worklab_task_delete", "Delete a task.", object({ id: taskIdSchema }, ["id"])),
  tool("worklab_task_comment", "Add a human comment to a task.", object({ id: taskIdSchema, body: string("Comment body") }, ["id", "body"])),
  tool("worklab_task_comment_delete", "Delete a human comment from a task.", object({
    id: taskIdSchema,
    comment_id: string("Comment id"),
  }, ["id", "comment_id"])),
  tool("worklab_task_create_subtask", "Create a subtask under a parent task.", object({
    id: taskIdSchema,
    title: string("Subtask title"),
    instructions: string("Subtask instructions"),
    owner_agent: string("Owner agent name"),
    planner_agent: string("Planner agent name"),
    reviewer_agent: string("Reviewer agent name"),
    required: boolean("Whether parent waits for this subtask"),
  }, ["id", "title"])),
  tool("worklab_task_run", "Start a task run.", object({ id: taskIdSchema }, ["id"])),
  tool("worklab_task_cancel", "Cancel or reconcile the active run for a task.", object({ id: taskIdSchema }, ["id"])),
];

// Wrapper specs for the simple pass-through tools. Tools that need extra
// reshaping (compact summaries, bulk fan-out) override the default below.
const specs = [
  ["worklab_task_list", "GET", "/api/tasks", ["stage", "agent", "project"]],
  ["worklab_task_get", "GET", "/api/tasks/:id"],
  ["worklab_task_update", "PATCH", "/api/tasks/:id", [], "patch"],
  ["worklab_task_delete", "DELETE", "/api/tasks/:id"],
  ["worklab_task_comment", "POST", "/api/tasks/:id/comments", [], "comment"],
  ["worklab_task_comment_delete", "DELETE", "/api/tasks/:id/comments/:comment_id"],
  ["worklab_task_create_subtask", "POST", "/api/tasks/:id/subtasks", [], "subtask"],
  ["worklab_task_run", "POST", "/api/tasks/:id/run"],
  ["worklab_task_cancel", "POST", "/api/tasks/:id/cancel"],
];

export function buildHandlers(client) {
  const handlers = buildSpecHandlers(client, specs);

  handlers.worklab_task_create = async (input = {}) => compactTaskResponse(
    await apiRequest(client, "POST", "/api/tasks", { body: input }),
  );

  handlers.worklab_task_create_many = async (input = {}) => {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    const results = [];
    for (const task of tasks) {
      try {
        const result = await apiRequest(client, "POST", "/api/tasks", { body: task });
        results.push({ ok: true, task: compactTask(result.task) });
      } catch (error) {
        results.push({ ok: false, error: { message: error.message || String(error) } });
      }
    }
    const succeeded = results.filter((result) => result.ok).length;
    return {
      summary: { requested: tasks.length, succeeded, failed: tasks.length - succeeded },
      results,
    };
  };

  handlers.worklab_task_bulk_update = async (input = {}) => {
    const result = await apiRequest(client, "POST", "/api/tasks/bulk", {
      body: { operation: "patch", ids: input.ids || [], patch: input.patch || {} },
    });
    return {
      summary: result.summary,
      results: (result.results || []).map((entry) => ({
        id: entry.id,
        task_id: entry.task_id || null,
        ok: !!entry.ok,
        ...(entry.task ? { task: compactTask(entry.task) } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      })),
    };
  };

  return handlers;
}
