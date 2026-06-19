import { describe, expect, it } from "vitest";
import {
  toolUseEvent,
  toolResultEvent,
  thinkingEvent,
  assistantTextEvent,
} from "../../ai/streaming/opencode-events.js";

describe("opencode event helpers", () => {
  it("maps a tool part to an Anthropic-shaped tool_use", () => {
    const part = { type: "tool", callID: "call-1", tool: "bash", state: { status: "running", input: { command: "ls" } } };
    expect(toolUseEvent(part)).toEqual({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } }] },
    });
  });

  it("maps a completed tool part to a non-error tool_result", () => {
    const part = { type: "tool", callID: "call-1", tool: "bash", state: { status: "completed", input: {}, output: "file.txt\n" } };
    expect(toolResultEvent(part)).toEqual({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "file.txt\n", is_error: false }] },
    });
  });

  it("maps an errored tool part to an error tool_result carrying the error text", () => {
    const part = { type: "tool", callID: "call-2", tool: "bash", state: { status: "error", input: {}, error: "boom" } };
    expect(toolResultEvent(part)).toEqual({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "call-2", content: "boom", is_error: true }] },
    });
  });

  it("maps a reasoning part to assistant thinking", () => {
    expect(thinkingEvent({ type: "reasoning", text: "hmm" })).toEqual({
      type: "assistant",
      message: { content: [{ type: "thinking", text: "hmm" }] },
    });
  });

  it("wraps final text as an assistant text event", () => {
    expect(assistantTextEvent("done")).toEqual({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    });
  });
});
