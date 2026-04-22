import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args) => mockQuery(...args),
}));

const { generateClaudeResponse } = await import("../../core/ai-claude.js");

function mockStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
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
