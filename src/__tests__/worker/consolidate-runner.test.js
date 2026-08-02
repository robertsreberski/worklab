import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateResponse: vi.fn(),
  getAgentByName: vi.fn(),
  readAgentMemoryContent: vi.fn(() => "# Existing Memory\n"),
  readFullJournal: vi.fn(() => "## Journal\n- Remember Codex CLI mode.\n"),
  writeMemory: vi.fn(),
  buildConsolidationSystemPrompt: vi.fn(() => "consolidation system prompt"),
}));

vi.mock("../../core/index.js", () => ({
  generateResponse: mocks.generateResponse,
  readAgentMemoryContent: mocks.readAgentMemoryContent,
  readFullJournal: mocks.readFullJournal,
  resolveModel: vi.fn((model) => ({ sdk: "codex", model: "gpt-5.5", reference: model })),
  writeMemory: mocks.writeMemory,
}));

vi.mock("../../core/db/queries/agents.js", () => ({
  getAgentByName: mocks.getAgentByName,
}));

vi.mock("../../core/prompts/system-prompt.js", () => ({
  buildConsolidationSystemPrompt: mocks.buildConsolidationSystemPrompt,
}));

const { runConsolidate } = await import("../../worker/consolidate-runner.js");

function context() {
  return {
    db: null,
    config: { dataDir: "/tmp/worklab-test", workspace: "/tmp/worklab-workspace" },
    ac: new AbortController(),
    emit: vi.fn(),
    agentName: "codex-agent",
  };
}

describe("consolidate runner", () => {
  beforeEach(() => {
    mocks.generateResponse.mockReset();
    mocks.getAgentByName.mockReset();
    mocks.readAgentMemoryContent.mockClear();
    mocks.readFullJournal.mockClear();
    mocks.writeMemory.mockReset();
    mocks.buildConsolidationSystemPrompt.mockClear();
    mocks.getAgentByName.mockReturnValue({
      name: "codex-agent",
      display_name: "Codex Agent",
      sdk: "codex",
      model: "codex:gpt-5.5",
      effort: "xhigh",
      execution_mode: "cli",
      fast_mode: 0,
    });
    mocks.generateResponse.mockResolvedValue({
      text: "# New Memory\n- Codex CLI mode preserved.",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "codex:gpt-5.5",
      effort: "xhigh",
    });
    mocks.writeMemory.mockReturnValue("/tmp/worklab-test/agents/codex-agent/MEMORY.md");
  });

  it("passes the agent execution mode to the runtime", async () => {
    const result = await runConsolidate(context());

    expect(result.memoryWritten).toMatchObject({ agent: "codex-agent" });
    expect(mocks.generateResponse).toHaveBeenCalledWith(
      "consolidation system prompt",
      expect.objectContaining({
        model: { sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" },
        effort: "xhigh",
        executionMode: "cli",
        fastMode: false,
      }),
    );
  });

  it("rejects ACP consolidation before reading or replacing Worklab memory", async () => {
    mocks.getAgentByName.mockReturnValue({
      name: "codex-agent",
      display_name: "External Agent",
      sdk: "acp",
      model: "acp:external-profile",
      execution_mode: "acp",
    });

    await expect(runConsolidate(context())).resolves.toEqual({
      kind: "consolidate",
      error: "external ACP agents currently support task runs only",
    });
    expect(mocks.readAgentMemoryContent).not.toHaveBeenCalled();
    expect(mocks.readFullJournal).not.toHaveBeenCalled();
    expect(mocks.buildConsolidationSystemPrompt).not.toHaveBeenCalled();
    expect(mocks.generateResponse).not.toHaveBeenCalled();
    expect(mocks.writeMemory).not.toHaveBeenCalled();
  });
});
