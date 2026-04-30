import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args) => mockQuery(...args),
}));

const { generateClaudeResponse } = await import("../../ai/providers/claude-sdk.js");
const { createLiveInputQueue, formatLiveInputGuidance } = await import("../../core/live-input.js");

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
  for (const group of groups) {
    if (!hookMatches(group.matcher, input.tool_name)) continue;
    for (const hook of group.hooks || []) {
      await hook(input, toolUseID, { signal });
    }
  }
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
  beforeEach(() => mockQuery.mockReset());

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
      { type: "assistant", message: { content: [{ type: "text", text: "Working..." }] } },
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        num_turns: 30,
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
