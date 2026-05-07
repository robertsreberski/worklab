import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args) => mockQuery(...args),
}));

const { generateClaudeResponse } = await import("@worklab/agent-runtime/ai/providers/claude-sdk.js");
const { createLiveInputQueue, formatLiveInputGuidance } = await import("../../core/live-input.js");
const { createToolOutputSink } = await import("../../core/tool-artifacts.js");

function mockStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    return: vi.fn(async () => ({ done: true })),
  };
}

function mockStreamWithThrow(events, error) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      throw error;
    },
    return: vi.fn(async () => ({ done: true })),
  };
}

function mockHangingStreamAfter(events) {
  const returnSpy = vi.fn(async () => ({ done: true }));
  return {
    return: returnSpy,
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) return { value: events[index++], done: false };
          return new Promise(() => {});
        },
        return: returnSpy,
      };
    },
  };
}

function hookMatches(matcher, toolName) {
  if (!matcher || matcher === "*") return true;
  return String(matcher).split("|").includes(toolName);
}

async function runSdkHooks(options, eventName, input, toolUseID) {
  const groups = options?.hooks?.[eventName] || [];
  const signal = new AbortController().signal;
  const outputs = [];
  for (const group of groups) {
    if (!hookMatches(group.matcher, input.tool_name)) continue;
    for (const hook of group.hooks || []) {
      outputs.push(await hook(input, toolUseID, { signal }));
    }
  }
  return outputs;
}

function hookInput(eventName, dir, toolName, toolInput, extra = {}) {
  return {
    session_id: "session-1",
    transcript_path: join(dir, "transcript.jsonl"),
    cwd: dir,
    hook_event_name: eventName,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_edit",
    ...extra,
  };
}

function mockQueryWithHookedStream(run, events = [{ type: "result", usage: {}, duration_ms: 0, num_turns: 1 }]) {
  mockQuery.mockImplementation((params = {}) => ({
    async *[Symbol.asyncIterator]() {
      await run(params.options);
      for (const event of events) yield event;
    },
    return: vi.fn(async () => ({ done: true })),
  }));
}

describe("generateClaudeResponse", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    delete process.env.WORKLAB_PROVIDER_SESSION_ID;
    delete process.env.WORKLAB_QA_OUTPUT_DIR;
  });

  it("streams events to onEvent, collects final text", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "result", usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 100, num_turns: 1 },
    ]));
    const events = [];
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: (e) => events.push(e),
    });
    expect(r.text).toBe("hello");
    expect(r.usage.input_tokens).toBe(10);
    expect(r.usage.output_tokens).toBe(5);
    expect(r.durationMs).toBe(100);
    expect(r.numTurns).toBe(1);
    expect(events.length).toBe(2);
  });

  it("prefers the SDK result text over intermediate assistant narration", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "I will gather the data." }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Now compiling." }] } },
      {
        type: "result",
        result: "# Report\n\nFinal delivered answer.",
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 2,
      },
    ]));
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    expect(r.text).toBe("# Report\n\nFinal delivered answer.");
  });

  it("returns raw assistant text and the result-event content without worklab-specific parsing", async () => {
    const structured = {
      schema: "worklab.v2",
      stage: "review",
      decision: "approve",
      summary: "Review passed.",
      details: "Verified output.",
      final_text: "Approved for release.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      subtasks: [],
    };
    const fenced = `\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``;
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "Reviewing." }] } },
      {
        type: "result",
        result: fenced,
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 2,
      },
    ]));

    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });

    expect(r.structuredResult).toBeUndefined();
    expect(r.text).toBe(fenced);
    expect(r.events.some((event) => event.type === "result" && event.result === fenced)).toBe(true);
  });

  it("passes structured output schemas through Claude outputFormat and reads structured_output", async () => {
    const structured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Done.",
      details: "Implemented.",
      final_text: "Implemented successfully.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
      parent_review_policy: "default",
    };
    const schema = {
      type: "object",
      properties: { schema: { type: "string", const: "worklab.v2" } },
      required: ["schema"],
    };
    mockQuery.mockReturnValue(mockStream([
      {
        type: "result",
        subtype: "success",
        structured_output: structured,
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 1,
        session_id: "claude-session-structured",
      },
    ]));
    const events = [];

    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      outputSchema: schema,
      onEvent: (event) => events.push(event),
    });

    expect(mockQuery.mock.calls[0][0].options.outputFormat).toEqual({
      type: "json_schema",
      schema,
    });
    expect(r.structuredResult).toEqual(structured);
    expect(r.structuredResultSource).toBe("structured_output");
    expect(r.providerSessionId).toBe("claude-session-structured");
    expect(events).toContainEqual({
      type: "structured_output",
      source: "claude_sdk_output_format",
      value: structured,
    });
  });

  it("passes native teammate subagents to the Claude SDK Task surface", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "result", subtype: "success", result: "done", usage: {}, duration_ms: 1, num_turns: 1 },
    ]));

    await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      allowedTools: ["Read"],
      nativeSubagents: {
        provider: "claude",
        teammates: [{
          name: "helper",
          description: "Reads focused code paths.",
          helperSystemPrompt: "You are the helper.",
          allowedTools: ["Read", "Grep"],
          disallowedTools: ["Edit"],
          modelRef: "claude:claude-opus-4-7",
          mcpServers: { mock: { command: "node", args: ["mock.js"] } },
        }],
      },
      onEvent: () => {},
    });

    const options = mockQuery.mock.calls[0][0].options;
    expect(options.allowedTools).toEqual(["Read", "Task"]);
    expect(options.agents).toEqual({
      helper: {
        description: "Reads focused code paths.",
        prompt: "You are the helper.",
        tools: ["Read", "Grep"],
        disallowedTools: ["Edit"],
        model: "opus",
        mcpServers: [{ mock: { command: "node", args: ["mock.js"] } }],
      },
    });
  });

  it("uses a prior provider session to resume Claude and returns the current session id", async () => {
    mockQuery.mockReturnValue(mockStream([
      {
        type: "result",
        subtype: "success",
        result: "resumed",
        usage: {},
        duration_ms: 1,
        num_turns: 1,
        session_id: "claude-session-prev",
      },
    ]));

    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "continue" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      providerSessionId: "claude-session-prev",
      onEvent: () => {},
    });

    expect(mockQuery.mock.calls[0][0].options.resume).toBe("claude-session-prev");
    expect(r.providerSessionId).toBe("claude-session-prev");
  });

  it("captures fresh Claude session ids from stream events", async () => {
    mockQuery.mockReturnValue(mockStream([
      {
        type: "assistant",
        session_id: "claude-session-new",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "result",
        subtype: "success",
        usage: {},
        duration_ms: 1,
        num_turns: 1,
        session_id: "claude-session-new",
      },
    ]));

    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "start" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });

    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty("resume");
    expect(r.providerSessionId).toBe("claude-session-new");
  });

  it("does not pass maxTurns by default", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    const call = mockQuery.mock.calls[0][0];
    expect(call.options).not.toHaveProperty("maxTurns");
  });

  it("treats max-turn result subtypes as provider errors", async () => {
    mockQuery.mockReturnValue(mockStream([
      {
        type: "assistant",
        session_id: "claude-session-max-turns",
        message: { content: [{ type: "text", text: "Working..." }] },
      },
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 30,
        session_id: "claude-session-max-turns",
      },
    ]));
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-opus-4-7" },
      effort: "high",
      onEvent: () => {},
    });
    expect(r.error).toBe("Claude stopped before final output: max turns reached");
    expect(r.failureKind).toBe("usage_limit");
    expect(r.text).toBe("Working...");
    expect(r.providerSessionId).toBe("claude-session-max-turns");
    expect(r.errorDetails).toMatchObject({
      claude_error_subtype: "error_max_turns",
      max_turns_hit: true,
      had_partial_progress: true,
      tool_results_seen: 0,
      turn_count: 30,
      provider_session_id: "claude-session-max-turns",
    });
    expect(r.errorDetails.last_text_excerpt).toBe("Working...");
  });

  it("treats errored result events as provider errors", async () => {
    mockQuery.mockReturnValue(mockStream([
      {
        type: "result",
        subtype: "error_provider",
        is_error: true,
        error: { message: "provider failed" },
      },
    ]));
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    expect(r.error).toBe("Claude result error (provider): provider failed");
    expect(r.failureKind).toBe("provider_unavailable");
  });

  it("preserves recovered StructuredOutput when Claude exhausts schema retries after the tool call", async () => {
    const malformedStructured = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Delivered UI audit.",
      details: "Scope and findings.</details>\n<parameter name=\"final_text\">Audit complete.</final_text>\n<parameter name=\"artifacts\">{\"kb_slug\":\"ui-audit-activity-workspace\"}</parameter>",
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
      parent_review_policy: "default",
    };
    mockQuery.mockReturnValue(mockStream([
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu_structured",
            name: "StructuredOutput",
            input: malformedStructured,
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_structured",
            is_error: true,
            content: "Output does not match required schema: root: must have required property 'artifacts'",
          }],
        },
      },
      {
        type: "result",
        subtype: "error_max_structured_output_retries",
        is_error: false,
        errors: ["Failed to provide valid structured output after 5 attempts"],
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 27,
        session_id: "claude-session-structured-retries",
      },
    ]));

    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-opus-4-7" },
      effort: "high",
      onEvent: () => {},
    });

    // The package no longer recovers worklab_result from rejected StructuredOutput
    // tool_use blocks — that's now the host's job (see resultFromResponseOrFallback
    // in src/worker/task-runner.js, which scans response.events). The provider
    // surfaces the error and preserves the events so the host can recover.
    expect(r.error).toBe("Claude result error (max structured output retries): Failed to provide valid structured output after 5 attempts");
    expect(r.failureKind).toBe("invalid_result");
    expect(r.events.some((event) =>
      event.type === "assistant"
      && event.message?.content?.some((part) => part.type === "tool_use" && part.name === "StructuredOutput")
    )).toBe(true);
  });

  it("classifies unrecoverable Claude structured-output retry exhaustion as invalid_result", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "I have the answer but cannot format it." }] } },
      {
        type: "result",
        subtype: "error_max_structured_output_retries",
        is_error: false,
        errors: ["Failed to provide valid structured output after 5 attempts"],
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 27,
        session_id: "claude-session-structured-failed",
      },
    ]));

    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-opus-4-7" },
      effort: "high",
      onEvent: () => {},
    });

    expect(r.error).toBe("Claude result error (max structured output retries): Failed to provide valid structured output after 5 attempts");
    expect(r.failureKind).toBe("invalid_result");
    expect(r.errorDetails).toMatchObject({
      claude_error_subtype: "error_max_structured_output_retries",
      structured_output_retry_exhausted: true,
      provider_session_id: "claude-session-structured-failed",
      turn_count: 27,
    });
  });

  it("preserves successful final output when Claude emits a trailing execution error", async () => {
    mockQuery.mockReturnValue(mockStreamWithThrow([
      { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "# Report\n\nFinal delivered answer.",
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 2,
      },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 0,
        num_turns: 0,
        errors: [
          "MaxFileReadTokenExceededError: File content exceeds maximum allowed tokens",
        ],
      },
    ], new Error("Claude Code process exited with code 1")));

    const events = [];
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-opus-4-7" },
      effort: "high",
      onEvent: (event) => events.push(event),
    });

    expect(r.error).toBeNull();
    expect(r.failureKind).toBeNull();
    expect(r.text).toBe("# Report\n\nFinal delivered answer.");
    expect(r.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(typeof r.usage.cost_usd).toBe("number");
    expect(r.durationMs).toBe(100);
    expect(r.numTurns).toBe(2);
    expect(r.runtimeWarnings).toHaveLength(1);
    expect(r.runtimeWarnings[0]).toMatchObject({
      warning_kind: "claude_post_success_error",
    });
    expect(r.runtimeWarnings[0].message).toContain("MaxFileReadTokenExceededError");
    expect(events).toHaveLength(3);
  });

  it("treats SDK iterator failures before a successful result as provider errors", async () => {
    mockQuery.mockReturnValue(mockStreamWithThrow([
      { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
    ], new Error("Claude Code process exited with code 1")));

    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });

    expect(r.error).toBe("Claude Code process exited with code 1");
    expect(r.failureKind).toBe("provider_unavailable");
    expect(r.text).toBe("partial");
    expect(r.runtimeWarnings).toEqual([]);
  });

  it("maps effort: low → thinking disabled", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "low",
      onEvent: () => {},
    });
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({ type: "disabled" });
  });

  it("maps effort: high → thinking adaptive + effort option", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-opus-4-7" },
      effort: "high",
      onEvent: () => {},
    });
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.thinking).toEqual({ type: "adaptive" });
    expect(call.options.effort).toBe("high");
  });

  it("passes systemPrompt, cwd, mcpServers, permissionMode, allowedTools through", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    await generateClaudeResponse("SYS", {
      messages: [{ role: "user", content: "hi" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      cwd: "/x",
      mcpServers: { worklab: { command: "/bin/sh" } },
      allowedTools: ["Read", "Bash"],
      permissionMode: "bypassPermissions",
      maxTurns: 50,
      onEvent: () => {},
    });
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.systemPrompt).toBe("SYS");
    expect(options.cwd).toBe("/x");
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowedTools).toEqual(["Read", "Bash"]);
    expect(options.maxTurns).toBe(50);
    expect(options.mcpServers.worklab.command).toBe("/bin/sh");
  });

  it("emits canonical file_edit events for successful Edit hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-claude-edit-"));
    const filePath = join(dir, "target.txt");
    writeFileSync(filePath, "one\ntwo\n");
    mockQueryWithHookedStream(async (options) => {
      await runSdkHooks(options, "PreToolUse", hookInput("PreToolUse", dir, "Edit", {
        file_path: filePath,
        old_string: "two",
        new_string: "two\nthree",
      }), "toolu_edit");
      writeFileSync(filePath, "one\ntwo\nthree\n");
      await runSdkHooks(options, "PostToolUse", hookInput("PostToolUse", dir, "Edit", {
        file_path: filePath,
        old_string: "two",
        new_string: "two\nthree",
      }, { tool_response: { ok: true } }), "toolu_edit");
    });

    try {
      const events = [];
      const result = await generateClaudeResponse("sys", {
        messages: [{ role: "user", content: "edit file" }],
        model: { sdk: "claude", model: "claude-sonnet-4-6" },
        effort: "medium",
        cwd: dir,
        onEvent: (event) => events.push(event),
      });

      expect(result.error).toBeNull();
      expect(events).toContainEqual({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "file_edit:toolu_edit",
            name: "file_edit",
            input: { changes: [{ path: filePath, kind: "update" }], status: "in_progress" },
          }],
        },
      });
      expect(events).toContainEqual({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "file_edit:toolu_edit",
            content: {
              changes: [{
                path: filePath,
                kind: "update",
                line_stats: {
                  before_lines: 2,
                  after_lines: 3,
                  added_lines: 1,
                  removed_lines: 0,
                  changed_lines: 1,
                  hunks: [{ start: 3, end: 3 }],
                },
              }],
              status: "completed",
              summary: { files: 1, added_lines: 1, removed_lines: 0, changed_lines: 1, unavailable_count: 0 },
            },
            is_error: false,
          }],
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks Claude Write hooks to new files as file_edit additions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-claude-write-"));
    const filePath = join(dir, "created.md");
    mockQueryWithHookedStream(async (options) => {
      await runSdkHooks(options, "PreToolUse", hookInput("PreToolUse", dir, "Write", {
        file_path: filePath,
        content: "alpha\nbeta\n",
      }), "toolu_edit");
      writeFileSync(filePath, "alpha\nbeta\n");
      await runSdkHooks(options, "PostToolUse", hookInput("PostToolUse", dir, "Write", {
        file_path: filePath,
        content: "alpha\nbeta\n",
      }, { tool_response: { ok: true } }), "toolu_edit");
    });

    try {
      const events = [];
      await generateClaudeResponse("sys", {
        messages: [{ role: "user", content: "write file" }],
        model: { sdk: "claude", model: "claude-sonnet-4-6" },
        effort: "medium",
        cwd: dir,
        onEvent: (event) => events.push(event),
      });

      const resultEvent = events.find((event) => event?.message?.content?.[0]?.tool_use_id === "file_edit:toolu_edit");
      expect(resultEvent.message.content[0].content.changes[0]).toMatchObject({
        path: filePath,
        kind: "add",
        line_stats: { before_lines: 0, after_lines: 2, added_lines: 2, removed_lines: 0 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits failed file_edit results for Claude edit hook failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-claude-edit-fail-"));
    const filePath = join(dir, "target.txt");
    writeFileSync(filePath, "old\n");
    mockQueryWithHookedStream(async (options) => {
      await runSdkHooks(options, "PreToolUse", hookInput("PreToolUse", dir, "Edit", {
        file_path: filePath,
        old_string: "missing",
        new_string: "new",
      }), "toolu_edit");
      await runSdkHooks(options, "PostToolUseFailure", hookInput("PostToolUseFailure", dir, "Edit", {
        file_path: filePath,
        old_string: "missing",
        new_string: "new",
      }, { error: "old_string not found" }), "toolu_edit");
    });

    try {
      const events = [];
      await generateClaudeResponse("sys", {
        messages: [{ role: "user", content: "bad edit" }],
        model: { sdk: "claude", model: "claude-sonnet-4-6" },
        effort: "medium",
        cwd: dir,
        onEvent: (event) => events.push(event),
      });

      const resultEvent = events.find((event) => event?.message?.content?.[0]?.tool_use_id === "file_edit:toolu_edit");
      expect(resultEvent.message.content[0]).toMatchObject({
        type: "tool_result",
        is_error: true,
        content: {
          status: "failed",
          error: "old_string not found",
          changes: [{ path: filePath, kind: "update" }],
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes Playwright MCP artifact filenames into the run artifact directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-claude-mcp-file-"));
    const runDir = join(dir, "artifacts");
    mockQueryWithHookedStream(async (options) => {
      const outputs = await runSdkHooks(options, "PreToolUse", hookInput("PreToolUse", dir, "mcp__playwright__browser_take_screenshot", {
        filename: "screens/home.png",
      }), "toolu_shot");
      expect(outputs).toContainEqual({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: {
            filename: join(runDir, "screens", "home.png"),
          },
        },
      });
    });

    try {
      await generateClaudeResponse("sys", {
        messages: [{ role: "user", content: "take screenshot" }],
        model: { sdk: "claude", model: "claude-sonnet-4-6" },
        effort: "medium",
        cwd: dir,
        runArtifactDir: runDir,
        onEvent: () => {},
      });

      expect(existsSync(join(runDir, "screens"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates oversized Claude MCP tool outputs and persists the full payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worklab-claude-mcp-bloat-"));
    const runDir = join(dir, "artifacts");
    const events = [];
    let hookOutputs = [];
    mockQueryWithHookedStream(async (options) => {
      hookOutputs = await runSdkHooks(options, "PostToolUse", hookInput("PostToolUse", dir, "mcp__playwright__browser_take_screenshot", {}, {
        tool_response: {
          content: [{ type: "text", text: "x".repeat(2048) }],
        },
      }), "toolu_payload");
      expect(existsSync(join(runDir, "tool-output"))).toBe(true);
    });

    try {
      await generateClaudeResponse("sys", {
        messages: [{ role: "user", content: "take screenshot" }],
        model: { sdk: "claude", model: "claude-sonnet-4-6" },
        effort: "medium",
        cwd: dir,
        persistArtifact: createToolOutputSink(runDir),
        toolPayloadMaxBytes: 64,
        onEvent: (event) => events.push(event),
      });

      const output = hookOutputs.find((entry) => entry?.hookSpecificOutput?.hookEventName === "PostToolUse");
      expect(Array.isArray(output.hookSpecificOutput.updatedMCPToolOutput)).toBe(true);
      expect(output.hookSpecificOutput.updatedMCPToolOutput).not.toHaveProperty("content");
      expect(output.hookSpecificOutput.updatedMCPToolOutput[0].text).toContain("truncated tool_result");
      expect(output.hookSpecificOutput.updatedMCPToolOutput[0].text).toContain("saved_to=");
      expect(events).toContainEqual(expect.objectContaining({
        type: "runtime_warning",
        warning_kind: "tool_payload_truncated",
        source: "tool_bloat_guard",
        tool: "mcp__playwright__browser_take_screenshot",
        tool_use_id: "toolu_payload",
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accumulates text across multiple assistant events", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "part 1 " }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "part 2" }] } },
      { type: "result", usage: {}, duration_ms: 0, num_turns: 0 },
    ]));
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    expect(r.text).toBe("part 1 part 2");
  });

  it("ignores non-text assistant content blocks (tool_use)", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "tu1", name: "Read", input: {} },
        { type: "text", text: "done" },
      ]}},
      { type: "result", usage: {}, duration_ms: 0, num_turns: 0 },
    ]));
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    expect(r.text).toBe("done");
  });

  it("captures error event from SDK stream", async () => {
    mockQuery.mockReturnValue(mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
      { type: "error", error: { message: "boom" } },
      { type: "result", usage: {}, duration_ms: 0, num_turns: 0 },  // should not be reached
    ]));
    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    expect(r.error).toBe("boom");
    expect(r.text).toBe("partial");
    expect(r.numTurns).toBe(0);  // stream broke before result
  });

  it("passes prompt as a concatenated string (not array)", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "do the thing" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      onEvent: () => {},
    });
    const call = mockQuery.mock.calls[0][0];
    expect(typeof call.prompt).toBe("string");
    expect(call.prompt).toBe("do the thing");
  });

  it("uses Claude streaming user messages when live input is provided", async () => {
    mockQuery.mockReturnValue(mockStream([{ type: "result", usage: {}, duration_ms: 0, num_turns: 0 }]));
    const liveInput = createLiveInputQueue();
    await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "do the thing" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      liveInput,
      onEvent: () => {},
    });

    const call = mockQuery.mock.calls[0][0];
    expect(typeof call.prompt).not.toBe("string");
    const iterator = call.prompt[Symbol.asyncIterator]();
    const initial = await iterator.next();
    expect(initial.value).toMatchObject({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: "do the thing" },
    });

    liveInput.push({ id: "comment-1", body: "Please focus the answer." });
    const followup = await iterator.next();
    expect(followup.value).toMatchObject({
      type: "user",
      uuid: "comment-1",
      message: { role: "user", content: formatLiveInputGuidance("Please focus the answer.") },
    });
    liveInput.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("ends live-input runs after a successful result event", async () => {
    const stream = mockHangingStreamAfter([
      { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "# Report\n\nFinal delivered answer.",
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 1,
      },
    ]);
    mockQuery.mockReturnValue(stream);
    const liveInput = createLiveInputQueue();

    const r = await generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "do the thing" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      liveInput,
      onEvent: () => {},
    });
    liveInput.close();

    expect(r.text).toBe("# Report\n\nFinal delivered answer.");
    expect(r.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(typeof r.usage.cost_usd).toBe("number");
    expect(r.durationMs).toBe(100);
    expect(r.numTurns).toBe(1);
    expect(r.error).toBeNull();
    expect(stream.return).toHaveBeenCalledTimes(1);
  });

  it("abort signal cancels the stream", async () => {
    const stream = mockStream([
      { type: "assistant", message: { content: [{ type: "text", text: "a" }] } },
    ]);
    mockQuery.mockReturnValue(stream);
    const ac = new AbortController();
    const promise = generateClaudeResponse("sys", {
      messages: [{ role: "user", content: "x" }],
      model: { sdk: "claude", model: "claude-sonnet-4-6" },
      effort: "medium",
      abortSignal: ac.signal,
      onEvent: () => {},
    });
    ac.abort();
    const r = await promise;
    expect(r.cancelled).toBe(true);
    expect(stream.return).toHaveBeenCalled();
  });
});
