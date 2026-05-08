import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { buildNextTaskRunPreview, buildTaskRunInput, loadPriorRunSummaries } from "../../core/run-input.js";
import { createContextCache } from "../../core/context-cache.js";
import { appendJournalEntry, writeMemory } from "../../core/journal.js";
import { writeSettings } from "../../core/settings.js";

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

function seedAgent(db, name, instructions = `Instructions for ${name}`, patch = {}) {
  const now = Date.now();
  const model = patch.model || "claude:claude-sonnet-4-6";
  const sdk = patch.sdk || String(model).split(":", 1)[0] || "claude";
  db.prepare(`
    INSERT INTO agents
      (name, display_name, sdk, model, effort, instructions, builtin_allowlist,
       builtin_allowlist_mode, subagent_mode, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    patch.display_name || name,
    sdk,
    model,
    patch.effort || "medium",
    instructions,
    JSON.stringify(patch.builtin_allowlist || []),
    patch.builtin_allowlist_mode || "all",
    patch.subagent_mode || "advisory",
    patch.enabled === false ? 0 : 1,
    now,
    now,
  );
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
    team_id: patch.team_id || null,
  };
  db.prepare(`
    INSERT INTO tasks
      (id, task_key, root_task_id, project_id, team_id, title, instructions, stage, owner_agent, planner_agent, reviewer_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.task_key, row.id, row.project_id, row.team_id, row.title, row.instructions, row.stage, row.owner_agent, row.planner_agent, row.reviewer_agent, now, now);
  return row;
}

function seedTeam(db, patch = {}) {
  const now = Date.now();
  const row = {
    id: patch.id || "team-run-input",
    slug: patch.slug || "run-input-team",
    name: patch.name || "Run Input Team",
    lead_agent: patch.lead_agent || "owner",
  };
  db.prepare(`
    INSERT INTO teams (id, slug, name, lead_agent, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.slug, row.name, row.lead_agent, now, now);
  for (const member of patch.members || []) {
    db.prepare(`
      INSERT INTO team_members (team_id, agent_name, role_description, created_at)
      VALUES (?, ?, '', ?)
    `).run(row.id, member, now);
  }
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
    team_id: patch.team_id || null,
  };
  db.prepare(`
    INSERT INTO projects
      (id, slug, name, description, context_markdown, workdir, team_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.slug, row.name, row.description, row.context, row.workdir, row.team_id, now, now);
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
        now,
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
          workspace_mode: "direct",
          generated_at: now,
        },
        system: { format: "markdown", content: input.systemPrompt },
        tools: [{ name: "run_log_read" }],
      });
      expect(preview.input.messages).toEqual(input.messages.map((message) => ({ ...message, format: "markdown" })));
      expect(preview.messages[0].content).toContain("# Work on task");
    });
  });

  it("adds run-local date context to task messages", () => {
    withRunInputDb(({ db, config }) => {
      config.timezone = "Europe/Amsterdam";
      seedAgent(db, "owner", "Execute as owner.");
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
        VALUES ('run-stale', ?, 'execute', 'execute', 'owner', 1777701639188, 1777701699902, 'complete', 'succeeded')
      `).run(task.id);
      db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES ('log-stale', 'run-stale', ?, 'complete', ?)")
        .run(JSON.stringify([{ type: "final", text: "Today is 2026-05-02 (Sat, CEST).", numTurns: 1, durationMs: 1000 }]), 1777701699902);

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-current",
        mode: "execute",
        now: 1777971098852,
      });

      const message = input.messages[0].content;
      expect(message).toContain("## Runtime context");
      expect(message).toContain("Run started: 2026-05-05T08:51:38.852Z");
      expect(message).toContain("Timezone: Europe/Amsterdam");
      expect(message).toContain("Local time: Tuesday, 2026-05-05");
      expect(message).toContain("Today: 2026-05-05");
      expect(message).toContain("Yesterday: 2026-05-04");
      expect(message).toContain("Prior run and journal dates are historical context, not the current date");
      expect(message.indexOf("Today: 2026-05-05")).toBeLessThan(message.indexOf("Task:"));
      expect(input.systemPrompt).not.toContain("Run started: 2026-05-05T08:51:38.852Z");
    });
  });

  it("adds delegation policy and enabled agent roster to runnable prompts", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      seedAgent(db, "helper", "Help with focused work.");
      seedTask(db, { stage: "execute", owner_agent: "owner" });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: "task-1",
        agentName: "owner",
        runId: "run-current",
        mode: "execute",
      });

      expect(input.systemPrompt).toContain("## Delegation policy");
      expect(input.systemPrompt).toContain("Delegation budget: depth");
      expect(input.systemPrompt).toContain("## Available agents");
      expect(input.systemPrompt).toContain("`helper`");
      expect(input.delegation.canDelegate).toBe(true);
    });
  });

  it("limits prompt delegation candidates to the effective team roster", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Lead the team.");
      seedAgent(db, "helper", "Help with rostered work.");
      seedAgent(db, "executor", "Global executor.");
      const team = seedTeam(db, { lead_agent: "owner", members: ["helper"] });
      const project = seedProject(db, { team_id: team.id });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-current",
        mode: "execute",
      });

      expect(input.systemPrompt).toContain("Every delegated subtask's suggested_agent must be one of the agents listed in Available agents");
      expect(input.systemPrompt).toContain("`helper`");
      expect(input.systemPrompt).not.toContain("`executor`");
    });
  });

  it("builds native subagent context from same-runtime team agents", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Lead the Pi work.", {
        model: "pi:openai:gpt-5.5",
        sdk: "pi",
        subagent_mode: "advisory",
      });
      seedAgent(db, "helper", "Investigate bounded questions.", {
        model: "pi:openai:gpt-5.4-mini",
        sdk: "pi",
        builtin_allowlist_mode: "custom",
        builtin_allowlist: ["Read", "Grep", "Edit"],
      });
      seedAgent(db, "claude-helper", "Different runtime.", {
        model: "claude:claude-sonnet-4-6",
        sdk: "claude",
      });
      seedAgent(db, "outside", "Not on the team.", {
        model: "pi:openai:gpt-5.4-mini",
        sdk: "pi",
      });
      const team = seedTeam(db, { lead_agent: "owner", members: ["helper", "claude-helper"] });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", team_id: team.id });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-native-subagents",
        mode: "execute",
      });

      expect(input.nativeSubagents).toMatchObject({
        provider: "pi",
        mode: "advisory",
        toolName: "AskAgent",
        maxChildrenPerRound: expect.any(Number),
        maxParallelChildren: expect.any(Number),
      });
      expect(input.nativeSubagents.teammates.map((agent) => agent.name)).toEqual(["helper"]);
      expect(input.nativeSubagents.teammates[0].allowedTools).toEqual(["Read", "Grep"]);
      expect(input.nativeSubagents.teammates[0].mcpServers).toEqual({});
      expect(input.systemPrompt).toContain("## Native teammate subagents");
      const nativeSection = input.systemPrompt.split("## Native teammate subagents")[1].split("\n## Workspace")[0];
      expect(nativeSection).toContain("`helper`");
      expect(nativeSection).not.toContain("`claude-helper`");
      expect(nativeSection).not.toContain("`outside`");
    });
  });

  it("omits native subagents when no effective team is resolved", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Lead the Pi work.", {
        model: "pi:openai:gpt-5.5",
        sdk: "pi",
      });
      seedAgent(db, "helper", "Investigate bounded questions.", {
        model: "pi:openai:gpt-5.4-mini",
        sdk: "pi",
      });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-no-team-subagents",
        mode: "execute",
      });

      expect(input.nativeSubagents).toBeNull();
      expect(input.systemPrompt).not.toContain("## Native teammate subagents");
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

  it("injects prior task artifacts into run context", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      const priorArtifact = [{
        path: "src/prior.js",
        display_path: "src/prior.js",
        kind: "update",
        status: "completed",
        added_lines: 6,
        removed_lines: 2,
        has_line_delta: true,
        run_ids: ["run-prior"],
        first_run_id: "run-prior",
        last_run_id: "run-prior",
        first_seen_at: 2000,
        last_seen_at: 2000,
      }];
      const currentArtifact = [{
        path: "src/current.js",
        display_path: "src/current.js",
        kind: "update",
        status: "completed",
        added_lines: 99,
        removed_lines: 0,
        has_line_delta: true,
        run_ids: ["run-current"],
        first_run_id: "run-current",
        last_run_id: "run-current",
        first_seen_at: 3000,
        last_seen_at: 3000,
      }];
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status,
           artifacts_json, artifact_summary_json, artifact_paths_json)
        VALUES ('run-prior', ?, 'execute', 'execute', 'owner', 1000, 2000, 'complete', 'succeeded', ?, ?, ?)
      `).run(
        task.id,
        JSON.stringify(priorArtifact),
        JSON.stringify({ files: 1, added_lines: 6, removed_lines: 2, pending_files: 0, unavailable_count: 0, run_count: 1 }),
        JSON.stringify(["src/prior.js"]),
      );
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status,
           artifacts_json, artifact_summary_json, artifact_paths_json)
        VALUES ('run-current', ?, 'execute', 'execute', 'owner', 3000, 'running', 'running', ?, ?, ?)
      `).run(
        task.id,
        JSON.stringify(currentArtifact),
        JSON.stringify({ files: 1, added_lines: 99, removed_lines: 0, pending_files: 0, unavailable_count: 0, run_count: 1 }),
        JSON.stringify(["src/current.js"]),
      );

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-current",
        mode: "execute",
      });

      expect(input.systemPrompt).toContain("## Task artifacts");
      expect(input.systemPrompt).toContain("Task-wide file changes before this run: 1 file, +6 -2 across 1 run.");
      expect(input.systemPrompt).toContain("`src/prior.js` (+6 -2, last run `run-prior`)");
      expect(input.systemPrompt).not.toContain("src/current.js");
      expect(input.promptDiagnostics.artifacts).toMatchObject({ files: 1, added_lines: 6, removed_lines: 2 });
    });
  });

  it("injects resume snapshots from current run diagnostics into prompts", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      const resumeSnapshot = {
        schema: "worklab.transcript-tail.v1",
        captured_at: 1234,
        turn_count: 2,
        turns: [{
          assistant_text: "I already inspected the Claude provider and found the missing resume option.",
          thinking: null,
          tool_uses: [{ id: "toolu_1", name: "Read", input_summary: "{\"file_path\":\"src/ai/providers/claude-sdk.js\"}" }],
          tool_results: [{ tool_use_id: "toolu_1", is_error: false, content: "Claude SDK file content." }],
        }],
      };
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status, diagnostics_json)
        VALUES ('run-resume', ?, 'execute', 'execute', 'owner', 3000, 'running', 'running', ?)
      `).run(task.id, JSON.stringify({ resume_snapshot: resumeSnapshot }));

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-resume",
        mode: "execute",
      });

      expect(input.systemPrompt).toContain("## Resume context");
      expect(input.systemPrompt).toContain("<resume_context>");
      expect(input.systemPrompt).toContain("A previous attempt at this task ran 2 turn(s)");
      expect(input.systemPrompt).toContain("missing resume option");
      expect(input.systemPrompt).toContain("Tool call: Read");
      expect(input.promptDiagnostics.resumeContext).toBe(true);
    });
  });

  it("injects completed blocker latest execute output and artifacts into run context", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const task = seedTask(db, { id: "task-dependent", task_key: "T-2", stage: "execute", owner_agent: "owner" });
      const blocker = seedTask(db, { id: "task-blocker", task_key: "T-1", title: "Blocker task", stage: "done", owner_agent: "owner" });
      db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)")
        .run(task.id, blocker.id, 1000);
      const artifact = [{
        path: "src/blocker.js",
        display_path: "src/blocker.js",
        kind: "update",
        status: "completed",
        added_lines: 4,
        removed_lines: 1,
        has_line_delta: true,
        run_ids: ["run-blocker-exec"],
        first_run_id: "run-blocker-exec",
        last_run_id: "run-blocker-exec",
        first_seen_at: 2000,
        last_seen_at: 2000,
      }];
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status, decision, summary,
           artifacts_json, artifact_summary_json, artifact_paths_json)
        VALUES ('run-blocker-exec', ?, 'execute', 'execute', 'owner', 1000, 2000, 'complete', 'succeeded', 'advance', ?, ?, ?, ?)
      `).run(
        blocker.id,
        "Execute summary.",
        JSON.stringify(artifact),
        JSON.stringify({ files: 1, added_lines: 4, removed_lines: 1, pending_files: 0, unavailable_count: 0, run_count: 1 }),
        JSON.stringify(["src/blocker.js"]),
      );
      db.prepare("INSERT INTO agent_logs (id, task_run_id, events, status, created_at) VALUES ('log-blocker-exec', 'run-blocker-exec', ?, 'complete', 2000)")
        .run(JSON.stringify([{ type: "final", text: "Implemented blocker output.", numTurns: 2, durationMs: 1200 }]));
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status, decision, summary)
        VALUES ('run-blocker-review', ?, 'review', 'review', 'owner', 3000, 4000, 'complete', 'succeeded', 'approve', 'Approved blocker.')
      `).run(blocker.id);

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-dependent",
        mode: "execute",
      });

      expect(input.systemPrompt).toContain("## Resolved blocker context");
      expect(input.systemPrompt).toContain("### T-1: Blocker task");
      expect(input.systemPrompt).toContain("Latest execute run: `run-blocker-exec`");
      expect(input.systemPrompt).toContain("Implemented blocker output.");
      expect(input.systemPrompt).toContain("Artifacts: 1 file, +4 -1 across 1 run.");
      expect(input.systemPrompt).toContain("`src/blocker.js`");
      expect(input.systemPrompt).toContain("`run-blocker-exec` (T-1 blocker execute by owner, complete)");
      expect(input.systemPrompt).not.toContain("Approved blocker.");
      expect(input.promptDiagnostics.resolvedBlockers).toBe(1);
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
        now,
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
      expect(input.qaOutputDir).toBe("/tmp/project-atlas/.worklab-tmp/artifacts/run-project");
      const projectStart = input.systemPrompt.indexOf("## Project");
      const taskStart = input.systemPrompt.indexOf("## Task");
      expect(projectStart).toBeGreaterThan(0);
      expect(projectStart).toBeLessThan(taskStart);
      expect(input.systemPrompt).toContain("Use the Project Atlas conventions.");
      expect(input.systemPrompt).toContain("**Workdir:** `/tmp/project-atlas`");
      expect(input.systemPrompt).toContain("Tool working directory: `/tmp/project-atlas`");
      expect(input.systemPrompt).toContain("rather than `/tmp`");
      expect(input.systemPrompt).toContain("Worklab project workdirs may be plain directories, not Git repositories.");
      expect(input.systemPrompt).toContain("Check that Git is available before using Git-only workflows.");
      expect(input.systemPrompt).toContain("Temporary QA artifact directory: `/tmp/project-atlas/.worklab-tmp/artifacts/run-project`");
      expect(input.systemPrompt).toContain("WORKLAB_QA_OUTPUT_DIR");
      expect(input.promptDiagnostics.project).toMatchObject({
        id: project.id,
        slug: project.slug,
        workdir: "/tmp/project-atlas",
      });
    });
  });

  it("injects repository instructions from the project workdir", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const workdir = join(config.dataDir, "repo-with-agents");
      mkdirSync(workdir, { recursive: true });
      writeFileSync(join(workdir, "AGENTS.md"), [
        "# Repository Guidelines",
        "",
        "Respect the project AGENTS.md context before editing.",
        "Keep commits granular and intentional.",
      ].join("\n"));
      const project = seedProject(db, { workdir });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-repo-instructions",
        mode: "execute",
      });

      const repoInstructionsStart = input.systemPrompt.indexOf("## Repository instructions");
      const projectStart = input.systemPrompt.indexOf("## Project");
      expect(repoInstructionsStart).toBeGreaterThan(0);
      expect(repoInstructionsStart).toBeLessThan(projectStart);
      expect(input.systemPrompt).toContain(`Source: \`${join(workdir, "AGENTS.md")}\``);
      expect(input.systemPrompt).toContain("Respect the project AGENTS.md context before editing.");
      expect(input.systemPrompt).toContain("Keep commits granular and intentional.");
      expect(input.systemPrompt).toContain("## Repository workflow");
      expect(input.systemPrompt).toContain("If this workdir is not a Git repository, report changed paths and verification instead of forcing Git commits.");
      expect(input.systemPrompt).toContain("create granular commits before returning the final result");
      expect(input.promptDiagnostics.repositoryInstructions).toMatchObject({
        path: join(workdir, "AGENTS.md"),
      });
    });
  });

  it("prefers CLAUDE.md over AGENTS.md when both exist", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const workdir = join(config.dataDir, "repo-with-both");
      mkdirSync(workdir, { recursive: true });
      writeFileSync(join(workdir, "AGENTS.md"), "agents-md-only content");
      writeFileSync(join(workdir, "CLAUDE.md"), "claude-md-content wins");
      const project = seedProject(db, { workdir });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });
      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-claude-md",
        mode: "execute",
      });
      expect(input.systemPrompt).toContain(`Source: \`${join(workdir, "CLAUDE.md")}\``);
      expect(input.systemPrompt).toContain("claude-md-content wins");
      expect(input.systemPrompt).not.toContain("agents-md-only content");
    });
  });

  it("refreshes cached prompts when repository instructions change", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const workdir = join(config.dataDir, "repo-cache");
      mkdirSync(workdir, { recursive: true });
      const agentsPath = join(workdir, "AGENTS.md");
      writeFileSync(agentsPath, "Initial repository instruction.");
      const project = seedProject(db, { workdir });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });
      const contextCache = createContextCache();

      const first = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-repo-cache-1",
        mode: "execute",
        contextCache,
      });
      writeFileSync(agentsPath, "Updated repository instruction.");
      const second = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-repo-cache-2",
        mode: "execute",
        contextCache,
      });

      expect(first.systemPrompt).toContain("Initial repository instruction.");
      expect(second.systemPrompt).toContain("Updated repository instruction.");
      expect(second.systemPrompt).not.toContain("Initial repository instruction.");
      expect(second.promptDiagnostics.contextCacheHit).toBe(false);
    });
  });

  it("passes run artifact env and cwd through stdio MCP servers", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const project = seedProject(db, { workdir: "/tmp/project-mcp" });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });
      mkdirSync(join(config.dataDir, "config"), { recursive: true });
      writeFileSync(join(config.dataDir, "config", "mcp.json"), JSON.stringify({
        mcpServers: {
          playwright: { command: process.execPath, args: ["mock-playwright"], cwd: "." },
        },
      }));

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-mcp",
        mode: "execute",
      });

      expect(input.mcpServers.playwright.cwd).toBe(".");
      expect(input.mcpServers.playwright.env).toMatchObject({
        WORKLAB_RUN_ID: "run-mcp",
        WORKLAB_WORKSPACE: "/tmp/project-mcp",
        WORKLAB_QA_OUTPUT_DIR: "/tmp/project-mcp/.worklab-tmp/artifacts/run-mcp",
        PLAYWRIGHT_MCP_OUTPUT_DIR: "/tmp/project-mcp/.worklab-tmp/artifacts/run-mcp",
      });
    });
  });

  it("suppresses known browser MCP servers and skills only during execute when browser tools are review-only", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      db.prepare("UPDATE agents SET browser_tools_review_only = 1 WHERE name = 'owner'").run();
      mkdirSync(join(config.dataDir, "skills", "browser-use"), { recursive: true });
      writeFileSync(join(config.dataDir, "skills", "browser-use", "SKILL.md"), `---
name: browser-use
display_name: Browser Use
trigger: Use Browser Use or Playwright for visual app checks.
---
Browser skill body that mentions Playwright.
`);
      mkdirSync(join(config.dataDir, "skills", "frontend"), { recursive: true });
      writeFileSync(join(config.dataDir, "skills", "frontend", "SKILL.md"), `---
name: frontend
display_name: Frontend
trigger: Implement UI changes.
---
Frontend skill body.
`);
      mkdirSync(join(config.dataDir, "config"), { recursive: true });
      writeFileSync(join(config.dataDir, "config", "mcp.json"), JSON.stringify({
        mcpServers: {
          playwright: { command: "/bin/sh" },
          "external-mcp": { command: "/bin/sh" },
        },
      }));
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
        VALUES ('run-exec-prior', ?, 'execute', 'execute', 'owner', 1000, 2000, 'complete', 'succeeded')
      `).run(task.id);

      const execute = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-execute-browser-filtered",
        mode: "execute",
      });
      const review = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-review-browser-available",
        mode: "review",
        priorRunId: "run-exec-prior",
      });

      expect(execute.skills.map((skill) => skill.name)).toEqual(["frontend"]);
      expect(Object.keys(execute.mcpServers)).toEqual(expect.arrayContaining(["worklab", "external-mcp"]));
      expect(execute.mcpServers).not.toHaveProperty("playwright");
      expect(execute.skillDirs).toEqual([join(config.dataDir, "skills", "frontend")]);
      expect(execute.systemPrompt).toContain("frontend");
      expect(execute.systemPrompt).not.toContain("browser-use");
      expect(execute.systemPrompt).not.toContain("Browser skill body");
      expect(execute.systemPrompt).not.toContain("Other MCP servers connected: external-mcp, playwright");

      expect(review.skills.map((skill) => skill.name).sort()).toEqual(["browser-use", "frontend"]);
      expect(review.mcpServers).toHaveProperty("playwright");
      expect(review.systemPrompt).toContain("browser-use");
      expect(review.systemPrompt).toContain("Playwright");
      expect(review.skillDirs).toBeUndefined();
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

  it("uses spawn-time worktree metadata snapshots recorded on task_runs", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const project = seedProject(db, { workdir: "/tmp/source-project" });
      const task = seedTask(db, { stage: "execute", owner_agent: "owner", project_id: project.id });
      const worktree = {
        mode: "worktree",
        status: "created",
        branch: "worklab/run/run-worktree",
        source_workdir: "/tmp/source-project",
        source_git_root: "/tmp/source-project",
        source_head: "abc123",
        worktree_root: "/tmp/worklab-data/runs/run-worktree/worktree",
        runtime_workdir: "/tmp/worklab-data/runs/run-worktree/worktree",
        relative_workdir: "",
      };
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, project_id, mode, stage, agent_name, started_at, status, process_status,
           workdir, project_context_hash, workspace_mode, source_workdir, worktree_json)
        VALUES ('run-worktree', ?, ?, 'execute', 'execute', 'owner', 1000, 'running', 'running',
          ?, 'snap-hash', 'worktree', ?, ?)
      `).run(task.id, project.id, worktree.runtime_workdir, worktree.source_workdir, JSON.stringify(worktree));

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-worktree",
        mode: "execute",
      });

      expect(input.effectiveWorkdir).toBe(worktree.runtime_workdir);
      expect(input.workspaceMode).toBe("worktree");
      expect(input.sourceWorkdir).toBe(worktree.source_workdir);
      expect(input.worktree).toMatchObject({
        branch: "worklab/run/run-worktree",
        runtime_workdir: worktree.runtime_workdir,
      });
      expect(input.systemPrompt).toContain("Workspace mode: `worktree`");
      expect(input.systemPrompt).toContain("Source checkout: `/tmp/source-project`");
      expect(input.systemPrompt).toContain("AI worktree branch: `worklab/run/run-worktree`");
    });
  });

  it("loads prior worktree conflict metadata for retry prompts", () => {
    withRunInputDb(({ db }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status,
           worktree_json, diagnostics_json)
        VALUES ('run-conflict', ?, 'execute', 'execute', 'owner', 1000, 2000, 'complete', 'succeeded', ?, ?)
      `).run(
        task.id,
        JSON.stringify({
          status: "merge_conflict",
          branch: "worklab/run/run-conflict",
          branch_head: "aaa111122223333",
        }),
        JSON.stringify({
          worktree: {
            status: "merge_conflict",
            conflict_paths: ["src/screens/JournalDetailScreen.tsx"],
            branch_head: "aaa111122223333",
            source_head_before: "bbb222233334444",
          },
          worktree_conflict_retry: {
            retry_run_id: "run-retry",
          },
        }),
      );
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status)
        VALUES ('run-current', ?, 'execute', 'execute', 'owner', 3000, 'running', 'running')
      `).run(task.id);

      const priorRuns = loadPriorRunSummaries(db, task.id, "run-current", 4);

      expect(priorRuns[0].worktree).toMatchObject({
        status: "merge_conflict",
        branch: "worklab/run/run-conflict",
        branchHead: "aaa111122223333",
        sourceHead: "bbb222233334444",
        conflictPaths: ["src/screens/JournalDetailScreen.tsx"],
        retryRunId: "run-retry",
      });
    });
  });

  it("injects worktree conflict retry diagnostics into the retry run prompt", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Execute as owner.");
      const task = seedTask(db, { stage: "execute", owner_agent: "owner" });
      db.prepare(`
        INSERT INTO task_runs
          (id, task_id, mode, stage, agent_name, started_at, status, process_status, diagnostics_json)
        VALUES ('run-retry', ?, 'execute', 'execute', 'owner', 3000, 'running', 'running', ?)
      `).run(task.id, JSON.stringify({
        worktree_conflict_retry: true,
        worktree_conflict_retry_of_run_id: "run-conflict",
        previous_branch: "worklab/run/run-conflict",
        previous_branch_head: "aaa111122223333",
        source_head: "bbb222233334444",
        conflict_paths: ["src/screens/JournalDetailScreen.tsx"],
        guidance: "Treat the source checkout as authoritative and reapply only task-owned intent.",
      }));

      const input = buildTaskRunInput({
        db,
        config,
        taskId: task.id,
        agentName: "owner",
        runId: "run-retry",
        mode: "execute",
      });

      expect(input.systemPrompt).toContain("## Resume context");
      expect(input.systemPrompt).toContain("Worktree conflict retry");
      expect(input.systemPrompt).toContain("Previous run: `run-conflict`");
      expect(input.systemPrompt).toContain("Previous AI branch: `worklab/run/run-conflict`");
      expect(input.systemPrompt).toContain("Conflict paths: `src/screens/JournalDetailScreen.tsx`");
      expect(input.systemPrompt).toContain("source checkout as authoritative");
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
        now,
      });

      expect(preview.agent_name).toBe("planner");
      expect(preview.system_prompt).toBe(input.systemPrompt);
      expect(preview.system_prompt).toContain("Plan as specialist.");
      expect(preview.system_prompt).not.toContain("Own the work.");
    });
  });

  it("adds planning harness diagnostics and read-only plan tools to plan previews", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Own the task.");
      seedAgent(db, "planner", "Plan as specialist.");
      const task = seedTask(db, { stage: "plan", owner_agent: "owner", planner_agent: "planner" });
      writeSettings(db, {
        planning_harness: "numbered_steps",
        planning_tool_policy: "read_only_no_shell",
      });

      const preview = buildNextTaskRunPreview({ db, config, taskId: task.id, now: 98765 });

      expect(preview.input.metadata).toMatchObject({
        planning_harness: "numbered_steps",
        planning_tool_policy: "read_only_no_shell",
      });
      expect(preview.system_prompt).toContain("Harness: numbered steps");
      expect(preview.system_prompt).toContain("Forbidden during planning: Write, Edit, and Bash");
      expect(preview.input.diagnostics.planning).toMatchObject({
        harness: "numbered_steps",
        tool_policy: "read_only_no_shell",
        enforceable: true,
      });
    });
  });

  it("includes planning harness settings in prompt cache signatures", () => {
    withRunInputDb(({ db, config }) => {
      seedAgent(db, "owner", "Own the task.");
      seedAgent(db, "planner", "Plan as specialist.");
      seedTask(db, { stage: "plan", owner_agent: "owner", planner_agent: "planner" });
      const cache = createContextCache();

      writeSettings(db, { planning_harness: "fast_handoff" });
      const first = buildTaskRunInput({
        db,
        config,
        taskId: "task-1",
        agentName: "planner",
        runId: "run-first",
        mode: "plan",
        contextCache: cache,
      });

      writeSettings(db, { planning_harness: "execplan_deep" });
      const second = buildTaskRunInput({
        db,
        config,
        taskId: "task-1",
        agentName: "planner",
        runId: "run-second",
        mode: "plan",
        contextCache: cache,
      });

      expect(first.systemPrompt).toContain("Harness: fast handoff");
      expect(second.systemPrompt).toContain("Harness: ExecPlan deep");
      expect(second.promptDiagnostics.contextCacheHit).toBe(false);
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
        now,
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
