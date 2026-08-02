import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildTaskRunInput: vi.fn(),
  generateResponse: vi.fn(),
  resolveAcpProfile: vi.fn(),
}));

vi.mock("../../core/index.js", () => ({
  buildTaskRunInput: mocks.buildTaskRunInput,
  createWorklabAcpProfileResolver: vi.fn(() => mocks.resolveAcpProfile),
  generateResponse: mocks.generateResponse,
  resolveModel: vi.fn((model) => ({
    sdk: model.startsWith("acp:") ? "acp" : "pi",
    model: model.split(":").at(-1),
    reference: model,
  })),
}));

const { runTaskAgentTurn } = await import("../../worker/agent-turn.js");

function input(agent) {
  return {
    agent,
    skills: [],
    skillDirs: [],
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
    systemPrompt: "",
    messages: [{ role: "user", content: [{ type: "text", text: "Do the task" }] }],
    nativeSubagents: null,
  };
}

function context(overrides = {}) {
  return {
    db: { name: "db" },
    config: { dataDir: "/tmp/worklab-data", workspace: "/tmp/worklab-workspace" },
    ac: new AbortController(),
    emit: vi.fn(),
    liveInput: null,
    approvalChannel: null,
    acpInteractionChannel: null,
    agentName: "external",
    runId: "run-1",
    taskId: "task-1",
    ...overrides,
  };
}

describe("runTaskAgentTurn ACP wiring", () => {
  beforeEach(() => {
    mocks.buildTaskRunInput.mockReset();
    mocks.generateResponse.mockReset();
    mocks.resolveAcpProfile.mockReset();
    mocks.generateResponse.mockResolvedValue({ text: "done", error: null });
  });

  it("passes the private profile resolver and interaction channel only to ACP runs", async () => {
    mocks.buildTaskRunInput.mockReturnValue(input({
      sdk: "acp",
      model: "acp:11111111-1111-4111-8111-111111111111",
      execution_mode: "acp",
      effort: "medium",
    }));
    const acpInteractionChannel = { request: vi.fn(async () => ({ action: "accept" })) };
    const ctx = context({ acpInteractionChannel });

    const turn = await runTaskAgentTurn(ctx, { kind: "task", mode: "execute" });

    expect(turn.result).toMatchObject({ text: "done" });
    const runtimeOptions = mocks.generateResponse.mock.calls[0][1];
    expect(runtimeOptions.resolveAcpProfile).toBe(mocks.resolveAcpProfile);
    expect(runtimeOptions.onAcpInteractionRequest).toEqual(expect.any(Function));
    const request = { kind: "elicitation", profileId: "profile-1", payload: { mode: "form" } };
    const callbackContext = { requestId: "form-1" };
    await expect(runtimeOptions.onAcpInteractionRequest(request, callbackContext))
      .resolves.toEqual({ action: "accept" });
    expect(acpInteractionChannel.request).toHaveBeenCalledWith(request, callbackContext);

    mocks.buildTaskRunInput.mockReturnValue(input({
      sdk: "pi",
      model: "pi:openai:gpt-5",
      execution_mode: "sdk",
      effort: "medium",
    }));
    await runTaskAgentTurn(context(), { kind: "task", mode: "execute" });
    const nativeOptions = mocks.generateResponse.mock.calls[1][1];
    expect(nativeOptions).not.toHaveProperty("resolveAcpProfile");
    expect(nativeOptions).not.toHaveProperty("onAcpInteractionRequest");
  });

  it("fails closed when an ACP worker has no interaction channel", async () => {
    mocks.buildTaskRunInput.mockReturnValue(input({
      sdk: "acp",
      model: "acp:11111111-1111-4111-8111-111111111111",
      execution_mode: "acp",
    }));
    await runTaskAgentTurn(context(), { kind: "task", mode: "execute" });
    const callback = mocks.generateResponse.mock.calls[0][1].onAcpInteractionRequest;

    await expect(callback({ kind: "permission" }, {}))
      .resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(callback({ kind: "elicitation" }, {}))
      .resolves.toEqual({ action: "cancel" });
  });
});
