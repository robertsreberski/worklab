import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestServer } from "../helpers/test-server.js";
import { writeSettings } from "../../core/settings.js";

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
      slack_agent_name: "assistant",
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
    expect(res.body.messages[1].run.events.some((event) => event.type === "assistant")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM assistant_agent_logs").get().count).toBe(1);

    const journalPath = join(dataDir, "agents", "assistant", "JOURNAL.md");
    const memoryPath = join(dataDir, "agents", "assistant", "MEMORY.md");
    expect(existsSync(journalPath)).toBe(true);
    expect(readFileSync(journalPath, "utf8")).toContain("Robert asked the assistant");
    expect(readFileSync(memoryPath, "utf8")).toContain("in-app assistant");
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
  });
});
