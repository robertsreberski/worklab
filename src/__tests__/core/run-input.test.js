import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { buildNextTaskRunPreview, buildTaskRunInput } from "../../core/run-input.js";

function withRunInputDb(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), "worklab-run-input-"));
  const db = makeTestDb();
  const config = { dataDir, repoRoot: process.cwd(), workspace: process.cwd() };
  try {
    return fn({ db, config });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function seedAgent(db, name, instructions = `Instructions for ${name}`) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents
      (name, display_name, sdk, model, effort, instructions, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', 'medium', ?, ?, ?)
  `).run(name, name, instructions, now, now);
}

function seedTask(db, patch = {}) {
  const now = Date.now();
  const row = {
    id: patch.id || "task-1",
    task_key: patch.task_key || "T-1",
    title: patch.title || "Run input task",
    instructions: patch.instructions || "Do the work.",
    stage: patch.stage || "execute",
    owner_agent: patch.owner_agent || "owner",
    reviewer_agent: patch.reviewer_agent || null,
  };
  db.prepare(`
    INSERT INTO tasks
      (id, task_key, root_task_id, title, instructions, stage, owner_agent, reviewer_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.task_key, row.id, row.title, row.instructions, row.stage, row.owner_agent, row.reviewer_agent, now, now);
  return row;
}

describe("run input assembly", () => {
  it("uses the same assembled payload for execute previews and worker input", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      const now = 12345;

      const preview = buildNextTaskRunPreview({ db, config, taskId: task.id, now });
      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: `preview-${now}`,
        mode: "execute",
      });

      expect(preview.system_prompt).toBe(input.systemPrompt);
      expect(preview.messages).toEqual(input.messages);
    });
  });

  it("uses the same assembled payload for plan previews and worker input", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "planner", "Plan as owner.");
      const task = seedTask(db, { stage: "plan", owner_agent: "planner" });
      const now = 67890;

      const preview = buildNextTaskRunPreview({ db, config, taskId: task.id, now });
      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "planner",
        runId: `preview-${now}`,
        mode: "plan",
      });

      expect(preview.system_prompt).toBe(input.systemPrompt);
      expect(preview.messages).toEqual(input.messages);
    });
  });

  it("uses the same assembled payload for review previews and worker input", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Implement.");
      seedAgent(db, "reviewer", "Review.");
      const task = seedTask(db, { stage: "review", owner_agent: "owner", reviewer_agent: "reviewer" });
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
        VALUES ('run-exec', ?, 'execute', 'execute', 'owner', 1000, 2000, 'complete', 'succeeded')
      `).run(task.id);
      db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES ('log-exec', 'run-exec', ?, 'complete', 2000)")
        .run(JSON.stringify([{ type: "final", text: "Implemented.", numTurns: 1, durationMs: 1000 }]));
      const now = 24680;

      const preview = buildNextTaskRunPreview({ db, config, taskId: task.id, now });
      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "reviewer",
        runId: `preview-${now}`,
        mode: "review",
        priorRunId: "run-exec",
      });

      expect(preview.system_prompt).toBe(input.systemPrompt);
      expect(preview.messages).toEqual(input.messages);
    });
  });
});
