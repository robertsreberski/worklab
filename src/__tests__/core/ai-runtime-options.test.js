import { afterEach, describe, expect, it, vi } from "vitest";

const mockRun = vi.fn();

vi.mock("@worklab-ai/agent-runtime", () => ({
  createRuntime: () => ({ run: mockRun }),
  createRouterRuntime: () => ({ run: mockRun }),
  createMetricsObserver: () => ({ recordEvent: () => {}, snapshot: () => ({}) }),
}));

const { generateResponse, resolveModel } = await import("../../core/ai.js");

afterEach(() => {
  mockRun.mockReset();
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
});
