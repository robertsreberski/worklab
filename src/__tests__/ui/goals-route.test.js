import { describe, expect, it } from "vitest";
import {
  buildGoalResourceGroups,
  goalLeadCycleTimeline,
  goalAssignmentState,
  goalDraftFrom,
  goalReadiness,
  goalReferenceLinks,
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
      links_text: "",
      constraints_text: "",
    });
  });

  it("computes guided readiness from the required goal fields", () => {
    expect(goalReadiness({
      objective: "Ship native goals",
      stopping_condition: "",
      validation_loop: "npm run build:ui",
    })).toEqual({
      ready: false,
      missing: ["stopping_condition"],
    });
    expect(goalReadiness({
      objective: "Ship native goals",
      stopping_condition: "The route is usable",
      validation_loop: "npm run build:ui",
    })).toEqual({ ready: true, missing: [] });
  });

  it("locks team selection to the selected project team", () => {
    const state = goalAssignmentState({
      draft: { project_id: "project-1", team_id: "" },
      projects: [
        { id: "project-1", name: "Project One", slug: "project-one", team_id: "team-a" },
        { id: "project-2", name: "Project Two", slug: "project-two", team_id: "" },
      ],
      teams: [
        { id: "team-a", name: "Team A" },
        { id: "team-b", name: "Team B" },
      ],
      isNew: true,
    });

    expect(state.lockedTeam).toMatchObject({ id: "team-a", name: "Team A" });
    expect(state.effectiveTeamId).toBe("team-a");
    expect(state.teamLocked).toBe(true);
    expect(state.teamOptions.map((option) => option.value)).toEqual(["team-a"]);
  });

  it("builds structured goal reference links", () => {
    const links = goalReferenceLinks({
      project: { slug: "journey", name: "Journey" },
      team_slug: "journey-pwa-build",
      root_task_id: "root-1",
      latest_cycle: { id: "run-1", task_id: "root-1" },
      contract: {
        links: [
          { label: "PRD", url: "https://example.com/prd" },
          { label: "Local route", url: "#/settings" },
        ],
      },
    });

    expect(links.map((link) => [link.kind, link.label, link.href])).toEqual([
      ["internal", "Project", "#/projects/journey"],
      ["internal", "Team", "#/library/teams/journey-pwa-build"],
      ["internal", "Latest lead cycle", "#/tasks/root-1?run=run-1"],
      ["internal", "Lead-cycle anchor", "#/tasks/root-1"],
      ["reference", "PRD", "https://example.com/prd"],
      ["reference", "Local route", "#/settings"],
    ]);
  });

  it("builds polished lead-cycle timeline rows from native cycle history", () => {
    const rows = goalLeadCycleTimeline({
      root_task_id: "root-1",
      cycles: [{
        id: "run-1",
        task_id: "root-1",
        process_status: "succeeded",
        goal_status: "in_progress",
        summary: "Assigned the next implementation pass.",
        checkpoint_note: "Keep ownership clear.",
        validation_summary: "Unit tests define persistence.",
        started_at: 1000,
        next_review_due_at: 61_000,
        next_review_event: "task_completed",
        tasks_created: 2,
        tasks_assigned: 1,
        notes_posted: 1,
      }],
    }, { now: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "run-1",
      href: "#/tasks/root-1?run=run-1",
      status: "succeeded",
      status_variant: "primary",
      review_label: "due in 1m",
      event_label: "after task completed",
      impact: ["2 created", "1 assigned", "1 noted"],
    });
  });
});
