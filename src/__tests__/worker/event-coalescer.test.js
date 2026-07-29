import { describe, expect, it } from "vitest";
import { __eventCoalescerTest, createSdkEventCoalescer } from "../../worker/event-coalescer.js";

function cliEvent(raw) {
  return { type: "cli_event", raw };
}

function thinkingTokensEvent(total, delta) {
  return cliEvent({ type: "system", subtype: "thinking_tokens", estimated_tokens: total, estimated_tokens_delta: delta });
}

function redactedThinkingEvent(signature = "sig") {
  return { type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature }] } };
}

describe("worker SDK event coalescer", () => {
  it("merges adjacent assistant text and thinking fragments", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), { flushIntervalMs: 0 });

    coalescer.emit({ type: "assistant", message: { content: [{ type: "text", text: "Hel" }] } });
    coalescer.emit({ type: "assistant", message: { content: [{ type: "text", text: "lo" }] } });
    coalescer.emit({ type: "assistant", message: { content: [{ type: "thinking", text: "Think" }] } });
    coalescer.emit({ type: "assistant", message: { content: [{ type: "thinking", text: "ing" }] } });
    coalescer.flush();

    expect(events).toEqual([
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "assistant", message: { content: [{ type: "thinking", text: "Thinking" }] } },
    ]);
  });

  it("flushes before tool boundaries", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), { flushIntervalMs: 0 });

    coalescer.emit({ type: "assistant", message: { content: [{ type: "text", text: "Before " }] } });
    coalescer.emit({ type: "assistant", message: { content: [{ type: "text", text: "tool" }] } });
    coalescer.emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }] } });
    coalescer.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } });
    coalescer.flush();

    expect(events).toEqual([
      { type: "assistant", message: { content: [{ type: "text", text: "Before tool" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } },
    ]);
  });

  it("deduplicates completed snapshots after streamed fragments", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), { flushIntervalMs: 0 });

    coalescer.emit({ type: "assistant", message: { content: [{ type: "text", text: "Checking output" }] } });
    coalescer.emit({ type: "assistant", message: { content: [{ type: "text", text: " and preparing" }] } });
    coalescer.emit({ type: "assistant", message: { content: [{ type: "text", text: "Checking output and preparing the next edit." }] } });
    coalescer.flush();

    expect(events).toEqual([
      { type: "assistant", message: { content: [{ type: "text", text: "Checking output and preparing the next edit." }] } },
    ]);
  });
});

describe("provider system event filtering", () => {
  it("drops CLI housekeeping events without emitting them", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), { flushIntervalMs: 0 });

    coalescer.emit(cliEvent({ type: "system", subtype: "init", cwd: "/repo" }));
    coalescer.emit(cliEvent({ type: "system", subtype: "status", status: "requesting" }));
    coalescer.emit(cliEvent({ type: "system", subtype: "hook_response", hook: "PreToolUse" }));
    coalescer.emit(cliEvent({ type: "system", subtype: "commands_changed", commands: [] }));
    coalescer.emit(cliEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }));
    coalescer.emit(cliEvent({ type: "hook_started", hook: "PreToolUse" }));
    coalescer.flush();

    expect(events).toEqual([]);
  });

  it("drops the same subtypes when the SDK sends them unwrapped", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), { flushIntervalMs: 0 });

    coalescer.emit({ type: "system", subtype: "status", status: "requesting" });
    coalescer.emit({ type: "system", subtype: "init", session_id: "abc" });
    coalescer.flush();

    expect(events).toEqual([]);
  });

  it("keeps diagnostically useful system events", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), { flushIntervalMs: 0 });

    const boundary = cliEvent({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } });
    const taskStarted = cliEvent({ type: "system", subtype: "task_started", task_id: "t1" });
    coalescer.emit(boundary);
    coalescer.emit(taskStarted);
    coalescer.flush();

    expect(events).toEqual([boundary, taskStarted]);
  });
});

describe("redacted thinking folding", () => {
  it("folds repeated thinking-token estimates into one throttled progress event", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), {
      flushIntervalMs: 0,
      thinkingProgressIntervalMs: 60_000,
    });

    coalescer.emit(thinkingTokensEvent(50, 50));
    coalescer.emit(thinkingTokensEvent(150, 100));
    coalescer.emit(thinkingTokensEvent(207, 57));
    coalescer.flush();

    expect(events).toEqual([
      { type: "thinking_progress", estimated_tokens: 50, estimated_tokens_delta: 50 },
    ]);
  });

  it("reports the latest running total when the throttle window has elapsed", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), {
      flushIntervalMs: 0,
      thinkingProgressIntervalMs: 0,
    });

    coalescer.emit(thinkingTokensEvent(50, 50));
    coalescer.emit(thinkingTokensEvent(150, 100));
    coalescer.flush();

    expect(events).toEqual([
      { type: "thinking_progress", estimated_tokens: 50, estimated_tokens_delta: 50 },
      { type: "thinking_progress", estimated_tokens: 150, estimated_tokens_delta: 100 },
    ]);
  });

  it("annotates redacted thinking blocks with the accumulated token estimate", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), {
      flushIntervalMs: 0,
      thinkingProgressIntervalMs: 60_000,
    });

    coalescer.emit(thinkingTokensEvent(50, 50));
    coalescer.emit(thinkingTokensEvent(207, 57));
    coalescer.emit(redactedThinkingEvent("sig-1"));
    coalescer.flush();

    expect(events).toEqual([
      { type: "thinking_progress", estimated_tokens: 50, estimated_tokens_delta: 50 },
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 207 }] } },
    ]);
  });

  it("resets the token accumulator after each redacted block", () => {
    const events = [];
    const coalescer = createSdkEventCoalescer((event) => events.push(event), {
      flushIntervalMs: 0,
      thinkingProgressIntervalMs: 60_000,
    });

    coalescer.emit(thinkingTokensEvent(300, 300));
    coalescer.emit(redactedThinkingEvent("sig-1"));
    coalescer.emit(redactedThinkingEvent("sig-2"));
    coalescer.emit(thinkingTokensEvent(80, 80));
    coalescer.emit(redactedThinkingEvent("sig-3"));
    coalescer.flush();

    expect(events).toEqual([
      { type: "thinking_progress", estimated_tokens: 300, estimated_tokens_delta: 300 },
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 300 }] } },
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: null }] } },
      { type: "thinking_progress", estimated_tokens: 80, estimated_tokens_delta: 80 },
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 80 }] } },
    ]);
  });

  it("only lets the first redacted block in one event consume the estimate", () => {
    const annotated = __eventCoalescerTest.annotateRedactedThinking({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "", signature: "sig-a" },
          { type: "thinking", thinking: "", signature: "sig-b" },
          { type: "text", text: "after" },
        ],
      },
    }, 420);

    expect(annotated.message.content).toEqual([
      { type: "thinking", text: "", redacted: true, estimated_tokens: 420 },
      { type: "thinking", text: "", redacted: true, estimated_tokens: null },
      { type: "text", text: "after" },
    ]);
  });

  it("leaves thinking blocks that carry real text untouched", () => {
    expect(__eventCoalescerTest.annotateRedactedThinking({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Real thought", signature: "sig" }] },
    }, 100)).toBeNull();
  });
});
