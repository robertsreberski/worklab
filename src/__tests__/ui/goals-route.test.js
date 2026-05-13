import { describe, expect, it } from "vitest";
import {
  buildGoalResourceGroups,
  goalCockpitSummary,
  goalLeadTaskDisplay,
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
      north_star: "",
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
      ["reference", "PRD", "https://example.com/prd"],
      ["reference", "Local route", "#/settings"],
    ]);
  });

  it("does not expose root task anchors when a goal has no latest cycle", () => {
    const links = goalReferenceLinks({
      project: { slug: "journey", name: "Journey" },
      team_slug: "journey-pwa-build",
      root_task_id: "root-1",
      latest_cycle: null,
      contract: { links: [] },
    });

    expect(links.map((link) => [link.kind, link.label, link.href])).toEqual([
      ["internal", "Project", "#/projects/journey"],
      ["internal", "Team", "#/library/teams/journey-pwa-build"],
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
        tasks_deleted: 1,
        tasks_skipped: 1,
        notes_posted: 1,
        task_deletions: [{ task_key: "T-42", title: "Obsolete lead task", rationale: "Superseded." }],
        goal_refinement_applied: {
          applied: true,
          applied_fields: ["north_star", "objective"],
          rationale: "The project should aim higher without changing scope.",
          patch_applied: {
            north_star: "Autonomous project cockpit.",
            objective: "Ship the native goal cockpit.",
          },
        },
      }],
    }, { now: 1000 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "run-1",
      href: "#/tasks/root-1?run=run-1",
      status: "Completed",
      status_variant: "primary",
      tone: "success",
      review_label: "due in 1m",
      timeline_review_label: "after task completed",
      event_label: "after task completed",
      goal_status_label: null,
      impact: [
        { key: "created", label: "2 tasks created", tone: "accent" },
        { key: "assigned", label: "1 task assigned", tone: "accent" },
        { key: "deleted", label: "1 task removed", tone: "warn" },
        { key: "skipped", label: "1 task skipped", tone: "warn" },
        { key: "comments", label: "1 comment", tone: "muted" },
      ],
      deletions: [{ task_key: "T-42", title: "Obsolete lead task", rationale: "Superseded." }],
      refinement: {
        status: "applied",
        label: "Goal refined",
        fields: ["north_star", "objective"],
      },
    });
  });

  it("keeps completed lead-cycle rows from looking urgent or still active", () => {
    const [row] = goalLeadCycleTimeline({
      root_task_id: "root-1",
      cycles: [{
        id: "run-1",
        task_id: "root-1",
        process_status: "succeeded",
        goal_status: "in_progress",
        started_at: 500,
        next_review_due_at: 1_000,
        notes_posted: 4,
      }],
    }, { now: 2_000 });

    expect(row).toMatchObject({
      status: "Completed",
      tone: "success",
      review_label: "due now",
      timeline_review_label: null,
      goal_status_label: null,
      impact: [{ key: "comments", label: "4 comments", tone: "muted" }],
    });
  });

  it("only shows goal-state chips in lead-cycle rows when the state is additive", () => {
    const rows = goalLeadCycleTimeline({
      root_task_id: "root-1",
      cycles: [
        { id: "run-1", process_status: "succeeded", goal_status: "blocked" },
        { id: "run-2", process_status: "succeeded", goal_status: "complete" },
      ],
    }, { now: 1_000 });

    expect(rows.map((row) => [row.goal_status_label, row.goal_status_variant])).toEqual([
      ["Goal blocked", "warn"],
      ["Goal complete", "accent"],
    ]);
  });

  it("builds a project goal cockpit summary with scoped impact and open goal work", () => {
    const summary = goalCockpitSummary({
      goal_status: "in_progress",
      last_lead_at: 61_000,
      readiness: { ready: true, missing: [] },
      lead_tasks: [
        { id: "lead-task-1", task_key: "T-42", title: "Run smoke", stage: "execute", owner_agent: "engineer" },
      ],
      cycles: [{
        id: "run-1",
        process_status: "succeeded",
        summary: "Pruned and focused the next pass.",
        checkpoint_note: "One obsolete task removed.",
        tasks_created: 2,
        tasks_assigned: 1,
        tasks_deleted: 1,
        tasks_skipped: 1,
        notes_posted: 1,
      }],
    }, { now: 1000 });

    expect(summary.latest.summary).toBe("Pruned and focused the next pass.");
    expect(summary.latestDecision).toBe("Pruned and focused the next pass.");
    expect(summary.stateStrip.map((item) => item.label)).toEqual(["State", "Definition", "Last review", "Next review"]);
    expect(summary.impactLabel).toBe("Last decision impact");
    expect(summary.impact.map((item) => [item.key, item.value])).toEqual([
      ["created", 2],
      ["assigned", 1],
      ["deleted", 1],
      ["skipped", 1],
      ["comments", 1],
    ]);
    expect(summary.leadTasks[0]).toMatchObject({ task_key: "T-42", title: "Run smoke" });
  });

  it("scopes cockpit impact counters to the latest decision row", () => {
    const summary = goalCockpitSummary({
      goal_status: "in_progress",
      readiness: { ready: true, missing: [] },
      cycles: [{
        id: "run-2",
        process_status: "running",
        tasks_created: 5,
        tasks_assigned: 4,
        tasks_deleted: 3,
        tasks_skipped: 2,
        notes_posted: 1,
      }, {
        id: "run-1",
        process_status: "succeeded",
        checkpoint_note: "Keep the existing owners moving; no new delegation.",
        validation_summary: "Checked child task state.",
        tasks_created: 0,
        tasks_assigned: 1,
        tasks_deleted: 0,
        tasks_skipped: 0,
        notes_posted: 2,
      }],
    }, { now: 1000 });

    expect(summary.latest.id).toBe("run-2");
    expect(summary.decisionCycle.id).toBe("run-1");
    expect(summary.latestDecision).toBe("Keep the existing owners moving; no new delegation.");
    expect(summary.latestDetails).toEqual(["Checked child task state."]);
    expect(summary.impactLabel).toBe("Last decision impact");
    expect(summary.impact.map((item) => [item.key, item.value])).toEqual([
      ["created", 0],
      ["assigned", 1],
      ["deleted", 0],
      ["skipped", 0],
      ["comments", 2],
    ]);
  });

  it("builds open goal work labels without repeating the task title", () => {
    expect(goalLeadTaskDisplay({ task_key: "T-42", title: "Run smoke" })).toEqual({
      badgeLabel: "T-42",
      title: "Run smoke",
    });
    expect(goalLeadTaskDisplay({ id: "task-123", title: "Refine scope" })).toEqual({
      badgeLabel: "Task",
      title: "Refine scope",
    });
  });
});
