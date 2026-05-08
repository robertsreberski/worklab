import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildAgentResourceGroups,
  buildKnowledgeResourceGroups,
  buildProjectResourceGroups,
  buildProviderResourceGroups,
  buildSkillResourceGroups,
  buildTeamResourceGroups,
} from "../../ui/src/lib/resourceLists.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function source(path) {
  return readFileSync(`${repoRoot}/${path}`, "utf8");
}

function cssRule(styles, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]+)\\}`))?.groups?.body || "";
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

  it("filters and groups providers by enabled state and type", () => {
    const groups = buildProviderResourceGroups([
      { id: "ollama-1", name: "Ollama", provider_type: "ollama", base_url: "http://localhost:11434", enabled: true, model_count: 2, updated_at: 1000 },
      { id: "groq-1", name: "Groq", provider_type: "groq", base_url: "https://api.groq.com/openai", enabled: true, model_count: 4, updated_at: 3000 },
      { id: "old-1", name: "Old gateway", provider_type: "openai_compat", base_url: "https://old.example.com", enabled: false, model_count: 1, updated_at: 2000 },
    ], { state: "enabled", type: "groq", query: "api.groq" });

    expect(groups.map((group) => [group.key, group.items.map((provider) => provider.id)])).toEqual([
      ["enabled", ["groq-1"]],
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
    const listComponents = source("src/ui/src/components/ResourceListToolbar.jsx");
    expect(listComponents).toContain("export function ResourceList(");
    expect(source("src/ui/src/components/PaneLayout.jsx")).toContain("listFirst && !hasSelection");
    for (const route of ["Agents.jsx", "Goals.jsx", "Teams.jsx", "Knowledge.jsx", "Skills.jsx", "Projects.jsx", "Providers.jsx"]) {
      const contents = source(`src/ui/src/routes/${route}`);
      expect(contents).toContain("ResourceList");
      expect(contents).toContain("ResourceListToolbar");
      expect(contents).toContain("listFirst");
      expect(contents).toContain("resource-list-layout");
      expect(contents).not.toMatch(/<div class="resource-list/);
    }
  });

  it("shares resource-row metadata primitives across the primary resource screens", () => {
    const metaComponent = source("src/ui/src/components/ResourceRowMeta.jsx");
    expect(metaComponent).toContain("function ResourceRowTags");
    expect(metaComponent).toContain("function ResourceRowChip");
    expect(metaComponent).toContain("function ResourceRowPath");

    for (const route of ["Agents.jsx", "Goals.jsx", "Knowledge.jsx", "Skills.jsx", "Projects.jsx", "Providers.jsx", "Teams.jsx"]) {
      const contents = source(`src/ui/src/routes/${route}`);
      expect(contents).toContain("ResourceRowTags");
      expect(contents).toContain("ResourceRowChip");
      expect(contents).not.toMatch(/class="[^"]*resource-row-(tags|chip)/);
    }

    const projects = source("src/ui/src/routes/Projects.jsx");
    expect(projects).toContain("<ResourceRowPath label=\"workdir\" value={project.workdir} />");
    expect(projects).not.toContain("project-row-workdir-chip");
  });

  it("bounds resource row metadata so long chips do not widen list geometry", () => {
    const styles = source("src/ui/src/styles.css");
    const fullWidthRowRule = cssRule(styles, ".resource-list-layout.two-pane-list-first .pane-row");
    const chipRule = cssRule(styles, ".resource-row-chip");
    const tagMonoRule = cssRule(styles, ".resource-row-tags > .pane-row-mono");
    const pathRule = cssRule(styles, ".resource-row-path");
    const pathValueRule = cssRule(styles, ".resource-row-path-value");
    const projectWorkdirRowRule = cssRule(styles, ".project-workdir-row");
    const projectWorkdirValueRule = cssRule(styles, ".project-workdir-value");
    const metaRule = cssRule(styles, ".pane-row-meta");
    const summaryRule = cssRule(styles, ".pane-row-summary");

    expect(fullWidthRowRule).toMatch(/grid-template-columns:\s*minmax\(28px,\s*auto\)\s+minmax\(0,\s*1fr\)\s+minmax\(96px,\s*168px\)/);
    for (const rule of [chipRule, tagMonoRule]) {
      expect(rule).toContain("max-width");
      expect(rule).toContain("overflow: hidden");
      expect(rule).toContain("text-overflow: ellipsis");
      expect(rule).toContain("white-space: nowrap");
    }
    expect(pathRule).toContain("max-width");
    expect(pathRule).toContain("overflow: hidden");
    expect(pathRule).not.toContain("border-radius");
    expect(pathValueRule).toContain("overflow: hidden");
    expect(pathValueRule).toContain("text-overflow: ellipsis");
    expect(pathValueRule).toContain("white-space: nowrap");
    expect(projectWorkdirRowRule).toContain("grid-template-columns: max-content minmax(0, 1fr) max-content");
    expect(projectWorkdirValueRule).toContain("overflow-wrap: anywhere");
    expect(projectWorkdirValueRule).toContain("word-break: normal");
    expect(styles).toContain("container-name: entity-detail");
    expect(styles).toContain("@container entity-detail");
    expect(styles).toContain("container-name: project-detail");
    expect(styles).toContain("@container project-detail");
    expect(metaRule).toContain("overflow: hidden");
    expect(summaryRule).toContain("max-width: 100%");
  });

  it("cross-links provider detail pages to agents that use their models", () => {
    const contents = source("src/ui/src/routes/Providers.jsx");

    expect(contents).toContain("api.providerAgents");
    expect(contents).toContain("Used by agents");
    expect(contents).toContain("#/agents/${encodeURIComponent(agent.name)}");
  });

  it("keeps resource list filters behind a compact shared configuration surface", () => {
    const toolbar = source("src/ui/src/components/ResourceListToolbar.jsx");
    const styles = source("src/ui/src/styles.css");
    const toolbarRule = cssRule(styles, ".resource-toolbar");
    const sheetRule = cssRule(styles, ".resource-toolbar-config.mobile-config-sheet");
    const openSheetRule = cssRule(styles, ".resource-toolbar-config.mobile-config-sheet.open");
    const panelRule = cssRule(styles, ".resource-toolbar-config .mobile-config-sheet-panel");

    expect(toolbar).toContain("resource-toolbar resource-toolbar-compact");
    expect(toolbar).toContain("resource-mobile-config-trigger");
    expect(toolbarRule).toContain("grid-template-columns: minmax(0, 1fr) auto auto");
    expect(sheetRule).toContain("display: none");
    expect(openSheetRule).toContain("display: block");
    expect(panelRule).toContain("position: fixed");
    expect(panelRule).toContain("width: min(360px, calc(100vw - 32px))");
  });

  it("builds resource list groups on the shared SectionGroup layout", () => {
    const toolbar = source("src/ui/src/components/ResourceListToolbar.jsx");
    const styles = source("src/ui/src/styles.css");

    expect(toolbar).toMatch(/import\s+\{[^}]*SectionGroup[^}]*\}\s+from/);
    expect(toolbar).toMatch(/<SectionGroup[\s\S]*class="resource-group"/);
    expect(toolbar).not.toMatch(/<div\s+class="resource-group-header"/);
    expect(styles).toContain(".resource-group > .ds-section-group-head");
    expect(styles).not.toContain(".resource-group-header");
    expect(styles).not.toContain(".resource-group-count");
  });

  it("keeps mobile list create actions in a shared floating FAB", () => {
    const toolbar = source("src/ui/src/components/ResourceListToolbar.jsx");
    const paneHeader = source("src/ui/src/components/layout/PaneListHeader.jsx");
    const styles = source("src/ui/src/styles.css");

    expect(toolbar).toContain("resource-list-fab");
    expect(paneHeader).toContain("resource-list-fab");
    expect(styles).toContain(".resource-list-fab");
    expect(styles).toContain(".app.responsive:has(.resource-list-fab) .assistant-launcher");
    expect(styles).toMatch(/\.resource-toolbar-actions\s*\{[^}]*display:\s*none/);
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
