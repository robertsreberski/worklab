import { describe, expect, it } from "vitest";
import {
  buildProjectTaskProgress,
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
      "dependencies",
      "owner",
    ]);
    expect(items[0]).toMatchObject({ label: "Failed: spawn", tone: "error" });
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
});
