import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { writeSettings } from "../../core/settings.js";
import { DEFAULT_ASSISTANT_THREAD_ID } from "../../core/index.js";
import { SUBAGENT_ACTIVITY_ROW_LIMIT } from "../../core/run-events.js";

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
    journal_bullets: ["The user asked the assistant to create a task."],
    memory_facts: ["The user uses the in-app assistant for Worklab administration."],
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
            model: "pi:openai:gpt-5.5",
            effort: "high",
          };
        }),
      },
    });
    writeSettings(server.db, {
      slack_agent_name: "assistant",
      assistant_model: "pi:openai:gpt-5.5",
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
        model: "pi:openai:gpt-5.5",
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

    const journalPath = join(dataDir, "agents", "assistant", "JOURNAL.md");
    const memoryPath = join(dataDir, "agents", "assistant", "MEMORY.md");
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(journalPath, "utf8")).toContain("The user asked the assistant");
    expect(readFileSync(memoryPath, "utf8")).toContain("in-app assistant");
  });

  it("broadcasts assistant progress and final payloads on the global stream", async () => {
    const runAgent = vi.fn(async (_systemPrompt, options) => {
      options.onEvent?.({ type: "assistant", message: { content: [{ type: "thinking", text: "Checking the current state." }] } });
      return {
        text: assistantJson({ reply_text: "Finished the check.", summary: "Checked the current state." }),
        events: [],
        usage: { input_tokens: 3, output_tokens: 2 },
        durationMs: 8,
        numTurns: 1,
        model: "pi:openai:gpt-5.5",
        effort: "high",
      };
    });
    const { agent, assistant, broker } = setup({ runAgent });
    const broadcast = vi.spyOn(broker, "broadcast");

    const started = await agent.post("/api/assistant/messages").send({ body: "Check this." }).expect(202);
    await assistant.waitIdle();

    expect(broadcast).toHaveBeenCalledWith("global", expect.objectContaining({
      type: "assistant_run_event",
      thread_id: "personal",
      run_id: started.body.run.id,
      event_seq: expect.any(Number),
      event: expect.objectContaining({ type: "assistant" }),
    }));

    expect(broadcast).toHaveBeenCalledWith("global", expect.objectContaining({
      type: "assistant_run_ended",
      thread_id: "personal",
      run_id: started.body.run.id,
      status: "succeeded",
      run: expect.objectContaining({ id: started.body.run.id, status: "succeeded" }),
      message: expect.objectContaining({
        id: started.body.assistant_message.id,
        body: "Finished the check.",
        run: expect.objectContaining({ id: started.body.run.id, status: "succeeded" }),
      }),
    }));
  });

  it("uses provider structuredResult when assistant text is empty", async () => {
    const structured = {
      schema: "worklab.assistant.v1",
      reply_text: "Added the skill to the Journey agents.",
      summary: "Updated Journey agents with the ios-pwa skill.",
      journal_bullets: ["Added ios-pwa to the Journey project agents."],
      memory_facts: [],
      action_items: [],
    };
    const runAgent = vi.fn(async (_systemPrompt, options) => {
      options.onEvent?.({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "structured-1",
            name: "StructuredOutput",
            input: structured,
          }],
        },
      });
      options.onEvent?.({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "structured-1",
            content: "Structured output received.",
          }],
        },
      });
      return {
        text: "",
        structuredResult: structured,
        structuredResultSource: "StructuredOutput",
        events: [],
        usage: { input_tokens: 12, output_tokens: 7 },
        durationMs: 5,
        numTurns: 1,
        model: "pi:openai-codex:gpt-5.5",
        effort: "high",
      };
    });
    const { agent, assistant } = setup({ runAgent });

    const started = await agent.post("/api/assistant/messages").send({ body: "Add ios-pwa to Journey agents." }).expect(202);
    await assistant.waitIdle();

    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}`).expect(200);
    expect(run.body.run.status).toBe("succeeded");
    expect(run.body.run.final).toMatchObject(structured);
    expect(run.body.run.final).not.toHaveProperty("parse_error");
    expect(run.body.run.warnings).toEqual([]);
    expect(run.body.run.diagnostics).toMatchObject({
      result_source: "structured",
      structured_result_source: "StructuredOutput",
    });
    const thread = await agent.get("/api/assistant").expect(200);
    expect(thread.body.messages.at(-1).body).toBe("Added the skill to the Journey agents.");
  });

  it("fails malformed provider structuredResult instead of falling back to text", async () => {
    const runAgent = vi.fn(async () => ({
      text: assistantJson({ reply_text: "Fallback should not be used.", summary: "Fallback should not be used." }),
      structuredResult: {
        schema: "worklab.assistant.v1",
        reply_text: "Missing summary.",
        journal_bullets: [],
        memory_facts: [],
        action_items: [],
      },
      structuredResultSource: "StructuredOutput",
      events: [],
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "high",
    }));
    const { agent, assistant } = setup({ runAgent });

    const started = await agent.post("/api/assistant/messages").send({ body: "Return malformed structured output." }).expect(202);
    await assistant.waitIdle();

    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}`).expect(200);
    expect(run.body.run.status).toBe("failed");
    expect(run.body.run.failure_kind).toBe("invalid_result");
    expect(run.body.run.error_text).toMatch(/structured result/i);
    const thread = await agent.get("/api/assistant").expect(200);
    expect(thread.body.messages.at(-1).body).toMatch(/Assistant failed:/);
    expect(thread.body.messages.at(-1).body).not.toContain("Fallback should not be used.");
  });

  it("records non-empty plain text assistant fallback as informational diagnostics", async () => {
    const runAgent = vi.fn(async () => ({
      text: "Ollama returned a useful plain-text answer.",
      events: [],
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:local:qwen3.6:latest",
      effort: "high",
    }));
    const { agent, assistant } = setup({ runAgent });

    const started = await agent.post("/api/assistant/messages").send({ body: "Use the local model." }).expect(202);
    await assistant.waitIdle();

    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}`).expect(200);
    expect(run.body.run.status).toBe("succeeded");
    expect(run.body.run.final).toMatchObject({
      reply_text: "Ollama returned a useful plain-text answer.",
      parse_error: "Assistant did not return a JSON object",
    });
    expect(run.body.run.warnings).toEqual([]);
    expect(run.body.run.diagnostics).toMatchObject({
      result_source: "text_fallback",
      parse_error: "Assistant did not return a JSON object",
    });
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
        ('run-selected', 'task-1', 'execute', 'execute', 'assistant', ?, ?, 'error', 'failed', 'changes_requested', 'Tests failed in the API route.', 'Expected prompt context was missing.')
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

  it("returns tail assistant visible items with truncation metadata", async () => {
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
    // Consecutive thinking frames are one visible item, so the two-item tail
    // intentionally carries all three raw frames plus the terminal event.
    expect(run.body.run.events).toHaveLength(4);
    expect(run.body.run.event_count).toBeGreaterThan(2);
    expect(run.body.run.events_truncated).toBe(true);
  });

  it("bounds one assistant subagent group even when the requested tail is wider", async () => {
    const nestedCount = SUBAGENT_ACTIVITY_ROW_LIMIT + 25;
    const { agent, assistant } = setup({
      runAgent: vi.fn(async (_systemPrompt, options) => {
        options.onEvent?.({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "spawn-assistant", name: "Agent", input: {} }] },
        });
        options.onEvent?.({
          type: "subagent_activity",
          phase: "agent_started",
          id: "agent:spawn-assistant",
          subagent: { id: "spawn-assistant", name: "reviewer", callIndex: 0 },
        });
        for (let index = 0; index < nestedCount; index += 1) {
          options.onEvent?.({
            type: "subagent_activity",
            phase: "message",
            id: `agent:spawn-assistant:message-${index}`,
            kind: "text",
            content: `child ${index}`,
            subagent: { id: "spawn-assistant", name: "reviewer", callIndex: 0 },
          });
        }
        options.onEvent?.({
          type: "subagent_activity",
          phase: "agent_completed",
          id: "agent:spawn-assistant",
          subagent: { id: "spawn-assistant", name: "reviewer", callIndex: 0 },
        });
        return {
          text: assistantJson({ reply_text: "Done.", summary: "Done." }),
          events: [],
          usage: {},
          durationMs: 1,
          numTurns: 1,
        };
      }),
    });

    const started = await agent.post("/api/assistant/messages").send({ body: "Use a helper." }).expect(202);
    await assistant.waitIdle();
    const run = await agent.get(`/api/assistant/runs/${started.body.run.id}?events=tail&limit=500`).expect(200);
    const activity = run.body.run.events.filter((event) => event.type === "subagent_activity");

    expect(activity.filter((event) => event.phase === "message")).toHaveLength(SUBAGENT_ACTIVITY_ROW_LIMIT);
    expect(activity.find((event) => event.phase === "agent_started")?._worklab_subagent_omitted_rows).toBe(25);
    expect(activity.at(-1)?.phase).toBe("agent_completed");
    expect(run.body.run.events_truncated).toBe(true);
  });

  it("bounds flat assistant subagent arguments before persistence and broadcast", async () => {
    const oversizedArguments = "x".repeat(1_000_000);
    const runAgent = vi.fn(async (_systemPrompt, options) => {
      options.onEvent?.({
        type: "subagent_activity",
        phase: "tool_started",
        id: "agent:writer:tool:write",
        tool_name: "Write",
        arguments: oversizedArguments,
        subagent: { id: "writer", name: "writer", callIndex: 0 },
      });
      return {
        text: assistantJson({ reply_text: "Done.", summary: "Done." }),
        events: [],
        usage: {},
        durationMs: 1,
        numTurns: 1,
      };
    });
    const { agent, assistant, broker, db } = setup({ runAgent });
    const broadcast = vi.spyOn(broker, "broadcast");

    const started = await agent.post("/api/assistant/messages").send({ body: "Use a writer." }).expect(202);
    await assistant.waitIdle();

    const persistedEvents = JSON.parse(db.prepare(`
      SELECT events FROM assistant_agent_logs WHERE assistant_run_id = ?
    `).get(started.body.run.id).events);
    const persisted = persistedEvents.find((event) => event.type === "subagent_activity");
    const direct = broadcast.mock.calls.find(([channel, event]) => (
      channel === `assistant:${started.body.run.id}` && event?.type === "subagent_activity"
    ))?.[1];
    const global = broadcast.mock.calls.find(([channel, event]) => (
      channel === "global"
      && event?.type === "assistant_run_event"
      && event.event?.type === "subagent_activity"
    ))?.[1]?.event;

    for (const event of [persisted, direct, global]) {
      expect(event).toMatchObject({
        arguments_truncated: true,
        arguments_original_length: 1_000_000,
      });
      expect(event.arguments.length).toBeLessThan(20_000);
      expect(event.arguments).toContain("[truncated assistant subagent arguments:");
    }

    const run = db.prepare("SELECT raw_output_path FROM assistant_runs WHERE id = ?").get(started.body.run.id);
    expect(readFileSync(run.raw_output_path, "utf8")).toContain(oversizedArguments);
  });

  it("leaves absent subagent arguments unmarked and safely bounds non-JSON values", async () => {
    const circularArguments = { operation: "read" };
    circularArguments.self = circularArguments;
    const runAgent = vi.fn(async (_systemPrompt, options) => {
      options.onEvent?.({
        type: "subagent_activity",
        phase: "tool_started",
        id: "agent:reader:tool:no-arguments",
        tool_name: "Read",
        arguments: undefined,
        subagent: { id: "reader", name: "reader", callIndex: 0 },
      });
      options.onEvent?.({
        type: "subagent_activity",
        phase: "tool_started",
        id: "agent:reader:tool:circular-arguments",
        tool_name: "Read",
        arguments: circularArguments,
        subagent: { id: "reader", name: "reader", callIndex: 0 },
      });
      return {
        text: assistantJson({ reply_text: "Done.", summary: "Done." }),
        events: [],
        usage: {},
        durationMs: 1,
        numTurns: 1,
      };
    });
    const { agent, assistant, broker, db } = setup({ runAgent });
    const broadcast = vi.spyOn(broker, "broadcast");

    const started = await agent.post("/api/assistant/messages").send({ body: "Use a reader." }).expect(202);
    await assistant.waitIdle();

    const persistedEvents = JSON.parse(db.prepare(`
      SELECT events FROM assistant_agent_logs WHERE assistant_run_id = ?
    `).get(started.body.run.id).events);
    const absent = persistedEvents.find((event) => event.id === "agent:reader:tool:no-arguments");
    const nonSerializable = persistedEvents.find((event) => event.id === "agent:reader:tool:circular-arguments");
    const directAbsent = broadcast.mock.calls.find(([channel, event]) => (
      channel === `assistant:${started.body.run.id}` && event?.id === absent.id
    ))?.[1];
    const directNonSerializable = broadcast.mock.calls.find(([channel, event]) => (
      channel === `assistant:${started.body.run.id}` && event?.id === nonSerializable.id
    ))?.[1];
    const globalNonSerializable = broadcast.mock.calls.find(([channel, event]) => (
      channel === "global"
      && event?.type === "assistant_run_event"
      && event.event?.id === nonSerializable.id
    ))?.[1]?.event;

    for (const event of [absent, directAbsent]) {
      expect(event).not.toHaveProperty("arguments_truncated");
      expect(event).not.toHaveProperty("arguments_original_length");
      expect(event).not.toHaveProperty("arguments_serialization_error");
    }
    for (const event of [nonSerializable, directNonSerializable, globalNonSerializable]) {
      expect(event).toMatchObject({
        arguments: "[assistant subagent arguments unavailable: value is not JSON-serializable]",
        arguments_truncated: true,
        arguments_serialization_error: true,
      });
      expect(event).not.toHaveProperty("arguments_original_length");
      expect(() => JSON.stringify(event)).not.toThrow();
    }

    const run = db.prepare("SELECT raw_output_path FROM assistant_runs WHERE id = ?").get(started.body.run.id);
    const rawEvents = readFileSync(run.raw_output_path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rawEvents.find((event) => event.id === "agent:reader:tool:no-arguments"))
      .not.toHaveProperty("arguments_truncated");
    expect(rawEvents.find((event) => event.id === "agent:reader:tool:circular-arguments"))
      .toMatchObject({ arguments_serialization_error: true });
  });

  it("persists readable provider failures on assistant messages", async () => {
    const runAgent = vi.fn(async () => ({
      error: "Your input exceeds the context window of this model. Please adjust your input and try again.",
      events: [],
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
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
