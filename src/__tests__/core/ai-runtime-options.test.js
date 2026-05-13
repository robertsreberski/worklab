import { afterEach, describe, expect, it, vi } from "vitest";

const mockRun = vi.fn();

vi.mock("@worklab/agent-runtime", () => ({
  createRuntime: () => ({ run: mockRun }),
}));

const { generateResponse, resolveModel } = await import("../../core/ai.js");

afterEach(() => {
  mockRun.mockReset();
  delete process.env.WORKLAB_CODEX_THREAD_START_TIMEOUT_MS;
  delete process.env.WORKLAB_CODEX_THREAD_START_ATTEMPTS;
  delete process.env.WORKLAB_CODEX_THREAD_START_BACKOFF_MS;
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
});
