// src/__tests__/e2e/multi-sdk.test.js
//
// Multi-SDK dispatch smoke tests for the non-Claude SDK paths.
// Covers resolveModel + generateResponse routing to ai-openai.js and
// ai-vercel.js, and asserts the return shape + estimateCost compatibility.
//
// Mocking strategy: vi.mock() is hoisted by vitest to before any imports,
// so the module-level side-effects in ai-openai.js (Runner construction,
// setTracingDisabled) consume the stubs rather than the real packages.
// The ai path also needs `tool` mocked since ai-vercel-tools.js imports it.
// providers.js is mocked so ai-vercel.js skips the real DB/factory lookup.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { estimateCost } from "../../core/cost.js";

// ── @openai/agents mock ────────────────────────────────────────────────────
// ai-openai.js creates a module-level `runner = new Runner(...)` so the mock
// must wire up the constructor before the module loads.

const mockRun = vi.fn();

vi.mock("@openai/agents", () => {
  class Runner {
    constructor() {}
    run(...args) { return mockRun(...args); }
  }
  class Agent {
    constructor(cfg) { this.cfg = cfg; }
  }
  class MCPServerStdio {
    constructor() {}
    async connect() {}
    async close() {}
  }
  class MCPServerStreamableHttp {
    constructor() {}
    async connect() {}
    async close() {}
  }
  function setTracingDisabled() {}
  function tool({ name, description, parameters, execute }) {
    return { name, description, parameters, execute };
  }
  return { Runner, Agent, MCPServerStdio, MCPServerStreamableHttp, setTracingDisabled, tool };
});

// ── ai mock ────────────────────────────────────────────────────────────────
// ai-vercel.js calls streamText() + consumes result.fullStream + result.text
// + result.totalUsage. ai-vercel-tools.js imports `tool` from "ai".

const mockStreamText = vi.fn();

vi.mock("ai", () => {
  function tool({ description, inputSchema, execute }) {
    return { description, inputSchema, execute };
  }
  function stepCountIs(n) { return n; }
  return { streamText: (...args) => mockStreamText(...args), tool, stepCountIs };
});

// ── ai-sdk-ollama mock ─────────────────────────────────────────────────────
vi.mock("ai-sdk-ollama", () => ({
  createOllama: () => ({ chat: () => ({ id: "stub-ollama" }) }),
}));

// ── @ai-sdk/openai-compatible mock ────────────────────────────────────────
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => ({ chatModel: () => ({ id: "stub-compat" }) }),
}));

// ── @modelcontextprotocol/sdk mock ────────────────────────────────────────
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async close() {}
    async listTools() { return { tools: [] }; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    async close() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    async close() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    async close() {}
  },
}));

// ── providers.js mock ──────────────────────────────────────────────────────
// resolveVercelModel is called inside generateVercelResponse. We stub it to
// return a factory that produces a simple language-model placeholder.
vi.mock("../../core/providers.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveVercelModel: vi.fn(({ providerId, modelName }) => ({
      provider: { id: providerId, name: "stub", provider_type: "openai_compat", base_url: "http://localhost:11434" },
      modelRow: { model_name: modelName, capabilities: {}, enabled: true },
      modelFactory: () => ({ id: `stub-${modelName}` }),
    })),
    defaultOllamaNumCtx: actual.defaultOllamaNumCtx,
  };
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeAsyncIterable(items) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

// ── module under test (imported after mocks are registered) ───────────────

let generateResponse, resolveModel;
beforeAll(async () => {
  ({ generateResponse, resolveModel } = await import("../../core/ai.js"));
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 1: OpenAI Agents SDK dispatch
// ══════════════════════════════════════════════════════════════════════════

describe("generateResponse → OpenAI Agents SDK path", () => {
  it("resolveModel returns sdk:openai for openai:gpt-5.4", () => {
    const m = resolveModel("openai:gpt-5.4");
    expect(m.sdk).toBe("openai");
    expect(m.model).toBe("gpt-5.4");
  });

  it("dispatches to ai-openai.js, emits events, returns canonical shape", async () => {
    // Build a scripted stream that matches the event types consumed in
    // ai-openai.js: run_item_stream_event(message_output_created) for text,
    // and raw_model_stream_event(response_done) for usage.
    const scriptedStream = {
      ...makeAsyncIterable([
        {
          type: "run_item_stream_event",
          name: "message_output_created",
          item: {
            content: [{ type: "text", text: "Hello from OpenAI stub" }],
            rawItem: { content: [{ type: "text", text: "Hello from OpenAI stub" }] },
          },
        },
        {
          type: "raw_model_stream_event",
          data: {
            type: "response_done",
            response: {
              usage: { inputTokens: 20, outputTokens: 8, input_tokens_details: null },
            },
          },
        },
      ]),
      finalOutput: "Hello from OpenAI stub",
      runContext: { usage: { inputTokens: 20, outputTokens: 8 } },
    };

    mockRun.mockResolvedValue(scriptedStream);

    // Set env var required by generateOpenAIResponse
    process.env.OPENAI_API_KEY = "test-key";

    const events = [];
    const result = await generateResponse("You are a test assistant.", {
      model: resolveModel("openai:gpt-5.4"),
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      onEvent: (e) => events.push(e),
    });

    // Basic shape assertions
    expect(result.sdk).toBe("openai");
    expect(result.model).toBe("gpt-5.4");
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toBeDefined();
    expect(typeof result.usage.input_tokens).toBe("number");
    expect(typeof result.usage.output_tokens).toBe("number");

    // Events should include the assistant text event
    expect(events.length).toBeGreaterThan(0);
    const textEvent = events.find(
      (e) => e.type === "assistant" &&
        e.message?.content?.some((c) => c.type === "text"),
    );
    expect(textEvent).toBeDefined();
    expect(textEvent.message.content[0].text).toBe("Hello from OpenAI stub");

    // Cost estimation should not throw and should return a finite number
    const cost = estimateCost({
      model: `openai:${result.model}`,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    });
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns an error field (not a throw) when runner.run rejects", async () => {
    mockRun.mockRejectedValue(new Error("network timeout"));
    process.env.OPENAI_API_KEY = "test-key";

    const result = await generateResponse("sys", {
      model: resolveModel("openai:gpt-5.4"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      onEvent: () => {},
    });

    expect(result.sdk).toBe("openai");
    expect(result.error).toMatch(/network timeout/);
    // Should not crash — graceful degradation
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("result.cancelled is true when abort signal fires before stream completes", async () => {
    const ac = new AbortController();
    // Immediately abort so the stream loop sees it
    ac.abort();

    const scriptedStream = {
      ...makeAsyncIterable([]),
      finalOutput: "",
      runContext: {},
    };
    mockRun.mockResolvedValue(scriptedStream);
    process.env.OPENAI_API_KEY = "test-key";

    const result = await generateResponse("sys", {
      model: resolveModel("openai:gpt-5.4"),
      effort: "low",
      messages: [{ role: "user", content: "x" }],
      abortSignal: ac.signal,
      onEvent: () => {},
    });

    expect(result.cancelled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 2: Vercel AI SDK dispatch
// ══════════════════════════════════════════════════════════════════════════

describe("generateResponse → Vercel AI SDK path", () => {
  const PROVIDER_ID = "prov-abc123";
  const MODEL_NAME = "gemma3:4b";
  const MODEL_REF = `vercel:${PROVIDER_ID}:${MODEL_NAME}`;

  it("resolveModel returns sdk:vercel with correct providerId/modelName", () => {
    const m = resolveModel(MODEL_REF);
    expect(m.sdk).toBe("vercel");
    expect(m.providerId).toBe(PROVIDER_ID);
    expect(m.modelName).toBe(MODEL_NAME);
    expect(m.model).toBe(MODEL_NAME);
  });

  it("dispatches to ai-vercel.js, emits events, returns canonical shape", async () => {
    // Build a scripted fullStream iterable.
    // ai-vercel.js reads: text-delta, reasoning-delta; ignores others.
    const scriptedFullStream = makeAsyncIterable([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "from Vercel stub" },
    ]);

    // result.totalUsage and result.text are awaited as promises
    const scriptedResult = {
      fullStream: scriptedFullStream,
      totalUsage: Promise.resolve({ inputTokens: 15, outputTokens: 6 }),
      usage: Promise.resolve({ inputTokens: 15, outputTokens: 6 }),
      text: Promise.resolve("Hello from Vercel stub"),
    };

    // onStepFinish is called internally by ai-vercel.js via streamText option;
    // we need to invoke it to exercise the event-emit path. We'll call it from
    // inside the streamText mock after building the result.
    mockStreamText.mockImplementation((opts) => {
      // Trigger onStepFinish synchronously so events are emitted before the
      // for-await loop starts (which is fine — events array is populated first)
      if (opts?.onStepFinish) {
        opts.onStepFinish({
          text: "Hello from Vercel stub",
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 15, outputTokens: 6 },
        });
      }
      return scriptedResult;
    });

    const events = [];
    const result = await generateResponse("You are a test assistant.", {
      model: resolveModel(MODEL_REF),
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      onEvent: (e) => events.push(e),
    });

    // Basic shape assertions
    expect(result.sdk).toBe("vercel");
    expect(result.model).toBe(MODEL_REF);
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toBeDefined();
    expect(typeof result.usage.input_tokens).toBe("number");
    expect(typeof result.usage.output_tokens).toBe("number");

    // Events: the onStepFinish text event should be emitted
    expect(events.length).toBeGreaterThan(0);
    const textEvent = events.find(
      (e) => e.type === "assistant" &&
        e.message?.content?.some((c) => c.type === "text"),
    );
    expect(textEvent).toBeDefined();

    // Cost estimation with the vercel reference
    const cost = estimateCost({
      db: null,
      model: result.model,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    });
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns an error field (not a throw) when streamText throws", async () => {
    mockStreamText.mockImplementation(() => {
      throw new Error("provider unreachable");
    });

    const result = await generateResponse("sys", {
      model: resolveModel(MODEL_REF),
      effort: "low",
      messages: [{ role: "user", content: "hi" }],
      onEvent: () => {},
    });

    expect(result.sdk).toBe("vercel");
    expect(result.error).toMatch(/provider unreachable/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns an error field when resolveVercelModel throws (provider not found)", async () => {
    const { resolveVercelModel } = await import("../../core/providers.js");
    resolveVercelModel.mockImplementationOnce(() => {
      throw new Error("provider not found: bad-id");
    });

    const result = await generateResponse("sys", {
      model: resolveModel("vercel:bad-id:some-model"),
      effort: "low",
      messages: [{ role: "user", content: "hi" }],
      onEvent: () => {},
    });

    expect(result.sdk).toBe("vercel");
    expect(result.error).toMatch(/provider not found/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Scenario 3: resolveModel parse coverage for all three SDK forms
// ══════════════════════════════════════════════════════════════════════════

describe("resolveModel parse coverage", () => {
  it("claude: form", () => {
    const m = resolveModel("claude:claude-sonnet-4-6");
    expect(m).toMatchObject({ sdk: "claude", model: "claude-sonnet-4-6" });
  });

  it("openai: form", () => {
    const m = resolveModel("openai:gpt-5.4-mini");
    expect(m).toMatchObject({ sdk: "openai", model: "gpt-5.4-mini" });
  });

  it("vercel: form preserves colons in model name", () => {
    const m = resolveModel("vercel:abc123:gemma3:4b");
    expect(m).toMatchObject({ sdk: "vercel", providerId: "abc123", modelName: "gemma3:4b" });
  });

  it("generateResponse throws for unknown sdk at runtime", async () => {
    // parseModelReference rejects unknown sdks, so generateResponse should
    // propagate that error (it calls parseModelReference internally when given
    // a pre-resolved object with an unknown sdk).
    await expect(
      generateResponse("sys", {
        model: { sdk: "unknown", model: "x" },
        messages: [{ role: "user", content: "hi" }],
        onEvent: () => {},
      }),
    ).rejects.toThrow(/unsupported sdk/i);
  });
});
