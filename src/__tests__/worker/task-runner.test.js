import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateResponse: vi.fn(),
}));

vi.mock("../../core/index.js", () => ({
  buildTaskRunInput: vi.fn(() => ({
    task: { stage: "execute" },
    agent: { model: "codex:gpt-5.5", effort: "medium" },
    skills: [],
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
    systemPrompt: "system",
    messages: [],
  })),
  generateResponse: mocks.generateResponse,
  resolveModel: vi.fn((model) => ({ sdk: "codex", model: "gpt-5.5", reference: model })),
}));

const { runTask } = await import("../../worker/task-runner.js");

function taskContext() {
  return {
    db: null,
    config: { dataDir: "/tmp/worklab-test", workspace: "/tmp/worklab-workspace" },
    ac: new AbortController(),
    emit: vi.fn(),
    liveInput: null,
    agentName: "agent",
    runId: "run-1",
    taskId: "task-1",
    mode: "execute",
  };
}

describe("task runner result parsing", () => {
  beforeEach(() => {
    mocks.generateResponse.mockReset();
  });

  it("treats malformed worklab JSON as fatal instead of synthesizing advance", async () => {
    const malformed = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "delegate",
      summary: "split",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [{
        title: "child",
        instructions: "do it",
        acceptance_criteria: { invalid: true },
      }],
    };
    mocks.generateResponse.mockResolvedValue({
      text: JSON.stringify(malformed),
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(true);
    expect(result.worklabResult).toBeNull();
    expect(result.parsedResultWarningKind).toBe("worklab_result_validation");
    expect(result.parsedResultError).toContain("Invalid input");
  });

  it("keeps plain prose on the legacy unstructured fallback path", async () => {
    mocks.generateResponse.mockResolvedValue({
      text: "Plain final answer.",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(false);
    expect(result.parsedResultWarningKind).toBe("unstructured_result_fallback");
    expect(result.worklabResult).toMatchObject({
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      details: "Plain final answer.",
    });
  });
});
