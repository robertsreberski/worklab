import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTeamGoalDashboardGroups,
  formatTeamLeadRunToast,
  goalStatusLabel,
  leadCycleRawLogHref,
  leadCycleTaskHref,
  teamSetupGaps,
} from "../../ui/src/routes/library/TeamsTab.jsx";

const teamsSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/library/TeamsTab.jsx");
const stylesSourcePath = resolve(import.meta.dirname, "../../ui/src/styles.css");

describe("team setup guidance", () => {
  it("reports missing setup pieces in the team detail view", () => {
    expect(teamSetupGaps(
      { goal: "", lead_agent: "" },
      [],
      [],
    )).toEqual([
      "Add a team charter so the lead knows what work this team owns.",
      "Pick a lead agent to coordinate and delegate.",
      "Add member agents with distinct specialties.",
      "Assign the team to a project or task when it is ready.",
    ]);
  });

  it("does not show setup gaps once the team has the core pieces", () => {
    expect(teamSetupGaps(
      { goal: "Ship Worklab UI improvements", lead_agent: "lead" },
      [{ agent_name: "builder" }, { agent_name: "reviewer" }],
      [{ id: "project-1" }],
    )).toEqual([]);
  });

  it("formats manual lead-run toasts with skipped/error reasons", () => {
    expect(formatTeamLeadRunToast([{ ok: true }, { ok: true }])).toEqual({
      message: "Queued 2 lead cycles",
      variant: "success",
    });
    expect(formatTeamLeadRunToast([{ ok: true }, { ok: false, error: "lead cycle already in flight" }])).toEqual({
      message: "Queued 1 lead cycle; skipped 1: lead cycle already in flight",
      variant: "warning",
    });
    expect(formatTeamLeadRunToast([{ ok: false, error: "watcher unavailable" }])).toEqual({
      message: "No lead cycles queued: watcher unavailable",
      variant: "warning",
    });
  });

  it("builds encoded lead-cycle task and raw-log links", () => {
    const cycle = { task_id: "task 1", id: "run/1" };

    expect(leadCycleTaskHref(cycle)).toBe("#/tasks/task%201?run=run%2F1");
    expect(leadCycleRawLogHref(cycle)).toBe("/api/runs/run%2F1/raw-log");
  });

  it("does not build broken lead-cycle links when ids are missing", () => {
    expect(leadCycleTaskHref({ task_id: "task 1" })).toBe(null);
    expect(leadCycleTaskHref({ id: "run/1" })).toBe(null);
    expect(leadCycleRawLogHref({})).toBe(null);
  });

  it("groups team-project goals for the Teams dashboard", () => {
    const goals = [
      { project: { name: "Done" }, goal_status: "complete", contract: { objective: "Done" } },
      { project: { name: "Paused" }, goal_status: "in_progress", contract: { objective: "Paused", paused_at: 10 } },
      { project: { name: "Active" }, goal_status: "in_progress", contract: { objective: "Active" } },
      { project: { name: "Blocked" }, goal_status: "blocked", contract: { objective: "Blocked" } },
    ];

    const groups = buildTeamGoalDashboardGroups(goals);

    expect(groups.map((group) => [group.key, group.items.map((item) => item.project.name)])).toEqual([
      ["active", ["Active"]],
      ["blocked", ["Blocked"]],
      ["paused", ["Paused"]],
      ["complete", ["Done"]],
    ]);
    expect(goalStatusLabel(goals[1])).toBe("Paused");
    expect(goalStatusLabel(goals[2])).toBe("In progress");
  });

  it("surfaces native goal links in Teams, Projects, Commander, and Task Detail", () => {
    const teamsSource = readFileSync(teamsSourcePath, "utf8");
    const projectsSource = readFileSync(resolve(import.meta.dirname, "../../ui/src/routes/Projects.jsx"), "utf8");
    const commanderSource = readFileSync(resolve(import.meta.dirname, "../../ui/src/components/CommanderRow.jsx"), "utf8");
    const taskDetailSource = readFileSync(resolve(import.meta.dirname, "../../ui/src/routes/TaskDetail.jsx"), "utf8");

    expect(teamsSource).toContain("Team charter");
    expect(teamsSource).toContain("#/goals/");
    expect(projectsSource).toContain("Project goal");
    expect(projectsSource).toContain("#/goals/");
    // Critique §03: the team-goal chip moved into the inline-meta line and
    // links to the Commander goal filter (?goal=) instead of the goal page.
    expect(commanderSource).toMatch(/#\/tasks\?goal=/);
    expect(taskDetailSource).toContain("#/goals/");
  });

  it("keeps Teams setup guidance short and contextual", () => {
    const source = readFileSync(teamsSourcePath, "utf8");

    expect(source).toContain("Good team checklist");
    expect(source).toContain("Members: add 2-5 specialists with distinct strengths.");
    expect(source).toContain("Controls: start manual, then add schedules/budgets once the roster works.");
    expect(source).not.toContain("Tutorial");
  });

  it("keeps the lead agent picker full width in the team editor", () => {
    const teamsSource = readFileSync(teamsSourcePath, "utf8");
    const stylesSource = readFileSync(stylesSourcePath, "utf8");

    expect(teamsSource).toContain('class="team-lead-picker"');
    expect(stylesSource).toContain(".team-lead-picker");
    expect(stylesSource).toContain("width: 100%");
  });

  it("uses compact team-list status treatment instead of a cramped badge", () => {
    const teamsSource = readFileSync(teamsSourcePath, "utf8");
    const stylesSource = readFileSync(stylesSourcePath, "utf8");

    expect(teamsSource).toContain('class="team-row-leading"');
    expect(teamsSource).toContain('class="team-list-status"');
    expect(teamsSource).toContain("<StatusDot");
    expect(teamsSource).not.toContain("trailing={<Badge variant={statusTone(team.status)}>{team.status}</Badge>}");
    expect(stylesSource).toContain(".team-list-status");
  });
});
