import { beforeEach, describe, expect, it } from "vitest";
import {
  RUNTIME_GROUPS,
  clearCommanderTaskListCache,
  commanderTaskSortBucket,
  commanderTaskListCacheKey,
  commanderTaskListRequestQuery,
  compareCommanderGroups,
  compareCommanderTasks,
  formatCommanderCost,
  groupKeyFor,
  readCommanderTaskListCache,
  taskMatchesCommanderQuery,
  writeCommanderTaskListCache,
} from "../../ui/src/routes/Commander.jsx";

describe("commander task grouping", () => {
  beforeEach(() => {
    clearCommanderTaskListCache();
  });

  it("formats task-list cost summary values to two decimals", () => {
    expect(formatCommanderCost(35.8315)).toBe("$35.83");
    expect(formatCommanderCost(0)).toBe("$0.00");
    expect(formatCommanderCost(null)).toBeNull();
  });

  it("uses the saved task stage even when the latest run errored", () => {
    expect(groupKeyFor({
      stage: "done",
      last_run: { status: "error", process_status: "failed" },
    })).toBe("done");
  });

  it("groups done tasks with enabled schedules as automated", () => {
    expect(groupKeyFor({
      stage: "done",
      automation_summary: { count: 1, enabled_count: 1, paused_count: 0 },
    })).toBe("automated");
  });

  it("keeps done tasks with paused schedules in done", () => {
    expect(groupKeyFor({
      stage: "done",
      automation_summary: { count: 1, enabled_count: 0, paused_count: 1 },
    })).toBe("done");
  });

  it("uses runnable stages for tasks with enabled schedules", () => {
    expect(groupKeyFor({
      stage: "execute",
      automation_summary: { count: 1, enabled_count: 1, paused_count: 0 },
    })).toBe("execute");
  });

  it("uses the saved task stage even when dependencies are unresolved", () => {
    expect(groupKeyFor({
      stage: "execute",
      blocked_by: [{ stage: "review" }],
    })).toBe("execute");
  });

  it("falls back to execute for unknown stages", () => {
    expect(groupKeyFor({ stage: "legacy" })).toBe("execute");
  });

  it("sorts running and in-progress tasks before plan and done tasks", () => {
    expect(commanderTaskSortBucket({ stage: "done", running_run_id: "run-1" })).toBe(0);
    expect(commanderTaskSortBucket({ stage: "review" })).toBe(1);
    expect(commanderTaskSortBucket({ stage: "plan" })).toBe(2);
    expect(commanderTaskSortBucket({ stage: "done" })).toBe(3);

    const tasks = [
      { id: "done", title: "Done", stage: "done", updated_at: 4 },
      { id: "plan", title: "Plan", stage: "plan", updated_at: 10 },
      { id: "execute", title: "Execute", stage: "execute", updated_at: 1 },
      { id: "running", title: "Running", stage: "done", running_run_id: "run-1", updated_at: 2 },
    ].sort(compareCommanderTasks);

    expect(tasks.map((task) => task.id)).toEqual(["running", "execute", "plan", "done"]);
  });

  it("moves groups with running or in-progress work ahead of plan and done groups", () => {
    const groups = [
      { status: "plan", tasks: [{ stage: "plan", updated_at: 10 }] },
      { status: "done", tasks: [{ stage: "done", updated_at: 20 }] },
      { status: "execute", tasks: [{ stage: "execute", updated_at: 1 }] },
      { status: "review", tasks: [{ stage: "done", running_run_id: "run-1", updated_at: 2 }] },
    ].sort(compareCommanderGroups);

    expect(groups.map((group) => group.status)).toEqual(["review", "execute", "plan", "done"]);
  });

  it("matches planner assignments in commander search", () => {
    expect(taskMatchesCommanderQuery({
      title: "Build",
      owner_agent: "owner",
      planner_agent: "planning-specialist",
      reviewer_agent: "reviewer",
    }, "planning-specialist")).toBe(true);
  });

  it("matches project metadata in commander search", () => {
    expect(taskMatchesCommanderQuery({
      title: "Build",
      project: { name: "Control Plane", slug: "control-plane" },
    }, "control-plane")).toBe(true);
    expect(taskMatchesCommanderQuery({
      title: "Build",
      project: { name: "Control Plane", slug: "control-plane" },
    }, "control plane")).toBe(true);
  });

  it("uses distinct intuitive runtime group symbols", () => {
    const icons = Object.fromEntries(RUNTIME_GROUPS.map((group) => [group.key, group.icon]));

    expect(icons.running).toBe("●");
    expect(icons.attention).toBe("▲");
    expect(icons.ready).toBe("◇");
    expect(icons.waiting).toBe("□");
    expect(icons.automated).toBe("◆");
    expect(icons.completed).toBe("✓");
    expect(new Set(Object.values(icons)).size).toBe(Object.values(icons).length);
  });

  it("keys the task-list cache by the loaded task breadth", () => {
    expect(commanderTaskListRequestQuery({
      showCompleted: false,
      groupFilter: "all",
      stageFilter: "all",
    })).toEqual({ scope: "runtime", done_limit: "0" });
    expect(commanderTaskListCacheKey({
      showCompleted: false,
      groupFilter: "all",
      stageFilter: "all",
    })).toBe("runtime:0");

    expect(commanderTaskListRequestQuery({
      showCompleted: true,
      groupFilter: "all",
      stageFilter: "all",
    })).toEqual({ scope: "runtime", done_limit: "200" });
    expect(commanderTaskListCacheKey({
      showCompleted: false,
      groupFilter: "completed",
      stageFilter: "all",
    })).toBe("runtime:200");
    expect(commanderTaskListCacheKey({
      showCompleted: false,
      groupFilter: "all",
      stageFilter: "done",
    })).toBe("runtime:200");
  });

  it("stores task-list cache snapshots without sharing the task array", () => {
    const key = commanderTaskListCacheKey({ showCompleted: false });
    writeCommanderTaskListCache(key, {
      tasks: [{ id: "task-1", title: "Cached task" }],
      summary: { hidden_done_count: 2 },
    });

    const firstRead = readCommanderTaskListCache(key);
    expect(firstRead).toEqual({
      tasks: [{ id: "task-1", title: "Cached task" }],
      summary: { hidden_done_count: 2 },
    });

    firstRead.tasks.push({ id: "task-2", title: "Mutation attempt" });
    expect(readCommanderTaskListCache(key).tasks).toHaveLength(1);
    expect(readCommanderTaskListCache("runtime:200")).toBeNull();
  });
});
