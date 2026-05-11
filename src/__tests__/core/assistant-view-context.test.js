import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { renderAssistantViewContext } from "../../core/assistant/view-context.js";

function seedAgent(db, name, displayName = name) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', ?, ?)
  `).run(name, displayName, now, now);
}

describe("assistant view context rendering", () => {
  it("renders team list and detail context for current team views", () => {
    const db = makeTestDb();
    try {
      const now = Date.parse("2026-05-08T10:00:00Z");
      seedAgent(db, "lead", "Lead Agent");
      seedAgent(db, "builder", "Builder Agent");
      db.prepare(`
        INSERT INTO teams
          (id, slug, name, description, goal, lead_agent, status, schedule_enabled, schedule_interval_minutes, created_at, updated_at)
        VALUES
          ('team-1', 'core-platform', 'Core Platform', 'Owns core flows', 'Keep resources connected', 'lead', 'active', 1, 60, ?, ?)
      `).run(now, now);
      db.prepare("INSERT INTO team_members (team_id, agent_name, role_description, created_at) VALUES ('team-1', 'builder', 'Implementation', ?)")
        .run(now);
      db.prepare(`
        INSERT INTO projects (id, slug, name, team_id, archived, created_at, updated_at)
        VALUES ('project-1', 'worklab', 'Worklab', 'team-1', 0, ?, ?)
      `).run(now, now);

      const listContext = renderAssistantViewContext({
        db,
        viewContext: { route: "teams", view: "team_list", hash: "#/library/teams" },
      });
      expect(listContext).toContain("Teams: total=1, active=1");
      expect(listContext).toContain("Core Platform (core-platform)");

      const detailContext = renderAssistantViewContext({
        db,
        viewContext: {
          route: "teams",
          view: "team_detail",
          resource_type: "team",
          resource_id: "core-platform",
          hash: "#/library/teams/core-platform",
        },
      });
      expect(detailContext).toContain("Team: Core Platform (core-platform)");
      expect(detailContext).toContain("Lead agent: lead");
      expect(detailContext).toContain("Team members:");
      expect(detailContext).toContain("Builder Agent (builder)");
      expect(detailContext).toContain("Assigned projects:");
      expect(detailContext).toContain("Worklab (worklab)");
      expect(detailContext).toContain("worklab_team_get");
    } finally {
      db.close();
    }
  });
});
