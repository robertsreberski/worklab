import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCost } from "../../core/cost.js";
import { openDb, runMigrations } from "../../core/db.js";
import { generateResponse, resolveModel } from "../../core/ai.js";
import { createProvider, setModelEnabled, upsertModel } from "../../core/providers.js";

let db;
let dataDir;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-multi-sdk-"));
  db = openDb(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function usage({ input = 20, output = 8, cacheRead = 0, cost = 0.001 } = {}) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function textStream(text, nextUsage = usage()) {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const start = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: nextUsage,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const done = { ...start, content: [{ type: "text", text }] };
      stream.push({ type: "start", partial: start });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: done });
      stream.push({ type: "done", reason: "stop", message: done });
    });
    return stream;
  };
}

function errorStream(message) {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const error = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage({ input: 0, output: 0, cost: 0 }),
        stopReason: "error",
        errorMessage: message,
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error });
    });
    return stream;
  };
}

function structuredOutputStream(payload) {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = {
        role: "assistant",
        content: [{ type: "toolCall", id: "structured-1", name: "StructuredOutput", arguments: payload }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(),
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
    });
    return stream;
  };
}

function createCustomProviderModel(modelName = "gemma3:4b") {
  const provider = createProvider({
    db,
    dataDir,
    name: "local compat",
    provider_type: "openai_compat",
    base_url: "http://localhost:8000",
  });
  const model = upsertModel({
    db,
    providerId: provider.id,
    modelName,
    displayName: modelName,
    capabilities: { tool_use: true, reasoning: true },
  });
  setModelEnabled({ db, id: model.id, enabled: true });
  return `vercel:${provider.id}:${modelName}`;
}

describe("generateResponse pi-backed dispatch", () => {
  it("resolves and runs openai: references through the pi agent runtime", async () => {
    const events = [];
    const result = await generateResponse("You are a test assistant.", {
      model: resolveModel("openai:gpt-5.5"),
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      streamFn: textStream("Hello from pi OpenAI"),
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ sdk: "openai", model: "gpt-5.5", text: "Hello from pi OpenAI" });
    expect(result.usage.input_tokens).toBe(20);
    expect(result.usage.output_tokens).toBe(8);
    expect(events.some((event) => event.type === "assistant" && event.message?.content?.[0]?.text === "Hello from pi OpenAI")).toBe(true);
    expect(Number.isFinite(estimateCost({
      model: `openai:${result.model}`,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    }))).toBe(true);
  });

  it("returns an error field when the pi stream ends with an error", async () => {
    const result = await generateResponse("sys", {
      model: resolveModel("openai:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      streamFn: errorStream("network timeout"),
    });

    expect(result.sdk).toBe("openai");
    expect(result.error).toMatch(/network timeout/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs custom provider vercel: references through the same pi runtime", async () => {
    const modelRef = createCustomProviderModel();
    const result = await generateResponse("sys", {
      db,
      dataDir,
      model: resolveModel(modelRef),
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      streamFn: textStream("Hello from custom provider"),
    });

    expect(result).toMatchObject({ sdk: "vercel", model: modelRef, text: "Hello from custom provider" });
    expect(result.usage.input_tokens).toBe(20);
  });

  it("returns an error field when a custom provider is missing", async () => {
    const result = await generateResponse("sys", {
      db,
      dataDir,
      model: resolveModel("vercel:bad-id:some-model"),
      effort: "low",
      messages: [{ role: "user", content: "hi" }],
      streamFn: textStream("unused"),
    });

    expect(result.sdk).toBe("vercel");
    expect(result.error).toMatch(/provider not found/);
  });

  it("supports codex: references without the legacy Codex CLI path", async () => {
    const result = await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      streamFn: textStream("Codex via pi"),
    });

    expect(result).toMatchObject({ sdk: "codex", model: "gpt-5.5", text: "Codex via pi" });
  });

  it("supports explicit pi:<provider>:<model> references", async () => {
    const model = resolveModel("pi:google:gemini-2.5-pro");
    expect(model).toMatchObject({ sdk: "pi", provider: "google", model: "gemini-2.5-pro" });

    const result = await generateResponse("sys", {
      model,
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      streamFn: textStream("Gemini via pi"),
    });

    expect(result).toMatchObject({ sdk: "pi", model: "gemini-2.5-pro", text: "Gemini via pi" });
  });

  it("captures StructuredOutput tool calls as Worklab results", async () => {
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Done",
      details: "Implementation complete.",
      final_text: "Implemented.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const result = await generateResponse("sys", {
      model: resolveModel("openai:gpt-5.5"),
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      outputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["schema"],
        properties: { schema: { type: "string" } },
      },
      streamFn: structuredOutputStream(worklabResult),
    });

    expect(result.text).toBe("Implemented.");
    expect(result.worklabResult).toMatchObject(worklabResult);
    expect(result.events.some((event) => event.type === "assistant" && event.message?.content?.[0]?.name === "StructuredOutput")).toBe(true);
  });
});

describe("resolveModel parse coverage", () => {
  it("claude: form", () => {
    expect(resolveModel("claude:claude-sonnet-4-6")).toMatchObject({ sdk: "claude", model: "claude-sonnet-4-6" });
  });

  it("openai: form", () => {
    expect(resolveModel("openai:gpt-5.5")).toMatchObject({ sdk: "openai", model: "gpt-5.5" });
  });

  it("vercel: form preserves colons in model name", () => {
    expect(resolveModel("vercel:abc123:gemma3:4b")).toMatchObject({ sdk: "vercel", providerId: "abc123", modelName: "gemma3:4b" });
  });

  it("pi: form preserves colons in model name", () => {
    expect(resolveModel("pi:amazon-bedrock:anthropic.claude-sonnet-4-5-v1:0"))
      .toMatchObject({ sdk: "pi", provider: "amazon-bedrock", model: "anthropic.claude-sonnet-4-5-v1:0" });
  });

  it("generateResponse rejects unknown sdk objects", async () => {
    await expect(
      generateResponse("sys", {
        model: { sdk: "unknown", model: "x" },
        messages: [{ role: "user", content: "hi" }],
        streamFn: textStream("unused"),
      }),
    ).rejects.toThrow(/unsupported sdk/i);
  });
});
