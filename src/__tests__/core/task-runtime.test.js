import { describe, expect, it } from "vitest";
import {
  buildRuntimeTaskSummary,
  compareRuntimeTasks,
  runtimeTaskAttentionItems,
  runtimeTaskGroupKey,
  runtimeTaskVisibility,
} from "../../core/task-runtime.js";

describe("runtime task grouping", () => {
  it("classifies tasks by current runtime relevance without changing workflow stage", () => {
    expect(runtimeTaskGroupKey({ stage: "done", running_run_id: "run-1" })).toBe("running");
    expect(runtimeTaskGroupKey({ stage: "done", automation_summary: { enabled_count: 1 } })).toBe("automated");
    expect(runtimeTaskGroupKey({ stage: "done" })).toBe("completed");
    expect(runtimeTaskGroupKey({ stage: "awaiting_children", owner_agent: "owner" })).toBe("waiting");
    expect(runtimeTaskGroupKey({ stage: "execute", owner_agent: "owner", blocked_by: [{ stage: "review" }] })).toBe("waiting");
    expect(runtimeTaskGroupKey({ stage: "execute", owner_agent: "owner" })).toBe("ready");
    expect(runtimeTaskGroupKey({ stage: "plan" })).toBe("attention");
  });

  it("surfaces attention reasons for the runtime cockpit", () => {
    const items = runtimeTaskAttentionItems({
      stage: "awaiting_user",
      owner_agent: null,
      pending_actions: ["approve"],
      blocking_issues: ["missing credentials"],
      blocked_by: [{ stage: "execute" }],
      last_run: { status: "error", process_status: "failed", failure_kind: "spawn" },
    });

    expect(items.map((item) => item.key)).toEqual([
      "failed_run",
      "awaiting_user",
      "blocking_issues",
      "pending_actions",
      "owner",
    ]);
    expect(items[0]).toMatchObject({ label: "Failed: spawn", tone: "error" });
  });

  it("does not treat dependency-only waiting as attention", () => {
    expect(runtimeTaskAttentionItems({
      stage: "execute",
      owner_agent: "owner",
      blocked_by: [{ stage: "review" }],
    })).toEqual([]);
  });

  it("ignores stale failure kind after a successful retry delegated work", () => {
    const task = {
      stage: "awaiting_children",
      owner_agent: "owner",
      failure_count: 0,
      last_failure_kind: "provider_unavailable",
      last_run: {
        status: "complete",
        process_status: "succeeded",
        decision: "delegate",
        failure_kind: null,
      },
    };

    expect(runtimeTaskAttentionItems(task)).toEqual([]);
    expect(runtimeTaskGroupKey(task)).toBe("waiting");
  });

  it("keeps reviewer verification failures visible after a successful review run", () => {
    const task = {
      stage: "review",
      owner_agent: "owner",
      failure_count: 0,
      last_failure_kind: "review_unverified",
      last_run: {
        status: "complete",
        process_status: "succeeded",
        decision: "approve",
        failure_kind: null,
      },
    };

    expect(runtimeTaskAttentionItems(task)).toContainEqual({
      key: "failure_kind",
      label: "Failure: review_unverified",
      tone: "warn",
    });
    expect(runtimeTaskGroupKey(task)).toBe("attention");
  });

  it("limits visible completed tasks and reports hidden completed count", () => {
    const tasks = [
      { id: "running", title: "Running", stage: "execute", running_run_id: "run-1", updated_at: 1 },
      { id: "ready", title: "Ready", stage: "execute", owner_agent: "owner", updated_at: 2 },
      { id: "done-old", title: "Done old", stage: "done", completed_at: 3, updated_at: 3 },
      { id: "done-new", title: "Done new", stage: "done", completed_at: 4, updated_at: 4 },
    ];

    const result = runtimeTaskVisibility(tasks, { doneLimit: 1 });

    expect(result.tasks.map((task) => task.id)).toEqual(["running", "ready", "done-new"]);
    expect(result.summary.groups).toMatchObject({ running: 1, ready: 1, completed: 2 });
    expect(result.summary.hidden_done_count).toBe(1);
    expect(runtimeTaskVisibility(tasks).tasks.map((task) => task.id)).toEqual(["running", "ready"]);
    expect(runtimeTaskVisibility(tasks).summary.hidden_done_count).toBe(2);
    expect(buildRuntimeTaskSummary(tasks).hidden_done_count).toBe(0);
  });

  it("sorts completed and automated tasks by updated_at instead of completed_at", () => {
    const completedTasks = [
      { id: "recently-completed", title: "Recently completed", stage: "done", completed_at: 9000, updated_at: 1000 },
      { id: "recently-updated", title: "Recently updated", stage: "done", completed_at: 1000, updated_at: 9000 },
    ];
    const automatedTasks = [
      {
        id: "automated-completed-later",
        title: "Automated completed later",
        stage: "done",
        completed_at: 9000,
        updated_at: 1000,
        automation_summary: { enabled_count: 1 },
      },
      {
        id: "automated-updated-later",
        title: "Automated updated later",
        stage: "done",
        completed_at: 1000,
        updated_at: 9000,
        automation_summary: { enabled_count: 1 },
      },
    ];

    expect([...completedTasks].sort(compareRuntimeTasks).map((task) => task.id)).toEqual([
      "recently-updated",
      "recently-completed",
    ]);
    expect([...automatedTasks].sort(compareRuntimeTasks).map((task) => task.id)).toEqual([
      "automated-updated-later",
      "automated-completed-later",
    ]);
    expect(runtimeTaskVisibility(completedTasks, { doneLimit: 1 }).tasks.map((task) => task.id)).toEqual([
      "recently-updated",
    ]);
  });
});
