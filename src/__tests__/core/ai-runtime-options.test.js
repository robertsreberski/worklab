import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const mockRun = vi.fn();
const mockCreateRuntime = vi.fn(() => ({ run: mockRun }));
const mockCreateRouterRuntime = vi.fn(() => ({ run: mockRun }));

vi.mock("@mono-agent/agent-runtime", () => ({
  createRuntime: mockCreateRuntime,
  createRouterRuntime: mockCreateRouterRuntime,
  createMetricsObserver: () => ({ recordEvent: () => {}, snapshot: () => ({}) }),
}));

const { generateResponse, resolveModel } = await import("../../core/ai.js");

afterEach(() => {
  mockRun.mockReset();
  mockCreateRuntime.mockClear();
  mockCreateRouterRuntime.mockClear();
  delete process.env.WORKLAB_CODEX_THREAD_START_TIMEOUT_MS;
  delete process.env.WORKLAB_CODEX_THREAD_START_ATTEMPTS;
  delete process.env.WORKLAB_CODEX_THREAD_START_BACKOFF_MS;
  delete process.env.WORKLAB_PI_CODEX_TRANSPORT;
});

describe("generateResponse Codex runtime options", () => {
  it("passes thread/start hardening overrides from the environment", async () => {
    process.env.WORKLAB_CODEX_THREAD_START_TIMEOUT_MS = "90000";
    process.env.WORKLAB_CODEX_THREAD_START_ATTEMPTS = "3";
    process.env.WORKLAB_CODEX_THREAD_START_BACKOFF_MS = "1000";
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      executionMode: "cli",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockRun).toHaveBeenCalledWith("sys", expect.objectContaining({
      codexThreadStartTimeoutMs: "90000",
      codexThreadStartAttempts: "3",
      codexThreadStartBackoffMs: "1000",
    }));
  });

  it("lets explicit thread/start hardening options win over environment defaults", async () => {
    process.env.WORKLAB_CODEX_THREAD_START_TIMEOUT_MS = "90000";
    process.env.WORKLAB_CODEX_THREAD_START_ATTEMPTS = "3";
    process.env.WORKLAB_CODEX_THREAD_START_BACKOFF_MS = "1000";
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      executionMode: "cli",
      messages: [{ role: "user", content: "hi" }],
      codexThreadStartTimeoutMs: 120000,
      codexThreadStartAttempts: 2,
      codexThreadStartBackoffMs: 500,
    });

    expect(mockRun).toHaveBeenCalledWith("sys", expect.objectContaining({
      codexThreadStartTimeoutMs: 120000,
      codexThreadStartAttempts: 2,
      codexThreadStartBackoffMs: 500,
    }));
  });

  it("passes the saved Pi Codex transport setting to the runtime", async () => {
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      settings: { agent_pi_codex_transport: "websocket-cached" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockRun).toHaveBeenCalledWith("sys", expect.objectContaining({
      piCodexTransport: "websocket-cached",
    }));
  });

  it("preserves Worklab runtime brand when creating the mono runtime", async () => {
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      executionMode: "cli",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockCreateRuntime).toHaveBeenCalledWith(expect.objectContaining({
      runtimeBrand: expect.objectContaining({
        schemaPrefix: "worklab",
        mcpClientName: "worklab",
        tempdirPrefix: "worklab-cli-",
        providerModelPrefix: "worklab",
        doctorCommand: "worklab doctor",
        serviceName: "worklab",
        clientInfoTitle: "Worklab",
      }),
    }));
  });

  it("lets explicit and environment Pi Codex transport overrides win over settings", async () => {
    process.env.WORKLAB_PI_CODEX_TRANSPORT = "websocket";
    mockRun.mockResolvedValue({ text: "ok" });

    await generateResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      settings: { agent_pi_codex_transport: "websocket-cached" },
      messages: [{ role: "user", content: "hi" }],
    });

    await generateResponse("sys", {
      model: resolveModel("pi:openai-codex:gpt-5.5"),
      settings: { agent_pi_codex_transport: "websocket-cached" },
      piCodexTransport: "sse",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockRun).toHaveBeenNthCalledWith(1, "sys", expect.objectContaining({
      piCodexTransport: "websocket",
    }));
    expect(mockRun).toHaveBeenNthCalledWith(2, "sys", expect.objectContaining({
      piCodexTransport: "sse",
    }));
  });

  it("threads the skills root without opting into new retry or environment surfaces", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    const skillsRoot = resolve("/tmp/worklab-data/skills");
    const skills = [{
      name: "reader",
      trigger: "when repository context is needed",
      enabled: true,
      assetsPath: resolve(skillsRoot, "reader"),
    }];

    await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      messages: [{ role: "user", content: "hi" }],
      skills,
      fallbackChain: [{ sdk: "claude", model: "claude-sonnet-4-6" }],
    });

    const routerOptions = mockCreateRouterRuntime.mock.calls[0][0];
    expect(routerOptions).not.toHaveProperty("retry");
    expect(routerOptions.chain).toEqual([
      { sdk: "pi", provider: "openai", model: "gpt-5.5" },
      { sdk: "claude", model: "claude-sonnet-4-6" },
    ]);
    expect(routerOptions.chain.every((entry) => !Object.hasOwn(entry, "attempts"))).toBe(true);

    const runOptions = mockRun.mock.calls[0][1];
    expect(runOptions).toMatchObject({
      skills,
      skillsRoot,
      skillDirs: [skillsRoot],
    });
    expect(runOptions).not.toHaveProperty("toolEnvironment");
    // Team-roster subagents are gone; the roster now only drives durable
    // delegation into child tasks.
    expect(runOptions).not.toHaveProperty("nativeSubagents");
  });

  // Native subagents come from the runtime's own on-disk profiles, so each
  // backend gets whatever lets it find them — and only that.
  it("opts pi into the in-process Agent built-in, which has no on-disk profiles", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    await generateResponse("sys", {
      model: resolveModel("pi:openai:gpt-5.5"),
      messages: [{ role: "user", content: "hi" }],
    });

    const runOptions = mockRun.mock.calls[0][1];
    expect(runOptions.subagents).toEqual({ inline: { enabled: true }, maxConcurrent: 3, maxPerTurn: 10 });
    // Pi has no filesystem profile concept, so setting sources would be noise.
    expect(runOptions).not.toHaveProperty("settingSources");
  });

  it("lets the Claude SDK read the same on-disk settings the Claude CLI already reads", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    await generateResponse("sys", {
      model: resolveModel("claude:claude-sonnet-4-6"),
      messages: [{ role: "user", content: "hi" }],
    });

    const runOptions = mockRun.mock.calls[0][1];
    expect(runOptions.settingSources).toEqual(["user", "project", "local"]);
    // Claude's subagents are native; the in-process built-in would duplicate them.
    expect(runOptions).not.toHaveProperty("subagents");
  });

  it("leaves codex on its own native surface", async () => {
    mockRun.mockResolvedValue({ text: "ok" });
    await generateResponse("sys", {
      model: resolveModel("codex:gpt-5.5"),
      messages: [{ role: "user", content: "hi" }],
      executionMode: "cli",
    });

    const runOptions = mockRun.mock.calls[0][1];
    expect(runOptions).not.toHaveProperty("subagents");
    expect(runOptions).not.toHaveProperty("settingSources");
  });
});
