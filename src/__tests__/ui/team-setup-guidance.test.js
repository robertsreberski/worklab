import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatTeamLeadRunToast, teamSetupGaps } from "../../ui/src/routes/Teams.jsx";

const teamsSourcePath = resolve(import.meta.dirname, "../../ui/src/routes/Teams.jsx");
const stylesSourcePath = resolve(import.meta.dirname, "../../ui/src/styles.css");

describe("team setup guidance", () => {
  it("reports missing setup pieces in the team detail view", () => {
    expect(teamSetupGaps(
      { goal: "", lead_agent: "" },
      [],
      [],
    )).toEqual([
      "Add a goal so the lead knows what work this team owns.",
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
