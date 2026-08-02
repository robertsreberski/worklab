import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateResponse: vi.fn(),
  agentSdk: "pi",
}));

vi.mock("../../core/index.js", () => ({
  buildTaskRunInput: vi.fn(() => ({
    task: { stage: "execute" },
    agent: { sdk: mocks.agentSdk, model: "pi:openai-codex:gpt-5.5", effort: "medium" },
    skills: [],
    mcpServers: {},
    allowedTools: [],
    disallowedTools: [],
    systemPrompt: "system",
    messages: [],
  })),
  createWorklabAcpProfileResolver: vi.fn(() => vi.fn()),
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
    mocks.agentSdk = "pi";
  });

  it("rejects delegation results from ACP agents", async () => {
    mocks.agentSdk = "acp";
    mocks.generateResponse.mockResolvedValue({
      text: JSON.stringify({
        schema: "worklab.v2",
        stage: "execute",
        decision: "delegate",
        summary: "Create an unauthorized child.",
        details: "",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        subtasks: [{ title: "Unauthorized child", instructions: "Do work." }],
      }),
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "acp:external",
      effort: "medium",
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(true);
    expect(result.worklabResult).toBeNull();
    expect(result.parsedResultError).toBe("delegation is unavailable for this agent runtime");
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

  it("preserves provider diagnostics on generated task errors", async () => {
    mocks.generateResponse.mockResolvedValue({
      error: "fetch failed",
      failureKind: "provider_unavailable",
      errorDetails: { pi_transport: "sse" },
      diagnostics: { pi_transport: "sse", turn_count: 19, tool_results_seen: 45 },
      providerSessionId: "provider-session-1",
      runtimeWarnings: [{ warning_kind: "runtime", message: "warn" }],
    });

    const result = await runTask(taskContext());

    expect(result).toMatchObject({
      kind: "task",
      error: "fetch failed",
      failureKind: "provider_unavailable",
      errorDetails: { pi_transport: "sse" },
      diagnostics: { pi_transport: "sse", turn_count: 19, tool_results_seen: 45 },
      providerSessionId: "provider-session-1",
      runtimeWarnings: [{ warning_kind: "runtime", message: "warn" }],
    });
  });

  it("preserves provider diagnostics on generated task parse failures", async () => {
    mocks.generateResponse.mockResolvedValue({
      text: "",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
      diagnostics: {
        last_tool_name: "journal_summary",
        structured_output_finalization_retry_attempts: 1,
      },
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(true);
    expect(result.parsedResultError).toBe("missing final output");
    expect(result.diagnostics).toMatchObject({
      last_tool_name: "journal_summary",
      structured_output_finalization_retry_attempts: 1,
    });
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

  it("normalizes structured artifact entries from provider structuredResult", async () => {
    mocks.generateResponse.mockResolvedValue({
      text: "ignored",
      structuredResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "advance",
        summary: "Structured notes are in artifacts.audit_notes.",
        details: "",
        final_text: "Read artifacts.audit_notes.",
        artifacts: {},
        artifact_entries: [{ key: "audit_notes", content: "Audit notes.", description: "", media_type: "text/markdown" }],
        blocking_issues: [],
        pending_actions: [],
        subtasks: [],
      },
      structuredResultSource: "structured_output",
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(false);
    expect(result.worklabResult.artifacts.audit_notes).toBe("Audit notes.");
  });

  it("treats claimed but missing artifacts as fatal", async () => {
    mocks.generateResponse.mockResolvedValue({
      text: "ignored",
      structuredResult: {
        schema: "worklab.v2",
        stage: "execute",
        decision: "advance",
        summary: "Structured notes are in artifacts.audit_notes.",
        details: "",
        final_text: "Read artifacts.audit_notes.",
        artifacts: {},
        blocking_issues: [],
        pending_actions: [],
        subtasks: [],
      },
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
    expect(result.parsedResultError).toContain("artifacts.audit_notes");
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

  it("does not treat mid-run standalone worklab JSON as the terminal result", async () => {
    const progress = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Starting.",
      details: "",
      final_text: "",
      artifacts: {},
      artifact_entries: [],
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
      parent_review_policy: null,
      memory_candidates: [],
      verification_evidence: [],
    };
    mocks.generateResponse.mockResolvedValue({
      text: "",
      events: [
        { type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(progress) }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "readme", is_error: false }] } },
      ],
      usage: {},
      durationMs: 1,
      numTurns: 1,
      model: "pi:openai-codex:gpt-5.5",
      effort: "medium",
    });

    const result = await runTask(taskContext());

    expect(result.parsedResultFatal).toBe(true);
    expect(result.parsedResultError).toBe("missing final output");
    expect(result.worklabResult).toBeNull();
  });
});
