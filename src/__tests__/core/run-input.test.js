import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { buildNextTaskRunPreview, buildTaskRunInput } from "../../core/run-input.js";
import { appendJournalEntry, writeMemory } from "../../core/journal.js";

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
      expect(preview.input).toMatchObject({
        metadata: {
          task_id: task.id,
          task_key: task.task_key,
          stage: "execute",
          mode: "execute",
          agent_name: "owner",
          model: "claude:claude-sonnet-4-6",
          effort: "medium",
          generated_at: now,
        },
        system: { format: "markdown", content: input.systemPrompt },
        tools: [{ name: "run_log_read" }],
      });
      expect(preview.input.messages).toEqual(input.messages.map((message) => ({ ...message, format: "markdown" })));
      expect(preview.messages[0].content).toContain("# Work on task");
    });
  });

  it("surfaces run-start human comments as current run guidance", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
        VALUES ('run-prev', ?, 'execute', 'execute', 'owner', 1000, 2000, 'cancelled', 'cancelled')
      `).run(task.id);
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status)
        VALUES ('run-current', ?, 'execute', 'execute', 'owner', 3000, 'running', 'running')
      `).run(task.id);
      db.prepare(`
        INSERT INTO task_comments
          (id, task_id, author_type, body, created_at)
        VALUES (?, ?, 'human', ?, ?)
      `).run("comment-old", task.id, "Older guidance from the prior run.", 1500);
      db.prepare(`
        INSERT INTO task_comments
          (id, task_id, author_type, body, created_at)
        VALUES (?, ?, 'human', ?, ?)
      `).run("comment-current", task.id, "Remove all contents of the slack subdir and start over.", 3000);
      db.prepare(`
        INSERT INTO task_comments
          (id, task_id, author_type, body, created_at)
        VALUES (?, ?, 'human', ?, ?)
      `).run("comment-live", task.id, "Live input after the run started.", 3001);

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-current",
        mode: "execute",
      });

      expect(input.currentRunComments.map((comment) => comment.body)).toEqual([
        "Remove all contents of the slack subdir and start over.",
      ]);
      const guidanceStart = input.systemPrompt.indexOf("## Current Run Guidance");
      const taskStart = input.systemPrompt.indexOf("## Task");
      const guidanceSection = input.systemPrompt.slice(guidanceStart, taskStart);
      expect(guidanceStart).toBeGreaterThan(0);
      expect(guidanceStart).toBeLessThan(taskStart);
      expect(guidanceSection).toContain("newest current-run comment wins");
      expect(guidanceSection).toContain("Remove all contents of the slack subdir and start over.");
      expect(guidanceSection).not.toContain("Older guidance from the prior run.");
      expect(guidanceSection).not.toContain("Live input after the run started.");
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

  it("injects consolidated memory and recent journal from agent files", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Use stored procedures.");
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      writeMemory({
        dataDir: config.dataDir,
        agent: "owner",
        content: "# Procedures\n- Always run the release checklist.",
      });
      appendJournalEntry({
        dataDir: config.dataDir,
        agent: "owner",
        runId: "run-journal",
        taskId: task.id,
        taskTitle: task.title,
        bullet: "The staging deploy uses the release checklist.",
      });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-next",
        mode: "execute",
      });

      expect(input.memory).toContain("Always run the release checklist.");
      expect(input.journalTail).toContain("The staging deploy uses the release checklist.");
      expect(input.systemPrompt).toContain("## Memory\n\n# Procedures\n- Always run the release checklist.");
      expect(input.systemPrompt).toContain("## Recent journal");
      expect(input.systemPrompt).toContain("- The staging deploy uses the release checklist.");
    });
  });
});
