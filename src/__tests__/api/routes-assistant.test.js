import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { writeSettings } from "../../core/settings.js";
import { DEFAULT_ASSISTANT_THREAD_ID } from "../../core/index.js";

function makeConfig(dataDir) {
  return {
    host: "127.0.0.1",
    port: 7878,
    dataDir,
    workspace: dataDir,
    repoRoot: process.cwd(),
  };
}

function assistantJson(overrides = {}) {
  return JSON.stringify({
    schema: "worklab.assistant.v1",
    reply_text: "Created the task.",
    summary: "Created a Worklab task.",
    journal_bullets: ["Robert asked the assistant to create a task."],
    memory_facts: ["Robert uses the in-app assistant for Worklab administration."],
    action_items: ["Review the new task"],
    ...overrides,
  });
}

function seedAssistantMessages(db, count, { start = Date.now() } = {}) {
  db.prepare(`
    INSERT OR IGNORE INTO assistant_threads (id, title, created_at, updated_at)
    VALUES (?, 'Personal assistant', ?, ?)
  `).run(DEFAULT_ASSISTANT_THREAD_ID, start, start);
  const insert = db.prepare(`
    INSERT INTO assistant_messages (id, thread_id, role, body, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'complete', ?, ?)
  `);
  return Array.from({ length: count }, (_, index) => {
    const messageNumber = index + 1;
    const id = `assistant-test-message-${messageNumber}`;
    const createdAt = start + messageNumber;
    insert.run(
      id,
      DEFAULT_ASSISTANT_THREAD_ID,
      messageNumber % 2 === 0 ? "assistant" : "user",
      `Message ${messageNumber}`,
      createdAt,
      createdAt,
    );
    return id;
  });
}

function seedActiveAssistantRun(db, { start = Date.now() } = {}) {
  db.prepare(`
    INSERT OR IGNORE INTO assistant_threads (id, title, created_at, updated_at)
    VALUES (?, 'Personal assistant', ?, ?)
  `).run(DEFAULT_ASSISTANT_THREAD_ID, start, start);
  const userId = "assistant-active-user";
  const assistantId = "assistant-active-reply";
  const runId = "assistant-active-run";
  db.prepare(`
    INSERT INTO assistant_messages (id, thread_id, role, body, status, created_at, updated_at)
    VALUES (?, ?, 'user', 'Current request', 'complete', ?, ?)
  `).run(userId, DEFAULT_ASSISTANT_THREAD_ID, start + 1, start + 1);
  db.prepare(`
    INSERT INTO assistant_messages (id, thread_id, role, body, status, run_id, created_at, updated_at)
    VALUES (?, ?, 'assistant', '', 'running', ?, ?, ?)
  `).run(assistantId, DEFAULT_ASSISTANT_THREAD_ID, runId, start + 2, start + 2);
  db.prepare(`
    INSERT INTO assistant_runs
      (id, thread_id, user_message_id, assistant_message_id, status, started_at)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(runId, DEFAULT_ASSISTANT_THREAD_ID, userId, assistantId, start + 1);
  return { userId, assistantId, runId };
}

describe("assistant routes", () => {
  const dirs = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function setup({ runAgent } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-assistant-test-"));
    dirs.push(dataDir);
    const server = makeTestServer({
      dataDir,
      config: makeConfig(dataDir),
      assistant: {
        runAgent: runAgent || vi.fn(async (_systemPrompt, options) => {
          options.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "Checking Worklab." }] } });
          options.onEvent?.({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "worklab_task_create", input: { title: "Demo" } }] } });
          options.onEvent?.({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"ok\":true}" }] } });
          return {
            text: assistantJson(),
            events: [],
            usage: { input_tokens: 20, output_tokens: 10, cost_usd: 0.001 },
            durationMs: 42,
            numTurns: 2,
            model: "openai:gpt-5.5",
            effort: "high",
          };
        }),
      },
    });
    writeSettings(server.db, {
      slack_agent_name: "mickey",
      assistant_model: "openai:gpt-5.5",
      assistant_effort: "high",
      assistant_run_timeout_ms: 60000,
    });
    return { ...server, dataDir };
  }

  it("returns the default personal assistant thread", async () => {
    const { agent } = setup();
    const res = await agent.get("/api/assistant").expect(200);
    expect(res.body.thread.id).toBe("personal");
    expect(res.body.messages).toEqual([]);
    expect(res.body.active_run).toBeNull();
  });

  it("returns a blank assistant thread view with history metadata", async () => {
    const { agent, db } = setup();
    seedAssistantMessages(db, 7);

    const res = await agent.get("/api/assistant?view=blank").expect(200);

    expect(res.body.thread.id).toBe("personal");
    expect(res.body.messages).toEqual([]);
    expect(res.body.active_run).toBeNull();
    expect(res.body.history).toMatchObject({ has_more: true, before: null, page_size: 5 });
  });

  it("paginates assistant history by five previous messages", async () => {
    const { agent, db } = setup();
    const ids = seedAssistantMessages(db, 7);

    const first = await agent.get("/api/assistant/messages?limit=5").expect(200);
    expect(first.body.messages.map((message) => message.id)).toEqual(ids.slice(2, 7));
    expect(first.body.history).toMatchObject({ has_more: true, next_before: ids[2], page_size: 5 });

    const second = await agent.get(`/api/assistant/messages?limit=5&before=${ids[2]}`).expect(200);
    expect(second.body.messages.map((message) => message.id)).toEqual(ids.slice(0, 2));
    expect(second.body.history).toMatchObject({ has_more: false, next_before: ids[0], page_size: 5 });
  });

  it("keeps the current active assistant exchange visible in blank view", async () => {
    const { agent, db } = setup();
    const olderIds = seedAssistantMessages(db, 4, { start: Date.now() });
    const active = seedActiveAssistantRun(db, { start: Date.now() + 100 });

    const res = await agent.get("/api/assistant?view=blank").expect(200);
    expect(res.body.messages.map((message) => message.id)).toEqual([active.userId, active.assistantId]);
    expect(res.body.active_run.id).toBe(active.runId);
    expect(res.body.history).toMatchObject({ has_more: true, before: active.userId, page_size: 5 });

    const previous = await agent.get(`/api/assistant/messages?limit=5&before=${active.userId}`).expect(200);
    expect(previous.body.messages.map((message) => message.id)).toEqual(olderIds);
    expect(previous.body.history.has_more).toBe(false);
  });

  it("runs the assistant with Worklab tools and persists chat, events, journal, and memory", async () => {
    const runAgent = vi.fn(async (_systemPrompt, options) => {
      expect(options.permissionMode).toBe("bypassPermissions");
      expect(options.allowedTools).toContain("Bash");
      expect(options.allowedTools).toContain("mcp__worklab__*");
      expect(options.mcpServers.worklab).toBeTruthy();
      expect(options.outputSchema.properties.schema.const).toBe("worklab.assistant.v1");
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "Thinking through the request." }] } });
      return {
        text: assistantJson(),
        events: [],
        usage: { input_tokens: 12, output_tokens: 7 },
        durationMs: 5,
        numTurns: 1,
        model: "openai:gpt-5.5",
        effort: "high",
      };
    });
    const { agent, assistant, db, dataDir } = setup({ runAgent });
    const created = await agent.post("/api/assistant/messages").send({ body: "Create a task for the release checklist." }).expect(202);
    expect(created.body.user_message.body).toContain("release checklist");
    await assistant.waitIdle();

    const res = await agent.get("/api/assistant").expect(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1].body).toBe("Created the task.");
    expect(res.body.messages[1].run.status).toBe("succeeded");
    expect(res.body.messages[1].run).not.toHaveProperty("events");
    const run = await agent.get(`/api/assistant/runs/${created.body.run.id}`).expect(200);
    expect(run.body.run.events.some((event) => event.type === "assistant")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM assistant_agent_logs").get().count).toBe(1);

    const journalPath = join(dataDir, "agents", "mickey", "JOURNAL.md");
    const memoryPath = join(dataDir, "agents", "mickey", "MEMORY.md");
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(journalPath, "utf8")).toContain("Robert asked the assistant");
    expect(readFileSync(memoryPath, "utf8")).toContain("in-app assistant");
  });

  it("includes trusted current task view context in the assistant prompt", async () => {
    let capturedPrompt = "";
    const runAgent = vi.fn(async (systemPrompt) => {
      capturedPrompt = systemPrompt;
      return {
        text: assistantJson({ reply_text: "Done.", summary: "Inspected the current task." }),
        events: [],
        usage: {},
        durationMs: 1,
        numTurns: 1,
      };
    });
    const { agent, assistant, db } = setup({ runAgent });
    const now = 1700000000000;
    db.prepare(`
      INSERT INTO tasks
        (id, task_key, title, instructions, stage, created_at, updated_at)
      VALUES
        ('task-1', 'WL-9', 'Investigate failed run', 'Find the root cause before changing code.', 'execute', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO task_runs
        (id, task_id, mode, stage, agent_name, started_at, ended_at, status, process_status, decision, summary, error_text)
      VALUES
        ('run-selected', 'task-1', 'execute', 'execute', 'mickey', ?, ?, 'error', 'failed', 'changes_requested', 'Tests failed in the API route.', 'Expected prompt context was missing.')
    `).run(now + 1, now + 2);

    await agent.post("/api/assistant/messages").send({
      body: "What happened here?",
      view_context: {
        route: "tasks",
        view: "task_detail",
        path: "tasks/task-1",
        hash: "#/tasks/task-1?run=run-selected",
        resource_type: "task",
        resource_id: "task-1",
        selected_run_id: "run-selected",
        query: { run: "run-selected" },
      },
    }).expect(202);
    await assistant.waitIdle();

    expect(runAgent).toHaveBeenCalled();
    expect(capturedPrompt).toContain("## Current view");
    expect(capturedPrompt).toContain("Task: WL-9 - Investigate failed run");
    expect(capturedPrompt).toContain("Selected run: run-selected");
    expect(capturedPrompt).toContain("selected run-selected");
    expect(capturedPrompt).toContain("worklab_task_get");
    expect(capturedPrompt).toContain("worklab_run_get");
  });

  it("rejects concurrent messages in the same thread", async () => {
    let resolveRun;
    const runAgent = vi.fn((_systemPrompt, options) => new Promise((resolve) => {
      resolveRun = () => resolve({
        text: assistantJson({ reply_text: "Done.", summary: "Done." }),
        events: [],
        usage: {},
        durationMs: 1,
        numTurns: 1,
      });
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "Working." }] } });
    }));
    const { agent, assistant } = setup({ runAgent });
    await agent.post("/api/assistant/messages").send({ body: "Start something slow." }).expect(202);
    await agent.post("/api/assistant/messages").send({ body: "Second request." }).expect(409);
    resolveRun();
    await assistant.waitIdle();
  });

  it("cancels active assistant runs", async () => {
    const runAgent = vi.fn((_systemPrompt, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener("abort", () => resolve({
        cancelled: true,
        events: [],
        usage: {},
        durationMs: 1,
        numTurns: 0,
      }), { once: true });
    }));
    const { agent, assistant } = setup({ runAgent });
    const started = await agent.post("/api/assistant/messages").send({ body: "Keep working until I cancel." }).expect(202);
    await agent.post(`/api/assistant/runs/${started.body.run.id}/cancel`).expect(202);
    await assistant.waitIdle();
    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}`).expect(200);
    expect(run.body.run.status).toBe("cancelled");
    expect(run.body.run.cancel_initiator).toBe("api_cancel");
  });

  it("reconciles assistant runs that ignore cancellation", async () => {
    const runAgent = vi.fn(() => new Promise(() => {}));
    const { agent, db } = setup({ runAgent });
    writeSettings(db, { cancel_grace_ms: 0 });

    const started = await agent.post("/api/assistant/messages").send({ body: "Ignore cancellation." }).expect(202);
    await agent.post(`/api/assistant/runs/${started.body.run.id}/cancel`).expect(202);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}`).expect(200);
    expect(run.body.run.status).toBe("cancelled");
    expect(run.body.run.cancel_reason).toContain("reconciled after cancel grace");
  });

  it("marks assistant timeout aborts as failed timeouts", async () => {
    const runAgent = vi.fn((_systemPrompt, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener("abort", () => resolve({
        cancelled: true,
        events: [],
        usage: {},
        durationMs: 1,
        numTurns: 0,
      }), { once: true });
    }));
    const { agent, assistant, db } = setup({ runAgent });
    writeSettings(db, { assistant_run_timeout_ms: 1000 });

    const started = await agent.post("/api/assistant/messages").send({ body: "Take too long." }).expect(202);
    await assistant.waitIdle();

    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}`).expect(200);
    expect(run.body.run.status).toBe("failed");
    expect(run.body.run.failure_kind).toBe("timeout");
    expect(run.body.run.error_text).toMatch(/timed out/);
  });

  it("treats provider-side cancelled errors as failures", async () => {
    const runAgent = vi.fn(async () => ({
      cancelled: true,
      error: "Pi agent stopped before final output: max turns reached",
      failureKind: "usage_limit",
      events: [],
      usage: {},
      durationMs: 1,
      numTurns: 12,
    }));
    const { agent, assistant } = setup({ runAgent });

    const started = await agent.post("/api/assistant/messages").send({ body: "Create many items." }).expect(202);
    await assistant.waitIdle();

    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}`).expect(200);
    expect(run.body.run.status).toBe("failed");
    expect(run.body.run.failure_kind).toBe("usage_limit");
    expect(run.body.run.error_text).toMatch(/max turns/);
  });

  it("returns tail assistant run events with truncation metadata", async () => {
    const { agent, assistant } = setup({
      runAgent: vi.fn(async (_systemPrompt, options) => {
        options.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "One" }] } });
        options.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "Two" }] } });
        options.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "Three" }] } });
        return {
          text: assistantJson({ reply_text: "Done.", summary: "Done." }),
          events: [],
          usage: {},
          durationMs: 1,
          numTurns: 1,
        };
      }),
    });

    const started = await agent.post("/api/assistant/messages").send({ body: "Stream a few events." }).expect(202);
    await assistant.waitIdle();

    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}?events=tail&limit=2`).expect(200);
    expect(run.body.run.events).toHaveLength(2);
    expect(run.body.run.event_count).toBeGreaterThan(2);
    expect(run.body.run.events_truncated).toBe(true);
  });

  it("persists readable provider failures on assistant messages", async () => {
    const runAgent = vi.fn(async () => ({
      error: "Your input exceeds the context window of this model. Please adjust your input and try again.",
      events: [],
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "codex:gpt-5.5",
      effort: "high",
      failureKind: "usage_limit",
    }));
    const { agent, assistant } = setup({ runAgent });
    const started = await agent.post("/api/assistant/messages").send({ body: "Make a very large request." }).expect(202);

    await assistant.waitIdle();

    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}`).expect(200);
    expect(run.body.run.status).toBe("failed");
    expect(run.body.run.error_text).toBe("Your input exceeds the context window of this model. Please adjust your input and try again.");
    const thread = await agent.get("/api/assistant").expect(200);
    expect(thread.body.messages.at(-1).body).toBe("Assistant failed: Your input exceeds the context window of this model. Please adjust your input and try again.");
  });
});
