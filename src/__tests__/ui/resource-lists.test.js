import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildAgentResourceGroups,
  buildKnowledgeResourceGroups,
  buildProjectResourceGroups,
  buildSkillResourceGroups,
  buildTeamResourceGroups,
} from "../../ui/src/lib/resourceLists.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function source(path) {
  return readFileSync(`${repoRoot}/${path}`, "utf8");
}

describe("resource list helpers", () => {
  it("filters and groups agents by enabled state and recent activity", () => {
    const now = Date.parse("2026-05-06T12:00:00Z");
    const groups = buildAgentResourceGroups([
      { name: "idle-coder", display_name: "Idle Coder", enabled: true, model: "pi:openai:gpt-5.5", effort: "high", lastRunAt: now - 30 * 60_000 },
      { name: "recent-coder", display_name: "Recent Coder", enabled: true, model: "pi:openai:gpt-5.5", effort: "xhigh", lastRunAt: now - 60_000 },
      { name: "retired", display_name: "Retired", enabled: false, model: "claude:opus", effort: "medium", lastRunAt: null },
    ], { state: "enabled", activity: "recent", model: "pi:openai:gpt-5.5", now });

    expect(groups.map((group) => [group.key, group.items.map((agent) => agent.name)])).toEqual([
      ["active", ["recent-coder"]],
    ]);
  });

  it("keeps archived teams discoverable only when the status filter asks for them", () => {
    const teams = [
      { slug: "active-team", name: "Active Team", status: "active", lead_agent: "lead", schedule_enabled: true, updated_at: 3 },
      { slug: "archived-team", name: "Archived Team", status: "archived", lead_agent: "", schedule_enabled: false, updated_at: 4 },
    ];

    expect(buildTeamResourceGroups(teams, { status: "active" }).map((group) => group.key)).toEqual(["active"]);
    expect(buildTeamResourceGroups(teams, { status: "archived", lead: "no_lead" }).map((group) => [group.key, group.items.map((team) => team.slug)])).toEqual([
      ["archived", ["archived-team"]],
    ]);
  });

  it("groups canonical knowledge by project first and category second", () => {
    const groups = buildKnowledgeResourceGroups([
      {
        slug: "project-runbook",
        title: "Runbook",
        project_id: "project-1",
        project: { slug: "project-one", name: "Project One" },
        category: "runbook",
        updated_at: "2026-05-05T00:00:00Z",
      },
      {
        slug: "project-research",
        title: "Research",
        project_id: "project-1",
        project: { slug: "project-one", name: "Project One" },
        category: "research",
        pinned: true,
        updated_at: "2026-05-04T00:00:00Z",
      },
      { slug: "run-output", title: "Run", category: "run-results", auto_promoted: true },
      { slug: "global-note", title: "Global", category: "decision", updated_at: "2026-05-06T00:00:00Z" },
    ], { surface: "canonical" });

    expect(groups.map((group) => [group.projectLabel, group.categoryLabel, group.items.map((entry) => entry.slug)])).toEqual([
      ["Project One", "Research", ["project-research"]],
      ["Project One", "Runbook", ["project-runbook"]],
      ["Global", "Decision", ["global-note"]],
    ]);
  });

  it("filters skills by priority and usage", () => {
    const groups = buildSkillResourceGroups([
      { name: "always-used", display_name: "Always Used", enabled: true, priority: "always", used_by_count: 2 },
      { name: "normal-unused", display_name: "Normal Unused", enabled: true, priority: "normal", used_by_count: 0 },
      { name: "disabled-used", display_name: "Disabled Used", enabled: false, priority: "normal", used_by_count: 3 },
    ], { priority: "always", usage: "used" });

    expect(groups.map((group) => [group.key, group.items.map((skill) => skill.name)])).toEqual([
      ["always", ["always-used"]],
    ]);
  });

  it("keeps projects searchable and grouped for the full-width resource list", () => {
    const projects = [
      {
        slug: "alpha-app",
        name: "Alpha App",
        description: "Retail checkout",
        context: "Mobile ordering context",
        workdir: "/repos/alpha",
        worktree_mode: "auto",
        team_id: "team-a",
        tags: ["frontend"],
        archived: false,
        updated_at: 1000,
      },
      {
        slug: "docs-hub",
        name: "Docs Hub",
        description: "Knowledge workflows",
        workdir: "/repos/docs",
        worktree_mode: "off",
        team_id: "",
        tags: ["kb"],
        archived: false,
        updated_at: 3000,
      },
      {
        slug: "legacy",
        name: "Legacy",
        description: "Old automation",
        workdir: "/repos/legacy",
        worktree_mode: "required",
        team_id: "team-a",
        tags: ["archive"],
        archived: true,
        updated_at: 2000,
      },
    ];

    expect(buildProjectResourceGroups(projects).map((group) => [group.key, group.items.map((project) => project.slug)])).toEqual([
      ["active", ["docs-hub", "alpha-app"]],
    ]);
    expect(buildProjectResourceGroups(projects, { status: "all", worktree: "required", team: "team-a" }).map((group) => [group.key, group.items.map((project) => project.slug)])).toEqual([
      ["archived", ["legacy"]],
    ]);
    expect(buildProjectResourceGroups(projects, { query: "ordering", team: "no_team" })).toEqual([]);
    expect(buildProjectResourceGroups(projects, { query: "ordering", worktree: "auto" }).map((group) => group.items.map((project) => project.slug))).toEqual([
      ["alpha-app"],
    ]);
  });

  it("wires resource routes through the list-first layout and shared toolbar", () => {
    expect(source("src/ui/src/components/PaneLayout.jsx")).toContain("listFirst && !hasSelection");
    for (const route of ["Agents.jsx", "Teams.jsx", "Knowledge.jsx", "Skills.jsx", "Projects.jsx"]) {
      const contents = source(`src/ui/src/routes/${route}`);
      expect(contents).toContain("ResourceListToolbar");
      expect(contents).toContain("listFirst");
      expect(contents).toContain("resource-list-layout");
    }
  });

  it("styles child task parent references as a full-width contextual strip", () => {
    const styles = source("src/ui/src/styles.css");
    const parentRule = styles.match(/\.task-parent-reference \{(?<body>[^}]+)\}/)?.groups?.body || "";
    const titleRule = styles.match(/\.task-parent-reference-title \{(?<body>[^}]+)\}/)?.groups?.body || "";

    expect(parentRule).toContain("display: flex");
    expect(parentRule).toContain("width: 100%");
    expect(parentRule).toContain("box-sizing: border-box");
    expect(titleRule).toContain("flex: 1 1 auto");
  });
});
