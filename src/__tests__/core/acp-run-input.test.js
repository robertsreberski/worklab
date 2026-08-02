import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildTaskRunInput } from "../../core/run-input.js";
import { WORKLAB_RESULT_JSON_SCHEMA } from "../../core/worklab-result/contract.js";
import { appendJournalEntry, writeMemory } from "../../core/journal.js";
import { recordAgentMemoryCandidates } from "../../core/agent-learning.js";
import { kbCreate } from "../../core/kb.js";
import { makeTestDb } from "../helpers/test-db.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_PROFILE_ID = "22222222-2222-4222-8222-222222222222";

function withFixture(fn) {
  const dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-run-input-data-"));
  const workspace = mkdtempSync(join(tmpdir(), "worklab-acp-run-input-workspace-"));
  const db = makeTestDb();
  const config = { dataDir, repoRoot: workspace, workspace, timezone: "UTC" };
  try {
    return fn({ db, config, dataDir, workspace });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

function seedAgent(db, {
  name,
  profileId = null,
  instructions = "",
  description = "",
  sdk = profileId ? "acp" : "claude",
  model = profileId ? `acp:${profileId}` : "claude:claude-sonnet-4-6",
} = {}) {
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT INTO agents
      (name, display_name, description, sdk, model, effort, instructions,
       execution_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?, ?)
  `).run(name, name, description, sdk, model, instructions, profileId ? "acp" : "sdk", now, now);
}

function seedAcpProfile(db, {
  id,
  agentName,
  driver = "generic",
  configurationOwner = "agent",
  workspace,
} = {}) {
  const mono = driver === "mono";
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT INTO acp_profiles
      (id, agent_name, driver, command, args_json, cwd, env_keys_json,
       mono_source_id, mono_source_json, configuration_owner, workspace_owner,
       mcp_owner, canonical_workspace, permissions_policy_json, config_policy_json,
       session_policy_json, probe_timeout_ms, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', ?, '[]', ?, ?, ?, ?, ?, ?, '{}', '{}', '{}', 30000, ?, ?)
  `).run(
    id,
    agentName,
    driver,
    process.execPath,
    workspace,
    mono ? `mono:${agentName}` : null,
    mono ? JSON.stringify({ sourceId: `mono:${agentName}`, label: agentName }) : "{}",
    configurationOwner,
    mono ? "agent" : "client",
    mono ? "agent" : "client",
    mono ? workspace : null,
    now,
    now,
  );
}

function seedProjectAndTask(db, workspace, {
  taskId = "task-acp",
  agentName = "external-owner",
  stage = "execute",
  reviewerAgent = null,
} = {}) {
  const now = 1_700_000_000_000;
  db.prepare(`
    INSERT INTO projects
      (id, slug, name, description, context_markdown, workdir, created_at, updated_at)
    VALUES ('project-acp', 'project-acp', 'ACP Project', 'PROJECT_DESCRIPTION_SECRET',
            'PROJECT_CONTEXT_SECRET', ?, ?, ?)
  `).run(workspace, now, now);
  db.prepare(`
    INSERT INTO tasks
      (id, task_key, root_task_id, project_id, title, instructions, stage, stage_reason,
       owner_agent, reviewer_agent, plan_body, plan_updated_at, plan_updated_by,
       created_at, updated_at)
    VALUES (?, 'ACP-1', ?, 'project-acp', 'TASK_TITLE_ALLOWED', 'TASK_INSTRUCTIONS_ALLOWED',
            ?, 'TASK_STAGE_REASON_ALLOWED', ?, ?, 'SAVED_PLAN_ALLOWED', ?, 'planner', ?, ?)
  `).run(taskId, taskId, stage, agentName, reviewerAgent, now - 100, now, now);
  return taskId;
}

function insertRun({
  db,
  id,
  taskId,
  agentName,
  mode = "execute",
  stage = mode,
  startedAt,
  endedAt = null,
  status = endedAt ? "complete" : "running",
  processStatus = endedAt ? "succeeded" : "running",
  diagnostics = {},
  result = null,
  artifacts = [],
  projectId = "project-acp",
  workdir = null,
} = {}) {
  const summary = artifacts.length
    ? { files: artifacts.length, added_lines: 3, removed_lines: 1, run_count: 1 }
    : {};
  db.prepare(`
    INSERT INTO task_runs
      (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status,
       diagnostics_json, result_json, artifacts_json, artifact_summary_json, artifact_paths_json,
       project_id, workdir)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId,
    mode,
    stage,
    agentName,
    startedAt,
    endedAt,
    status,
    processStatus,
    JSON.stringify(diagnostics),
    result ? JSON.stringify(result) : null,
    JSON.stringify(artifacts),
    JSON.stringify(summary),
    JSON.stringify(artifacts.map((artifact) => artifact.path)),
    projectId,
    workdir,
  );
}

function promptText(input) {
  return input.messages[0].content.find((block) => block.type === "text")?.text || "";
}

describe("agent-owned ACP run input", () => {
  it("sends only task-owned context and local resource links to Mono", () => {
    withFixture(({ db, config, dataDir, workspace }) => {
      seedAgent(db, {
        name: "external-owner",
        profileId: PROFILE_ID,
        instructions: "AGENT_PERSONA_SECRET",
        description: "AGENT_DESCRIPTION_SECRET",
      });
      seedAgent(db, { name: "helper", description: "DELEGATION_ROSTER_SECRET" });
      seedAcpProfile(db, {
        id: PROFILE_ID,
        agentName: "external-owner",
        driver: "mono",
        workspace,
      });
      const taskId = seedProjectAndTask(db, workspace);
      const priorArtifact = [{
        path: "src/prior-change.js",
        display_path: "src/prior-change.js",
        kind: "update",
        status: "completed",
        added_lines: 3,
        removed_lines: 1,
        has_line_delta: true,
        run_ids: ["run-prior"],
        last_run_id: "run-prior",
        first_seen_at: 1_500,
        last_seen_at: 2_000,
      }];
      insertRun({
        db,
        id: "run-prior",
        taskId,
        agentName: "external-owner",
        startedAt: 1_000,
        endedAt: 2_000,
        artifacts: priorArtifact,
      });
      db.prepare(`
        INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
        VALUES ('log-prior', 'run-prior', ?, 'complete', 2000)
      `).run(JSON.stringify([{ type: "final", text: "PRIOR_OUTCOME_ALLOWED", numTurns: 1, durationMs: 100 }]));
      insertRun({
        db,
        id: "run-current",
        taskId,
        agentName: "external-owner",
        startedAt: 3_000,
        diagnostics: {
          resume_snapshot: {
            schema: "worklab.transcript-tail.v1",
            turns: [{ assistant_text: "RESUME_CONTEXT_SECRET" }],
          },
          webhook: { body_preview: "WEBHOOK_PAYLOAD_SECRET" },
        },
      });

      db.prepare(`
        INSERT INTO task_comments (id, task_id, author_type, body, created_at)
        VALUES
          ('comment-history', ?, 'human', 'HISTORICAL_COMMENT_ALLOWED', 1500),
          ('comment-current', ?, 'human', 'CURRENT_COMMENT_ALLOWED', 3000)
      `).run(taskId, taskId);

      const pathAttachment = join(workspace, "docs", "brief.md");
      mkdirSync(join(workspace, "docs"), { recursive: true });
      writeFileSync(pathAttachment, "ATTACHMENT_FILE_BYTES_SECRET");
      const storedPath = "attachments/tasks/task-acp/comment-image.png";
      const uploadPath = join(dataDir, storedPath);
      mkdirSync(join(dataDir, "attachments", "tasks", "task-acp"), { recursive: true });
      writeFileSync(uploadPath, "UPLOADED_FILE_BYTES_SECRET");
      db.prepare(`
        INSERT INTO task_attachments
          (id, task_id, comment_id, owner_type, kind, source, label, path_text,
           absolute_path, filename, mime_type, size_bytes, stored_path, metadata_json, created_at)
        VALUES
          ('attachment-path', ?, NULL, 'task_instructions', 'path', 'path', 'Task brief',
           'docs/brief.md', ?, NULL, NULL, NULL, NULL, '{}', 3000),
          ('attachment-upload', ?, 'comment-current', 'comment', 'upload', 'pasted_image',
           'Review image', NULL, NULL, 'comment-image.png', 'image/png', 26, ?, '{}', 3000)
      `).run(taskId, pathAttachment, taskId, storedPath);

      writeMemory({ dataDir, agent: "external-owner", content: "MEMORY_CONTEXT_SECRET" });
      appendJournalEntry({
        dataDir,
        agent: "external-owner",
        runId: "run-prior",
        taskId,
        taskTitle: "Task",
        bullet: "JOURNAL_CONTEXT_SECRET",
      });
      recordAgentMemoryCandidates(db, {
        agentName: "external-owner",
        taskId,
        runId: "run-prior",
        autoApproveThreshold: 0.5,
        candidates: [{ kind: "procedure", content: "LEARNING_CONTEXT_SECRET", confidence: 1 }],
      });
      kbCreate({
        dataDir,
        slug: "private-pinned",
        title: "Private pinned",
        body: "PINNED_KB_SECRET",
        pinned: true,
        author: "human",
      });
      mkdirSync(join(dataDir, "skills", "private-skill"), { recursive: true });
      writeFileSync(join(dataDir, "skills", "private-skill", "SKILL.md"), [
        "---",
        "name: private-skill",
        "trigger: private",
        "---",
        "SKILL_BODY_SECRET",
      ].join("\n"));
      mkdirSync(join(dataDir, "config"), { recursive: true });
      writeFileSync(join(dataDir, "config", "mcp.json"), JSON.stringify({
        mcpServers: {
          private: { command: process.execPath, env: { PRIVATE_VALUE: "MCP_ENV_SECRET" } },
        },
      }));
      writeFileSync(join(workspace, "AGENTS.md"), "REPOSITORY_INSTRUCTIONS_SECRET");

      const input = buildTaskRunInput({
        db,
        config,
        taskId,
        agentName: "external-owner",
        runId: "run-current",
        mode: "execute",
        now: 3_000,
        worklabToolSurfaceMarkdown: "WORKLAB_TOOL_SURFACE_SECRET",
      });

      expect(input.acpProfile).toMatchObject({
        id: PROFILE_ID,
        driver: "mono",
        configurationOwner: "agent",
      });
      expect(input.systemPrompt).toBe("");
      expect(input.skills).toEqual([]);
      expect(input.skillDirs).toEqual([]);
      expect(input.mcpServers).toEqual({});
      expect(input.allowedTools).toEqual([]);
      expect(input.disallowedTools).toEqual([]);
      expect(input.delegation).toBeNull();
      expect(input.nativeSubagents).toBeNull();
      expect(input.repositoryInstructions).toBeNull();
      expect(input.memory).toBe("");
      expect(input.learningMemories).toEqual([]);
      expect(input.journalTail).toBe("");
      expect(input.pinnedKb).toEqual([]);
      expect(input.agent.instructions).toBe("");
      expect(input.project).toEqual({ id: "project-acp", slug: "project-acp", name: "ACP Project" });

      const body = promptText(input);
      expect(body).toContain("# Worklab task handoff");
      expect(body).toContain("Mode: execute");
      expect(body).toContain("Workflow stage: execute");
      expect(body).toContain(`Workspace: \`${workspace}\``);
      expect(body).toContain("Run started: 1970-01-01T00:00:03.000Z");
      expect(body).toContain("TASK_TITLE_ALLOWED");
      expect(body).toContain("TASK_INSTRUCTIONS_ALLOWED");
      expect(body).toContain("TASK_STAGE_REASON_ALLOWED");
      expect(body).toContain("CURRENT_COMMENT_ALLOWED");
      expect(body).toContain("HISTORICAL_COMMENT_ALLOWED");
      expect(body).toContain("SAVED_PLAN_ALLOWED");
      expect(body).toContain("PRIOR_OUTCOME_ALLOWED");
      expect(body).toContain("src/prior-change.js");
      expect(body).toContain('"schema": "worklab.v2"');
      expect(body).toContain('"artifact_entries": []');

      const links = input.messages[0].content.filter((block) => block.type === "resource_link");
      expect(links).toEqual([
        {
          type: "resource_link",
          uri: pathToFileURL(pathAttachment).href,
          name: "Task brief",
        },
        {
          type: "resource_link",
          uri: pathToFileURL(uploadPath).href,
          name: "Review image",
          mimeType: "image/png",
          size: 26,
        },
      ]);

      const contractJson = body.match(/```json\n([\s\S]*?)\n```/)?.[1];
      const contractExample = JSON.parse(contractJson);
      for (const field of WORKLAB_RESULT_JSON_SCHEMA.required) {
        expect(contractExample).toHaveProperty(field);
      }

      const serialized = JSON.stringify(input);
      for (const forbidden of [
        "AGENT_PERSONA_SECRET",
        "AGENT_DESCRIPTION_SECRET",
        "PROJECT_DESCRIPTION_SECRET",
        "PROJECT_CONTEXT_SECRET",
        "DELEGATION_ROSTER_SECRET",
        "MEMORY_CONTEXT_SECRET",
        "JOURNAL_CONTEXT_SECRET",
        "LEARNING_CONTEXT_SECRET",
        "PINNED_KB_SECRET",
        "SKILL_BODY_SECRET",
        "MCP_ENV_SECRET",
        "REPOSITORY_INSTRUCTIONS_SECRET",
        "WORKLAB_TOOL_SURFACE_SECRET",
        "RESUME_CONTEXT_SECRET",
        "WEBHOOK_PAYLOAD_SECRET",
        "ATTACHMENT_FILE_BYTES_SECRET",
        "UPLOADED_FILE_BYTES_SECRET",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });

  it("passes the owner outcome and structured verification evidence to an agent-owned reviewer", () => {
    withFixture(({ db, config, workspace }) => {
      seedAgent(db, { name: "owner" });
      seedAgent(db, {
        name: "external-reviewer",
        profileId: REVIEW_PROFILE_ID,
        instructions: "REVIEWER_PERSONA_SECRET",
      });
      seedAcpProfile(db, {
        id: REVIEW_PROFILE_ID,
        agentName: "external-reviewer",
        configurationOwner: "agent",
        workspace,
      });
      const taskId = seedProjectAndTask(db, workspace, {
        taskId: "task-review",
        agentName: "owner",
        reviewerAgent: "external-reviewer",
        stage: "review",
      });
      insertRun({
        db,
        id: "run-owner",
        taskId,
        agentName: "owner",
        startedAt: 1_000,
        endedAt: 2_000,
        result: {
          schema: "worklab.v2",
          stage: "execute",
          decision: "advance",
          summary: "OWNER_SUMMARY_ALLOWED",
          verification_evidence: [{
            kind: "test",
            command_or_url: "npm test -- focused",
            exit_code_or_status: "exit 0",
            snippet: "FOCUSED_TEST_EVIDENCE_ALLOWED",
            reason: "",
          }],
        },
      });
      db.prepare(`
        INSERT INTO agent_logs (id, task_run_id, events, status, created_at)
        VALUES ('log-owner', 'run-owner', ?, 'complete', 2000)
      `).run(JSON.stringify([
        { type: "tool_result", content: "RAW_TOOL_EVENT_SECRET" },
        { type: "final", text: "OWNER_FINAL_OUTPUT_ALLOWED", numTurns: 2, durationMs: 500 },
      ]));
      insertRun({
        db,
        id: "run-review",
        taskId,
        agentName: "external-reviewer",
        mode: "review",
        stage: "review",
        startedAt: 3_000,
      });

      const input = buildTaskRunInput({
        db,
        config,
        taskId,
        agentName: "external-reviewer",
        runId: "run-review",
        mode: "review",
        priorRunId: "run-owner",
      });

      const body = promptText(input);
      expect(input.systemPrompt).toBe("");
      expect(body).toContain("## Current review evidence");
      expect(body).toContain("Owner run: `run-owner`");
      expect(body).toContain("OWNER_SUMMARY_ALLOWED");
      expect(body).toContain("OWNER_FINAL_OUTPUT_ALLOWED");
      expect(body).toContain("npm test -- focused");
      expect(body).toContain("exit 0");
      expect(body).toContain("FOCUSED_TEST_EVIDENCE_ALLOWED");
      expect(body).toContain("Allowed decision values for this review run: approve or reject.");
      expect(body).toContain('"stage": "review"');
      expect(input.priorEvents).toEqual([]);
      expect(input.execution).not.toHaveProperty("events");
      expect(JSON.stringify(input)).not.toContain("RAW_TOOL_EVENT_SECRET");
      expect(JSON.stringify(input)).not.toContain("REVIEWER_PERSONA_SECRET");
    });
  });

  it("keeps normal Worklab configuration semantics for client-owned ACP profiles", () => {
    withFixture(({ db, config, workspace }) => {
      seedAgent(db, {
        name: "client-owned",
        profileId: PROFILE_ID,
        instructions: "CLIENT_OWNED_PERSONA_VISIBLE",
      });
      seedAcpProfile(db, {
        id: PROFILE_ID,
        agentName: "client-owned",
        configurationOwner: "client",
        workspace,
      });
      const taskId = seedProjectAndTask(db, workspace, { agentName: "client-owned" });
      insertRun({
        db,
        id: "run-client-owned",
        taskId,
        agentName: "client-owned",
        startedAt: 3_000,
      });

      const input = buildTaskRunInput({
        db,
        config,
        taskId,
        agentName: "client-owned",
        runId: "run-client-owned",
        mode: "execute",
      });

      expect(input.systemPrompt).toContain("CLIENT_OWNED_PERSONA_VISIBLE");
      expect(input.systemPrompt).toContain("PROJECT_CONTEXT_SECRET");
      expect(typeof input.messages[0].content).toBe("string");
      expect(input.promptDiagnostics.acp).toBeUndefined();
    });
  });
});
