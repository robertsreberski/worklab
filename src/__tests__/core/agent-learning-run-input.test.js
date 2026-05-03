import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { buildTaskRunInput } from "../../core/run-input.js";
import { recordAgentMemoryCandidates } from "../../core/agent-learning.js";

function withDb(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), "worklab-learning-run-input-"));
  const db = makeTestDb();
  const config = { dataDir, repoRoot: process.cwd(), workspace: process.cwd() };
  try {
    return fn({ db, config });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function seedAgent(db, name = "owner") {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO agents (name, display_name, sdk, model, effort, instructions, created_at, updated_at)
    VALUES (?, ?, 'claude', 'claude:claude-sonnet-4-6', 'medium', 'Do careful work.', ?, ?)
  `).run(name, name, now, now);
}

function seedTaskAndRun(db) {
  const now = 1700000000000;
  db.prepare(`
    INSERT INTO tasks (id, task_key, root_task_id, title, instructions, stage, owner_agent, created_at, updated_at)
    VALUES ('task-1', 'T-1', 'task-1', 'Learning task', 'Use learned context.', 'execute', 'owner', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, status, process_status)
    VALUES ('run-current', 'task-1', 'execute', 'execute', 'owner', ?, 'running', 'running')
  `).run(now + 1);
  db.prepare(`
    INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
    VALUES ('run-prior', 'task-1', 'execute', 'execute', 'owner', ?, ?, 'complete', 'succeeded')
  `).run(now - 10, now - 5);
}

describe("run input agent learning", () => {
  it("injects approved structured memories into plan and execute prompts", () => {
    withDb(({ db, config }) => {
      seedAgent(db);
      seedTaskAndRun(db);
      recordAgentMemoryCandidates(db, {
        agentName: "owner",
        taskId: "task-1",
        runId: "run-prior",
        autoApproveThreshold: 0.5,
        candidates: [
          { kind: "procedure", content: "Use targeted Vitest runs before full suite.", confidence: 0.9, scope: "agent" },
          { kind: "failure", content: "Do not inject draft memories.", confidence: 0.2, scope: "task" },
        ],
      });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: "task-1",
        agentName: "owner",
        runId: "run-current",
        mode: "execute",
      });

      expect(input.learningMemories.map((memory) => memory.content)).toEqual([
        "Use targeted Vitest runs before full suite.",
      ]);
      expect(input.systemPrompt).toContain("## Learned procedures");
      expect(input.systemPrompt).toContain("Use targeted Vitest runs before full suite.");
      expect(input.systemPrompt).not.toContain("Do not inject draft memories.");
      expect(input.promptDiagnostics.learningMemories).toBe(1);
    });
  });

  it("disables learning prompt injection when structured learning is off", () => {
    withDb(({ db, config }) => {
      seedAgent(db);
      seedTaskAndRun(db);
      db.prepare("INSERT INTO settings (key, value) VALUES ('agent_learning_enabled', ?)").run(JSON.stringify(false));
      recordAgentMemoryCandidates(db, {
        agentName: "owner",
        taskId: "task-1",
        autoApproveThreshold: 0.5,
        candidates: [{ kind: "procedure", content: "This native memory is ignored while learning is off.", confidence: 0.9 }],
      });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: "task-1",
        agentName: "owner",
        runId: "run-current",
        mode: "execute",
      });

      expect(input.learningMemories).toEqual([]);
      expect(input.systemPrompt).not.toContain("This native memory is ignored while learning is off.");
    });
  });
});
