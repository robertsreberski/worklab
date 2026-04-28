import { describe, expect, it } from "vitest";
import { groupKeyFor, taskMatchesCommanderQuery } from "../../ui/src/routes/Commander.jsx";

describe("commander task grouping", () => {
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

  it("matches planner assignments in commander search", () => {
    expect(taskMatchesCommanderQuery({
      title: "Build",
      owner_agent: "owner",
      planner_agent: "planning-specialist",
      reviewer_agent: "reviewer",
    }, "planning-specialist")).toBe(true);
  });
});
