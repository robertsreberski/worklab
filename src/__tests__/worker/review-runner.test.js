import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateResponse: vi.fn(),
}));

vi.mock("../../core/index.js", () => ({
  buildTaskRunInput: vi.fn(() => ({
    task: { stage: "review" },
    agent: { model: "pi:openai-codex:gpt-5.5", effort: "medium" },
    skills: [],
    skillDirs: [],
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
    systemPrompt: "system",
    messages: [],
  })),
  generateResponse: mocks.generateResponse,
  resolveModel: vi.fn((model) => ({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: model })),
}));

const { runReview } = await import("../../worker/review-runner.js");

function reviewContext() {
  return {
    db: null,
    config: { dataDir: "/tmp/worklab-test", workspace: "/tmp/worklab-workspace" },
    ac: new AbortController(),
    emit: vi.fn(),
    liveInput: null,
    agentName: "reviewer",
    runId: "run-1",
    taskId: "task-1",
  };
}

const baseStructured = {
  schema: "worklab.v2",
  stage: "review",
  decision: "approve",
  summary: "Looks good.",
  details: "Approved details.",
  final_text: "Approved.",
  artifacts: {},
  blocking_issues: [],
  pending_actions: [],
  subtasks: [],
};

describe("review runner result parsing", () => {
  beforeEach(() => {
    mocks.generateResponse.mockReset();
  });

  it("derives verdict + worklabResult from provider structuredResult", async () => {
    mocks.generateResponse.mockResolvedValue({
      text: "ignored noise",
      structuredResult: baseStructured,
      structuredResultSource: "structured_output",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runReview(reviewContext());

    expect(result.verdict).toBe("APPROVE");
    expect(result.worklabResult).toMatchObject({ decision: "approve", summary: "Looks good." });
    expect(result.parsedResultFatal).toBe(false);
  });

  it("flags structuredResult validation failures as fatal review parse errors", async () => {
    const malformed = { ...baseStructured, decision: "not-a-real-decision" };
    mocks.generateResponse.mockResolvedValue({
      text: "VERDICT: APPROVE\nWould normally synthesize.",
      structuredResult: malformed,
      structuredResultSource: "structured_output",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runReview(reviewContext());

    expect(result.parsedResultFatal).toBe(true);
    expect(result.worklabResult).toBeNull();
    expect(result.verdict).toBeNull();
    expect(result.parsedResultWarningKind).toBe("worklab_result_validation");
  });

  it("scans response.events for embedded reviewer worklab_result", async () => {
    const rejected = { ...baseStructured, decision: "reject", summary: "Rework needed.", final_text: "Rejected." };
    mocks.generateResponse.mockResolvedValue({
      text: "raw verdict prose",
      events: [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "StructuredOutput", input: rejected }] },
        },
      ],
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runReview(reviewContext());

    expect(result.verdict).toBe("REJECT");
    expect(result.worklabResult).toMatchObject({ decision: "reject", summary: "Rework needed." });
  });

  it("falls back to the legacy verdict-text parser when the provider returns no structured payload", async () => {
    mocks.generateResponse.mockResolvedValue({
      text: "VERDICT: APPROVE\nLooks correct.",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runReview(reviewContext());

    expect(result.verdict).toBe("APPROVE");
    expect(result.worklabResult).toMatchObject({ decision: "approve" });
    expect(result.parsedResultFatal).toBe(false);
  });
});
