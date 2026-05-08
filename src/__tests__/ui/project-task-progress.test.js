import { describe, expect, it } from "vitest";
import {
  buildProjectTaskProgress,
  isProjectChildTask,
  projectTaskAttentionItems,
  projectTaskGroupKey,
} from "../../ui/src/lib/projectTaskProgress.js";

describe("project task progress helpers", () => {
  it("collapses task stages into todo, in-progress, and done", () => {
    expect(projectTaskGroupKey({ stage: "plan" })).toBe("todo");
    expect(projectTaskGroupKey({ stage: "execute" })).toBe("in_progress");
    expect(projectTaskGroupKey({ stage: "review" })).toBe("in_progress");
    expect(projectTaskGroupKey({ stage: "awaiting_children" })).toBe("in_progress");
    expect(projectTaskGroupKey({ stage: "awaiting_user" })).toBe("in_progress");
    expect(projectTaskGroupKey({ stage: "blocked" })).toBe("in_progress");
    expect(projectTaskGroupKey({ stage: "legacy" })).toBe("in_progress");
    expect(projectTaskGroupKey({ stage: "done" })).toBe("done");
    expect(projectTaskGroupKey({ stage: "done", running_run_id: "run-1" })).toBe("in_progress");
  });

  it("derives attention badges from failures and blocked states", () => {
    const items = projectTaskAttentionItems({
      stage: "awaiting_user",
      owner_agent: null,
      pending_actions: ["approve"],
      blocking_issues: ["missing credentials"],
      unresolved_dependency_count: 2,
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

  it("does not mark completed tasks with stale failed runs as attention", () => {
    const task = {
      stage: "done",
      owner_agent: "owner",
      last_run: { status: "error", process_status: "failed", failure_kind: "spawn" },
    };

    expect(projectTaskAttentionItems(task)).toEqual([]);
    expect(projectTaskGroupKey(task)).toBe("done");
  });

  it("does not mark dependency-only queued tasks as attention", () => {
    const items = projectTaskAttentionItems({
      stage: "execute",
      owner_agent: "owner",
      unresolved_dependency_count: 1,
    });

    expect(items).toEqual([]);
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

    expect(projectTaskAttentionItems(task)).toEqual([]);
    expect(projectTaskGroupKey(task)).toBe("in_progress");
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

    expect(projectTaskAttentionItems(task)).toContainEqual({
      key: "failure_kind",
      label: "Failure: review_unverified",
      tone: "warn",
    });
    expect(projectTaskGroupKey(task)).toBe("in_progress");
  });

  it("surfaces active recovery as a secondary attention badge", () => {
    const items = projectTaskAttentionItems({
      stage: "review",
      running_run_id: "run-retry",
      last_run: {
        recovery: {
          active_run_id: "run-retry",
          stage: "review",
          subkind: "terminated",
        },
      },
    });

    expect(items[0]).toMatchObject({ key: "auto_retry", label: "Retrying review", tone: "warn" });
  });

  it("builds counts, percent done, grouped tasks, and attention ordering", () => {
    const progress = buildProjectTaskProgress([
      { id: "done", title: "Done", stage: "done", updated_at: 1, owner_agent: "owner" },
      { id: "todo", title: "Todo", stage: "plan", updated_at: 4, owner_agent: "owner" },
      { id: "normal", title: "Normal", stage: "execute", updated_at: 5, owner_agent: "owner" },
      {
        id: "failed",
        title: "Failed",
        stage: "execute",
        updated_at: 3,
        owner_agent: "owner",
        last_run: { process_status: "failed" },
      },
    ]);

    expect(progress.total).toBe(4);
    expect(progress.counts).toEqual({ todo: 1, in_progress: 2, done: 1 });
    expect(progress.percent_done).toBe(25);
    expect(progress.groups.map((group) => group.key)).toEqual(["todo", "in_progress", "done"]);
    expect(progress.groups[1].tasks.map((task) => task.id)).toEqual(["failed", "normal"]);
    expect(progress.attention_tasks.map((task) => task.id)).toEqual(["failed"]);
  });

  it("nests child tasks under their parent without inflating top-level counts", () => {
    const progress = buildProjectTaskProgress([
      { id: "parent", title: "Parent", stage: "execute", updated_at: 4, owner_agent: "owner" },
      { id: "child-done", parent_task_id: "parent", title: "Done child", stage: "done", updated_at: 3, owner_agent: "owner" },
      {
        id: "child-blocked",
        parent_task_id: "parent",
        title: "Blocked child",
        stage: "blocked",
        updated_at: 5,
        owner_agent: "owner",
        blocking_issues: ["missing context"],
      },
      { id: "top-done", title: "Top done", stage: "done", updated_at: 2, owner_agent: "owner" },
    ]);

    expect(isProjectChildTask({ parent_task_id: "parent" })).toBe(true);
    expect(progress.total).toBe(2);
    expect(progress.task_total).toBe(4);
    expect(progress.child_total).toBe(2);
    expect(progress.nested_child_total).toBe(2);
    expect(progress.counts).toEqual({ todo: 0, in_progress: 1, done: 1 });
    expect(progress.percent_done).toBe(50);

    const parent = progress.groups[1].tasks.find((task) => task.id === "parent");
    expect(parent.child_tasks.map((task) => task.id)).toEqual(["child-blocked", "child-done"]);
    expect(parent.child_counts).toEqual({ todo: 0, in_progress: 1, done: 1 });
    expect(parent.attention.map((item) => item.key)).toEqual(["child_attention"]);
    expect(progress.attention_tasks.map((task) => task.id)).toEqual(["parent"]);
  });
});
