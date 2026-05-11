// End-to-end exercise of the cross-entity @-mention plumbing:
// 1. Search returns the right token for an existing entity.
// 2. Storing a comment with that token round-trips through the comments
//    list endpoint and shows up in the mentions sidecar.
// 3. The same token resolves through the LLM-expansion path so the
//    runtime sees a readable, round-trippable form.
// 4. After renaming the agent, the resolved label updates without
//    rewriting the stored prose, and the LLM expansion picks up the
//    new label too.

import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "../../api/server.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { expandMentionsForLlm } from "../../core/index.js";

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
const noopWatcher = {
  handleRunRequested: async () => ({ runId: "fake" }),
  cancel: () => true,
  shutdown: async () => {},
  isActive: () => false,
  isRunActive: () => false,
  getRunLiveInputState: () => ({ supported: false, active: false, reason: "unsupported_provider" }),
  sendRunMessage: async () => ({ ok: false, code: "run_not_active" }),
  maybeAutoStart: () => {},
  maybeAutoStartDependents: () => {},
  maybeScheduleUnassignedTeamTask: () => {},
};

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "worklab-mentions-e2e-"));
  mkdirSync(join(dataDir, "knowledge"), { recursive: true });
  const db = openDb(join(dataDir, "test.db"));
  runMigrations(db);
  const { app } = createServer({ db, logger: silentLogger, watcher: noopWatcher, dataDir });
  const http = createHttpServer(app);
  await new Promise((resolve) => http.listen(0, resolve));
  const baseUrl = `http://localhost:${http.address().port}`;
  return {
    db,
    dataDir,
    baseUrl,
    close: async () => {
      await new Promise((resolve) => http.close(resolve));
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function seedAgent(db, name, displayName) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, enabled, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', 1, ?, ?)
  `).run(name, displayName, now, now);
}

function seedTask(db, { id, task_key, title, instructions = "" }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (id, task_key, root_task_id, title, instructions, stage, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'execute', ?, ?)
  `).run(id, task_key, id, title, instructions, now, now);
}

describe("mentions end-to-end", () => {
  it("search → store comment → render sidecar → expand for LLM → rename → re-resolve", async () => {
    const ctx = await boot();
    try {
      seedAgent(ctx.db, "triager", "Triager Bot");
      seedTask(ctx.db, { id: "task-1", task_key: "T-1", title: "Fix login" });

      // 1) Picker fetches the agent token.
      const search = await fetch(`${ctx.baseUrl}/api/mentions/search?q=triag&types=agent`).then((r) => r.json());
      expect(search.results[0]).toMatchObject({
        token: "@agent/triager",
        href: "#/library/agents/triager",
        label: "Triager Bot",
      });
      const token = search.results[0].token;

      // 2) Author a comment that uses the token.
      const post = await fetch(`${ctx.baseUrl}/api/tasks/task-1/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: `Hand off to ${token}` }),
      });
      expect(post.status).toBeLessThan(400);

      // 3) GET /api/tasks/:id includes a mentions sidecar that the UI
      //    can render directly into a clickable badge.
      const detail = await fetch(`${ctx.baseUrl}/api/tasks/task-1`).then((r) => r.json());
      const stored = detail.comments.find((c) => c.body.includes("Hand off"));
      expect(stored.body).toBe("Hand off to @agent/triager");
      expect(detail.mentions["@agent/triager"]).toMatchObject({
        type: "agent",
        label: "Triager Bot",
        href: "#/library/agents/triager",
        exists: true,
      });

      // 4) When the comment text reaches the LLM, the token expands.
      const expanded = expandMentionsForLlm(ctx.db, stored.body, { dataDir: ctx.dataDir });
      expect(expanded).toBe("Hand off to Triager Bot (agent, @agent/triager)");

      // 5) Rename the agent. The stored prose is untouched but the next
      //    sidecar / expansion picks up the new label automatically.
      ctx.db.prepare("UPDATE agents SET display_name = ? WHERE name = 'triager'").run("Triage Lead");
      const detail2 = await fetch(`${ctx.baseUrl}/api/tasks/task-1`).then((r) => r.json());
      const stillStored = detail2.comments.find((c) => c.body.includes("Hand off"));
      expect(stillStored.body).toBe("Hand off to @agent/triager");
      expect(detail2.mentions["@agent/triager"].label).toBe("Triage Lead");

      const expanded2 = expandMentionsForLlm(ctx.db, stillStored.body, { dataDir: ctx.dataDir });
      expect(expanded2).toBe("Hand off to Triage Lead (agent, @agent/triager)");
    } finally {
      await ctx.close();
    }
  });

  it("renders dangling references as missing once the entity is deleted", async () => {
    const ctx = await boot();
    try {
      seedAgent(ctx.db, "triager", "Triager Bot");
      seedTask(ctx.db, { id: "task-1", task_key: "T-1", title: "Fix login" });
      await fetch(`${ctx.baseUrl}/api/tasks/task-1/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Defer to @agent/triager" }),
      });

      // Delete the agent.
      ctx.db.prepare("DELETE FROM agents WHERE name = 'triager'").run();

      const detail = await fetch(`${ctx.baseUrl}/api/tasks/task-1`).then((r) => r.json());
      expect(detail.mentions["@agent/triager"]).toMatchObject({
        exists: false,
        href: null,
      });
    } finally {
      await ctx.close();
    }
  });
});
