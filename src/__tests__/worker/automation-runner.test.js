import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateResponse: vi.fn(),
  kbListPinned: vi.fn(),
  loadAgentCapabilities: vi.fn(),
  readAgentMemoryContext: vi.fn(),
  readSettings: vi.fn(),
  resolveModel: vi.fn(),
  getAgentByName: vi.fn(),
  getAutomationById: vi.fn(),
  buildAutomationSystemPrompt: vi.fn(),
}));

vi.mock("../../core/index.js", () => ({
  generateResponse: mocks.generateResponse,
  kbListPinned: mocks.kbListPinned,
  loadAgentCapabilities: mocks.loadAgentCapabilities,
  readAgentMemoryContext: mocks.readAgentMemoryContext,
  readSettings: mocks.readSettings,
  resolveModel: mocks.resolveModel,
}));

vi.mock("../../core/db/queries/agents.js", () => ({
  getAgentByName: mocks.getAgentByName,
}));

vi.mock("../../core/db/queries/automations.js", () => ({
  getAutomationById: mocks.getAutomationById,
}));

vi.mock("../../core/prompts/system-prompt.js", () => ({
  buildAutomationSystemPrompt: mocks.buildAutomationSystemPrompt,
}));

const { runAutomation } = await import("../../worker/automation-runner.js");

function context() {
  return {
    db: null,
    config: { dataDir: "/tmp/worklab-test", workspace: "/tmp/worklab-workspace" },
    ac: new AbortController(),
    emit: vi.fn(),
    agentName: "external-agent",
    runId: "run-1",
    automationId: "automation-1",
  };
}

describe("automation runner", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getAutomationById.mockReturnValue({ id: "automation-1", title: "External automation" });
    mocks.getAgentByName.mockReturnValue({
      name: "external-agent",
      sdk: "acp",
      model: "acp:external-profile",
      execution_mode: "acp",
    });
  });

  it("rejects ACP execution before loading Worklab-owned context or capabilities", async () => {
    await expect(runAutomation(context())).resolves.toEqual({
      kind: "automation",
      error: "external ACP agents currently support task runs only",
    });

    expect(mocks.readSettings).not.toHaveBeenCalled();
    expect(mocks.readAgentMemoryContext).not.toHaveBeenCalled();
    expect(mocks.loadAgentCapabilities).not.toHaveBeenCalled();
    expect(mocks.kbListPinned).not.toHaveBeenCalled();
    expect(mocks.buildAutomationSystemPrompt).not.toHaveBeenCalled();
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.generateResponse).not.toHaveBeenCalled();
  });
});
