import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildAgentResourceGroups,
  buildKnowledgeResourceGroups,
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

  it("wires resource routes through the list-first layout and shared toolbar", () => {
    expect(source("src/ui/src/components/PaneLayout.jsx")).toContain("listFirst && !hasSelection");
    for (const route of ["Agents.jsx", "Teams.jsx", "Knowledge.jsx", "Skills.jsx"]) {
      const contents = source(`src/ui/src/routes/${route}`);
      expect(contents).toContain("ResourceListToolbar");
      expect(contents).toContain("listFirst");
      expect(contents).toContain("resource-list-layout");
    }
  });
});
