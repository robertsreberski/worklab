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
    planner_agent: patch.planner_agent || null,
    reviewer_agent: patch.reviewer_agent || null,
    project_id: patch.project_id || null,
  };
  db.prepare(`
    INSERT INTO tasks
      (id, task_key, root_task_id, project_id, title, instructions, stage, owner_agent, planner_agent, reviewer_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.task_key, row.id, row.project_id, row.title, row.instructions, row.stage, row.owner_agent, row.planner_agent, row.reviewer_agent, now, now);
  return row;
}

function seedProject(db, patch = {}) {
  const now = Date.now();
  const row = {
    id: patch.id || "project-run-input",
    slug: patch.slug || "run-input-project",
    name: patch.name || "Run Input Project",
    description: patch.description || "Project description.",
    context: patch.context || "Project context for every run.",
    workdir: patch.workdir || "/tmp/worklab-project-run-input",
  };
  db.prepare(`
    INSERT INTO projects
      (id, slug, name, description, context_markdown, workdir, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.slug, row.name, row.description, row.context, row.workdir, now, now);
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

  it("injects project context and workdir into task run prompts", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const project = seedProject(db, {
        context: "Use the Project Atlas conventions.",
        workdir: "/tmp/project-atlas",
      });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-project",
        mode: "execute",
      });

      expect(input.project).toMatchObject({ id: project.id, slug: project.slug, name: project.name });
      expect(input.effectiveWorkdir).toBe("/tmp/project-atlas");
      const projectStart = input.systemPrompt.indexOf("## Project");
      const taskStart = input.systemPrompt.indexOf("## Task");
      expect(projectStart).toBeGreaterThan(0);
      expect(projectStart).toBeLessThan(taskStart);
      expect(input.systemPrompt).toContain("Use the Project Atlas conventions.");
      expect(input.systemPrompt).toContain("**Workdir:** `/tmp/project-atlas`");
      expect(input.promptDiagnostics.project).toMatchObject({
        id: project.id,
        slug: project.slug,
        workdir: "/tmp/project-atlas",
      });
    });
  });

  it("uses the spawn-time workdir snapshot recorded on task_runs", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const project = seedProject(db, { workdir: "/tmp/project-snapshot-original" });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, project_id, mode, stage, agent_name, started_at, status, process_status, workdir, project_context_hash)
        VALUES ('run-snap', ?, ?, 'execute', 'execute', 'owner', 1000, 'running', 'running', '/tmp/project-snapshot-original', 'snap-hash')
      `).run(task.id, project.id);
      db.prepare("UPDATE projects SET workdir = ?, updated_at = ? WHERE id = ?")
        .run("/tmp/project-snapshot-changed", Date.now() + 1000, project.id);

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-snap",
        mode: "execute",
      });

      expect(input.effectiveWorkdir).toBe("/tmp/project-snapshot-original");
      const refreshedHash = db.prepare("SELECT project_context_hash FROM task_runs WHERE id = ?")
        .get("run-snap").project_context_hash;
      expect(refreshedHash).not.toBe("snap-hash");
    });
  });

  it("uses live project context when a project changes", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const project = seedProject(db, { context: "Old context." });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });

      const first = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-project-1",
        mode: "execute",
      });
      db.prepare("UPDATE projects SET context_markdown = ?, updated_at = ? WHERE id = ?")
        .run("New context.", Date.now() + 1000, project.id);
      const second = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-project-2",
        mode: "execute",
      });

      expect(first.systemPrompt).toContain("Old context.");
      expect(second.systemPrompt).toContain("New context.");
      expect(second.systemPrompt).not.toContain("Old context.");
    });
  });

  it("uses an explicit planner for plan previews before falling back to owner", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Own the work.");
      seedAgent(db, "planner", "Plan as specialist.");
      const task = seedTask(db, { stage: "plan", owner_agent: "owner", planner_agent: "planner" });
      const now = 11111;

      const preview = buildNextTaskRunPreview({ db, config, taskId: task.id, now });
      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "planner",
        runId: `preview-${now}`,
        mode: "plan",
      });

      expect(preview.agent_name).toBe("planner");
      expect(preview.system_prompt).toBe(input.systemPrompt);
      expect(preview.system_prompt).toContain("Plan as specialist.");
      expect(preview.system_prompt).not.toContain("Own the work.");
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
