import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateResponse: vi.fn(),
}));

vi.mock("../../core/index.js", () => ({
  buildTaskRunInput: vi.fn(() => ({
    task: { stage: "execute" },
    agent: { model: "pi:openai-codex:gpt-5.5", effort: "medium" },
    skills: [],
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
    systemPrompt: "system",
    messages: [],
  })),
  generateResponse: mocks.generateResponse,
  resolveModel: vi.fn((model) => ({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: model })),
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
      model: "pi:openai-codex:gpt-5.5",
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
      model: "pi:openai-codex:gpt-5.5",
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

  it("returns provider session ids from generated task results", async () => {
    mocks.generateResponse.mockResolvedValue({
      text: "Plain final answer.",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
      providerSessionId: "provider-session-1",
    });

    const result = await runTask(taskContext());

    expect(result.providerSessionId).toBe("provider-session-1");
  });

  it("uses provider structuredResult when present, marking the run structured", async () => {
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Done.",
      details: "Implemented feature.",
      final_text: "Implemented.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    mocks.generateResponse.mockResolvedValue({
      text: "noisy text the host should ignore",
      structuredResult: structured,
      structuredResultSource: "structured_output",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(false);
    expect(result.worklabResult).toMatchObject({
      decision: "advance",
      summary: "Done.",
      details: "Implemented feature.",
    });
  });

  it("treats a malformed structuredResult as fatal without falling back to text", async () => {
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
      text: "Plain final answer that would normally synthesize.",
      structuredResult: malformed,
      structuredResultSource: "structured_output",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(true);
    expect(result.worklabResult).toBeNull();
  });

  it("scans response.events for an embedded worklab_result when no structuredResult is set", async () => {
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "From events.",
      details: "Recovered from event scan.",
      final_text: "Recovered.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    mocks.generateResponse.mockResolvedValue({
      text: "ignored prose",
      events: [
        { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } },
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "StructuredOutput", input: structured }] },
        },
      ],
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(false);
    expect(result.worklabResult).toMatchObject({
      summary: "From events.",
      details: "Recovered from event scan.",
    });
  });
});
