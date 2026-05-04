import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { writeSettings } from "../../core/settings.js";
import { slackMessageFilterReason } from "../../integrations/slack/filter.js";
import { parseTriageResult } from "../../integrations/slack/triage-result.js";
import { createWorklabSlackService } from "../../integrations/slack/service.js";
import { buildTriageSystemPrompt } from "../../integrations/slack/context.js";

function makeConfig(dataDir) {
  return {
    host: "127.0.0.1",
    port: 7878,
    dataDir,
    workspace: dataDir,
    repoRoot: process.cwd(),
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
  };
}

function fakeSlackApp() {
  const handlers = {};
  const client = {
    auth: { test: vi.fn(async () => ({ ok: true, user_id: "UBOT" })) },
    assistant: { threads: { setStatus: vi.fn(async () => ({ ok: true })) } },
    conversations: { open: vi.fn(async () => ({ ok: true, channel: { id: "DROBERT" } })) },
    chat: { postMessage: vi.fn(async (params) => ({ ok: true, channel: params.channel, ts: "999.0001" })) },
  };
  const app = {
    client,
    handlers,
    event: vi.fn((name, handler) => { handlers[name] = handler; }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  return app;
}

const triageJson = JSON.stringify({
  schema: "worklab.slack.triage.v1",
  importance: "normal",
  summary: "Needs a reply.",
  should_reply: true,
  reply_text: "I will check.",
  notify_user: false,
  user_message: "",
  journal_bullets: ["Robert was asked to check something."],
  memory_facts: ["Slack triage test fact."],
  action_items: ["Check the request"],
});

describe("slack integration", () => {
  const dirs = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function setupService({ runAgent } = {}) {
    const db = makeTestDb();
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-slack-test-"));
    dirs.push(dataDir);
    writeSettings(db, {
      slack_enabled: true,
      slack_user_id: "UROBERT",
      slack_agent_name: "assistant",
      slack_model: "pi:openai-codex:gpt-5.5",
      slack_effort: "xhigh",
      slack_channel_ids: [],
    });
    const app = fakeSlackApp();
    const service = createWorklabSlackService({
      db,
      config: makeConfig(dataDir),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      appFactory: () => app,
      runAgent: runAgent || vi.fn(async (_systemPrompt, options) => {
        options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
        return {
          text: triageJson,
          events: [],
          usage: { input_tokens: 10, output_tokens: 5 },
          durationMs: 25,
          numTurns: 1,
        };
      }),
    });
    return { db, service, app };
  }

  it("filters Slack messages with optional channel allowlist and configured DM user", () => {
    expect(slackMessageFilterReason(
      { type: "message", channel: "C1", user: "U1", ts: "1", text: "hi" },
      { slackChannelIds: [] },
    )).toBeNull();
    expect(slackMessageFilterReason(
      { type: "message", channel: "C2", user: "U1", ts: "1", text: "hi" },
      { slackChannelIds: ["C1"] },
    )).toBe("channel_not_allowlisted");
    expect(slackMessageFilterReason(
      { type: "message", channel: "D1", channel_type: "im", user: "U2", ts: "1", text: "hi" },
      { slackUserId: "U1", slackChannelIds: ["C1"] },
    )).toBe("wrong_dm_user");
  });

  it("parses triage JSON and normalizes empty reply fields", () => {
    const parsed = parseTriageResult(JSON.stringify({
      schema: "worklab.slack.triage.v1",
      importance: "normal",
      summary: "FYI",
      should_reply: true,
      reply_text: "",
      notify_user: true,
      user_message: "",
      journal_bullets: ["  fact  "],
      memory_facts: [],
      action_items: [],
    }));
    expect(parsed.should_reply).toBe(false);
    expect(parsed.user_message).toBe("FYI");
    expect(parsed.journal_bullets).toEqual(["fact"]);
  });

  it("persists arriving messages, uses typing status, runs triage, and posts thread replies", async () => {
    const runAgent = vi.fn(async (_systemPrompt, options) => {
      expect(options.permissionMode).toBe("bypassPermissions");
      expect(options.allowedTools).toContain("Bash");
      expect(options.mcpServers.worklab).toBeTruthy();
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
      return { text: triageJson, events: [], usage: {}, durationMs: 1, numTurns: 1 };
    });
    const { db, service, app } = setupService({ runAgent });
    await service.start();

    const result = service.handleSlackMessage({
      event: { type: "message", channel: "C1", user: "U1", ts: "123.0001", text: "Can you check this?" },
      body: { event_id: "Ev1" },
    });
    expect(result.queued).toBe(true);
    await service.waitIdle();

    const inbound = db.prepare("SELECT * FROM slack_inbound_events").get();
    expect(inbound.status).toBe("succeeded");
    const run = db.prepare("SELECT * FROM slack_triage_runs").get();
    expect(run.status).toBe("succeeded");
    expect(app.client.assistant.threads.setStatus).toHaveBeenNthCalledWith(1, {
      channel_id: "C1",
      thread_ts: "123.0001",
      status: "is working on your request...",
    });
    expect(app.client.assistant.threads.setStatus).toHaveBeenNthCalledWith(2, {
      channel_id: "C1",
      thread_ts: "123.0001",
      status: "",
    });
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1",
      thread_ts: "123.0001",
      text: "I will check.",
    }));
  });

  it("sends task completion DMs once and ignores intermediate successful runs", async () => {
    const { db, service, app } = setupService();
    await service.start();
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, task_key, root_task_id, title, instructions, stage, owner_agent, created_at, updated_at)
      VALUES ('task-1', 'T-1', 'task-1', 'Done task', '', 'done', NULL, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status)
      VALUES ('run-1', 'task-1', 'execute', 'execute', 'coder', ?, ?, 'complete', 'succeeded')
    `).run(now - 10, now);

    await service.notifyTaskRunEnded({ type: "run_ended", runId: "run-1", taskId: "task-1", processStatus: "succeeded" });
    await service.notifyTaskRunEnded({ type: "run_ended", runId: "run-1", taskId: "task-1", processStatus: "succeeded" });

    expect(app.client.conversations.open).toHaveBeenCalledTimes(1);
    expect(app.client.chat.postMessage.mock.calls[0][0].text).toContain("Worklab task completed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM slack_delivery_log").get().count).toBe(1);

    db.prepare("UPDATE tasks SET stage = 'review' WHERE id = 'task-1'").run();
    await service.notifyTaskRunEnded({ type: "run_ended", runId: "run-2", taskId: "task-1", processStatus: "succeeded" });
    expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("sends task error DMs for failed runs", async () => {
    const { db, service, app } = setupService();
    await service.start();
    const now = Date.now();
    db.prepare(`
      INSERT INTO tasks (id, task_key, root_task_id, title, instructions, stage, owner_agent, error_text, created_at, updated_at)
      VALUES ('task-err', 'T-2', 'task-err', 'Broken task', '', 'execute', NULL, 'timeout', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status, error_text)
      VALUES ('run-err', 'task-err', 'execute', 'execute', 'coder', ?, ?, 'error', 'failed', 'timeout')
    `).run(now - 10, now);

    await service.notifyTaskRunEnded({
      type: "run_ended",
      runId: "run-err",
      taskId: "task-err",
      processStatus: "failed",
      errorText: "timeout",
    });

    expect(app.client.chat.postMessage.mock.calls[0][0].text).toContain("Worklab task needs attention");
    expect(app.client.chat.postMessage.mock.calls[0][0].text).toContain("timeout");
  });

  it("triage prompt teaches the agent to create tasks without instruction length targets", () => {
    const prompt = buildTriageSystemPrompt({
      agentName: "Assistant",
      memory: "",
      journalTail: "",
      input: { type: "message", text: "fix login plz" },
      skills: [],
      now: new Date("2026-05-04T00:00:00Z"),
    });
    expect(prompt).toContain("worklab_task_create");
    expect(prompt).toContain("instructions: optional context");
    expect(prompt).toContain("Slack thread link / message ts");
    expect(prompt).not.toContain("80 chars");
    expect(prompt).not.toContain("acceptance criteria");
    expect(prompt).toMatch(/genuinely a one-line note/);
  });
});
