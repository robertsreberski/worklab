import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args) => mockQuery(...args),
}));

const { generateClaudeResponse } = await import("../../core/ai-claude.js");
const { createLiveInputQueue } = await import("../../core/live-input.js");

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
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
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
      message: { role: "user", content: "Please focus the answer." },
    });
    liveInput.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
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
