import { beforeEach, describe, expect, it } from "vitest";
import {
  RUNTIME_GROUPS,
  agentBulkOptions,
  clearCommanderTaskListCache,
  commanderTaskSortBucket,
  commanderTaskListCacheKey,
  commanderTaskListRequestQuery,
  compareCommanderGroups,
  compareCommanderTasks,
  formatCommanderCost,
  formatCommanderCostChipLabel,
  formatCommanderCostSummaryTitle,
  groupKeyFor,
  readCommanderTaskListCache,
  shouldLoadCommanderCostSummary,
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

  it("includes unpriced run counts in commander cost summary labels", () => {
    const summary = {
      today: { total_usd: 0.03, run_count: 2, unpriced_run_count: 1 },
      week: { total_usd: 0.06, run_count: 3, unpriced_run_count: 2 },
      today_by_agent: [
        { agent: "alpha", total_usd: 0.01, run_count: 1, unpriced_run_count: 0 },
        { agent: "beta", total_usd: 0.02, run_count: 1, unpriced_run_count: 1 },
      ],
    };

    expect(formatCommanderCostChipLabel(summary)).toBe("$0.03 today");
    expect(formatCommanderCostSummaryTitle(summary)).toEqual([
      "Today: $0.03 across 2 priced runs, 1 unpriced run",
      "This week: $0.06 across 3 priced runs, 2 unpriced runs",
      "  - alpha: $0.01 (1 priced run)",
      "  - beta: $0.02 (1 priced run, 1 unpriced run)",
    ]);
  });

  it("omits disabled agents from bulk assignment options", () => {
    const options = agentBulkOptions([
      { name: "enabled-owner", display_name: "Enabled Owner", enabled: true },
      { name: "disabled-owner", display_name: "Disabled Owner", enabled: false },
    ]);

    expect(options.map((option) => option.value)).toEqual(["__unassigned__", "enabled-owner"]);
  });

  it("shows an unpriced commander cost chip when today has only unpriced runs", () => {
    expect(formatCommanderCostChipLabel({
      today: { total_usd: 0, run_count: 0, unpriced_run_count: 2 },
    })).toBe("2 unpriced today");
  });

  it("skips cost-summary refreshes while hidden or already loading", () => {
    expect(shouldLoadCommanderCostSummary({ visible: true, inFlight: false })).toBe(true);
    expect(shouldLoadCommanderCostSummary({ visible: false, inFlight: false })).toBe(false);
    expect(shouldLoadCommanderCostSummary({ visible: true, inFlight: true })).toBe(false);
    expect(shouldLoadCommanderCostSummary({ visible: false, inFlight: false, force: true })).toBe(true);
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

  it("uses distinct readable runtime group icons", () => {
    const icons = Object.fromEntries(RUNTIME_GROUPS.map((group) => [group.key, group.icon]));

    expect(icons.running).toBe("zap");
    expect(icons.attention).toBe("alert-triangle");
    expect(icons.ready).toBe("play");
    expect(icons.waiting).toBe("clock");
    expect(icons.automated).toBe("calendar");
    expect(icons.completed).toBe("check-circle");
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
