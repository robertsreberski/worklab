import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCost } from "@mono-agent/agent-runtime/ai/cost.js";
import { customPricingResolverFor } from "../../core/custom-pricing.js";
import { extractWorklabResult } from "../../core/worklab-result/contract.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { generateResponse, resolveModel } from "../../core/ai.js";
import { createProvider, setModelEnabled, upsertModel } from "../../core/providers.js";
import { readSettings } from "../../core/settings.js";

let db;
let dataDir;
let faux = null;
let fauxModels = null;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-multi-sdk-"));
  db = openDb(":memory:");
  runMigrations(db);
});

afterEach(() => {
  faux = null;
  fauxModels = null;
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

function withUsage(message, nextUsage = usage()) {
  return { ...message, usage: nextUsage };
}

function textMessage(text, nextUsage = usage()) {
  return withUsage(fauxAssistantMessage(fauxText(text)), nextUsage);
}

function thinkingMessage(thinking, text, nextUsage = usage()) {
  return withUsage(fauxAssistantMessage([fauxThinking(thinking), fauxText(text)]), nextUsage);
}

function errorMessage(message) {
  return withUsage(
    fauxAssistantMessage([], { stopReason: "error", errorMessage: message }),
    usage({ input: 0, output: 0, cost: 0 }),
  );
}

function structuredOutputMessage(payload) {
  return withUsage(
    fauxAssistantMessage(fauxToolCall("StructuredOutput", payload, { id: "structured-1" }), {
      stopReason: "toolUse",
    }),
    usage(),
  );
}

function setupFauxRuntime(responses, { reasoning = true } = {}) {
  faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", reasoning }],
    tokensPerSecond: undefined,
    tokenSize: { min: 1000, max: 1000 },
  });
  fauxModels = createModels();
  fauxModels.setProvider(faux.provider);
  faux.setResponses(responses);
  return {
    piResolvedModel: faux.getModel(),
    piResolvedModels: fauxModels,
    piMaxRetries: 0,
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
  return `pi:${provider.id}:${modelName}`;
}

describe("generateResponse pi-backed dispatch", () => {
  it("resolves and runs pi:openai references through the pi agent runtime", async () => {
    const events = [];
    const result = await generateResponse("You are a test assistant.", {
      model: resolveModel("pi:openai:gpt-5.5"),
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      ...setupFauxRuntime([textMessage("Hello from pi OpenAI")]),
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ sdk: "pi", model: "pi:openai:gpt-5.5", text: "Hello from pi OpenAI" });
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.output_tokens).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "assistant" && event.message?.content?.[0]?.text === "Hello from pi OpenAI")).toBe(true);
    expect(Number.isFinite(estimateCost({
      resolveCustomPricing: customPricingResolverFor(),
      model: result.model,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    }))).toBe(true);
  });

  // Worklab passes the typed toolLimits/compaction policy objects, so
  // agent-runtime must never fall back to the deprecated `settings` bag.
  it("passes typed run policies instead of the deprecated settings bag", async () => {
    const events = [];
    const result = await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hi" }],
      settings: readSettings(db),
      ...setupFauxRuntime([textMessage("ok")]),
      onEvent: (event) => events.push(event),
    });

    const deprecations = [
      ...(result.runtimeWarnings || []),
      ...events.filter((event) => event.type === "runtime_warning"),
    ].filter((warning) => warning.warning_kind === "deprecated_settings_option");
    expect(deprecations).toEqual([]);
  });

  it("returns an error field when the pi stream ends with an error", async () => {
    const result = await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      ...setupFauxRuntime([errorMessage("network timeout")]),
    });

    expect(result.sdk).toBe("pi");
    expect(result.error).toMatch(/network timeout/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("normalizes nested Codex context overflow errors", async () => {
    const providerError = {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
        param: "input",
      },
      sequence_number: 2,
    };
    const result = await generateResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "low",
      messages: [{ role: "user", content: "hello" }],
      ...setupFauxRuntime([errorMessage(`Codex error: ${JSON.stringify(providerError)}`)]),
    });

    expect(result.sdk).toBe("pi");
    expect(result.error).toBe("Your input exceeds the context window of this model. Please adjust your input and try again.");
    expect(result.error).not.toContain("invalid_request_error");
    expect(result.failureKind).toBe("context_limit");
  });

  it("captures provider thinking snapshots when no thinking deltas were emitted", async () => {
    const events = [];
    const result = await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      effort: "high",
      messages: [{ role: "user", content: "hello" }],
      ...setupFauxRuntime([thinkingMessage("Reviewed the available tools.", "Done.")]),
      onEvent: (event) => events.push(event),
    });

    expect(result.thinking).toBe("Reviewed the available tools.");
    expect(result.text).toBe("Done.");
    expect(events.some((event) => event.type === "assistant" && event.message?.content?.[0]?.type === "thinking")).toBe(true);
  });

  it("does not duplicate text_end snapshots after text deltas", async () => {
    const events = [];
    const result = await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      effort: "medium",
      messages: [{ role: "user", content: "hello" }],
      ...setupFauxRuntime([textMessage("Hello once.")]),
      onEvent: (event) => events.push(event),
    });

    const textEvents = events.filter((event) => event.type === "assistant" && event.message?.content?.[0]?.type === "text");
    expect(result.text).toBe("Hello once.");
    expect(textEvents.map((event) => event.message.content[0].text).join("")).toBe("Hello once.");
  });

  it("runs custom provider pi:<provider>: references through the same pi runtime", async () => {
    const modelRef = createCustomProviderModel();
    const result = await generateResponse("sys", {
      db,
      dataDir,
      model: resolveModel(modelRef),
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      ...setupFauxRuntime([textMessage("Hello from custom provider")]),
    });

    expect(result).toMatchObject({ sdk: "pi", model: modelRef, text: "Hello from custom provider" });
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  });

  it("returns an error field when a custom provider is missing", async () => {
    const result = await generateResponse("sys", {
      db,
      dataDir,
      model: resolveModel("pi:bad-id:some-model"),
      effort: "low",
      messages: [{ role: "user", content: "hi" }],
      ...setupFauxRuntime([textMessage("unused")]),
    });

    expect(result.sdk).toBe("pi");
    expect(result.error).toMatch(/provider not found/);
  });

  it("supports pi:openai-codex references without the legacy Codex CLI path", async () => {
    const result = await generateResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      ...setupFauxRuntime([textMessage("Codex via pi")]),
    });

    expect(result).toMatchObject({ sdk: "pi", model: "pi:openai-codex:gpt-5.5", text: "Codex via pi" });
  });

  it("supports explicit pi:<provider>:<model> references", async () => {
    const model = resolveModel("pi:google:gemini-2.5-pro");
    expect(model).toMatchObject({ sdk: "pi", provider: "google", model: "gemini-2.5-pro" });

    const result = await generateResponse("sys", {
      model,
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      ...setupFauxRuntime([textMessage("Gemini via pi")]),
    });

    expect(result).toMatchObject({ sdk: "pi", model: "pi:google:gemini-2.5-pro", text: "Gemini via pi" });
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
      model: resolveModel("pi:openai:gpt-5.5"),
      effort: "medium",
      messages: [{ role: "user", content: "hi" }],
      outputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["schema"],
        properties: { schema: { type: "string" } },
      },
      ...setupFauxRuntime([structuredOutputMessage(worklabResult)]),
    });

    expect(result.structuredResult).toMatchObject(worklabResult);
    const extracted = extractWorklabResult(result.structuredResult ?? result.events);
    expect(extracted.ok).toBe(true);
    expect(extracted.result).toMatchObject(worklabResult);
    expect(result.events.some((event) => event.type === "assistant" && event.message?.content?.[0]?.name === "StructuredOutput")).toBe(true);
    expect(result.events.some((event) => event.type === "structured_output")).toBe(false);
  });
});

describe("resolveModel parse coverage", () => {
  it("claude: form", () => {
    expect(resolveModel("claude:claude-sonnet-4-6")).toMatchObject({ sdk: "claude", model: "claude-sonnet-4-6" });
  });

  it("pi:openai form", () => {
    expect(resolveModel("pi:openai:gpt-5.5")).toMatchObject({ sdk: "pi", provider: "openai", model: "gpt-5.5" });
  });

  it("pi: custom provider form preserves colons in model name", () => {
    expect(resolveModel("pi:abc123:gemma3:4b")).toMatchObject({ sdk: "pi", provider: "abc123", model: "gemma3:4b" });
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
        ...setupFauxRuntime([textMessage("unused")]),
      }),
    ).rejects.toThrow(/unsupported sdk/i);
  });
});
