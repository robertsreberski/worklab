import { describe, expect, it } from "vitest";
import { createSdkEventCoalescer } from "../../worker/event-coalescer.js";

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
