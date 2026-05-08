import { describe, expect, it } from "vitest";
import {
  buildGoalResourceGroups,
  goalDraftFrom,
  goalRouteHash,
  goalStatusLabel,
} from "../../ui/src/routes/Goals.jsx";

describe("Goals route helpers", () => {
  it("builds stable goal route hashes from the synthetic root id", () => {
    expect(goalRouteHash({ goal_id: "goal 1" })).toBe("#/goals/goal%201");
    expect(goalRouteHash({ root_task_id: "root/1" })).toBe("#/goals/root%2F1");
    expect(goalRouteHash({})).toBe("#/goals");
  });

  it("labels goal state distinctly from team charters", () => {
    expect(goalStatusLabel({ goal_status: "complete", contract: {} })).toBe("Complete");
    expect(goalStatusLabel({ goal_status: "blocked", contract: {} })).toBe("Blocked");
    expect(goalStatusLabel({ goal_status: "in_progress", contract: { paused_at: 10 } })).toBe("Paused");
    expect(goalStatusLabel({ goal_status: "in_progress", contract: {} })).toBe("In progress");
  });

  it("groups goals for the native Goals workspace", () => {
    const goals = [
      { goal_id: "done", project: { name: "Done" }, team_name: "Ops", goal_status: "complete", contract: { objective: "Done" } },
      { goal_id: "paused", project: { name: "Paused" }, team_name: "Ops", goal_status: "in_progress", contract: { objective: "Paused", paused_at: 10 } },
      { goal_id: "active", project: { name: "Active" }, team_name: "Build", goal_status: "in_progress", contract: { objective: "Active" } },
      { goal_id: "blocked", project: { name: "Blocked" }, team_name: "Build", goal_status: "blocked", contract: { objective: "Blocked" } },
    ];

    const groups = buildGoalResourceGroups(goals);

    expect(groups.map((group) => [group.key, group.items.map((goal) => goal.goal_id)])).toEqual([
      ["active", ["active"]],
      ["blocked", ["blocked"]],
      ["paused", ["paused"]],
      ["complete", ["done"]],
    ]);
  });

  it("filters goals by search text and state", () => {
    const groups = buildGoalResourceGroups([
      { goal_id: "a", project: { name: "Editor" }, team_name: "Build", goal_status: "in_progress", contract: { objective: "Native editing" } },
      { goal_id: "b", project: { name: "Runner" }, team_name: "Ops", goal_status: "blocked", contract: { objective: "Lead cycle" } },
    ], { query: "native", state: "active" });

    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((goal) => goal.goal_id)).toEqual(["a"]);
  });

  it("builds a blank editor draft for a new goal", () => {
    expect(goalDraftFrom(null)).toEqual({
      team_id: "",
      project_id: "",
      objective: "",
      stopping_condition: "",
      validation_loop: "",
      constraints_text: "",
    });
  });
});
