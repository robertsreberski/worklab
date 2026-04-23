import { describe, expect, it } from "vitest";
import { groupAgentTimelineEvents, normaliseAgentTimelineEvents } from "../../ui/src/components/AgentEventTimeline.jsx";

describe("agent event timeline normalization", () => {
  it("coalesces consecutive thinking fragments", () => {
    const events = normaliseAgentTimelineEvents([
      { type: "thinking", text: "Looking " },
      { type: "thinking", text: "at files" },
      { type: "text", text: "Done." },
    ]);

    expect(events).toEqual([
      { type: "thinking", text: "Looking at files" },
      { type: "text", text: "Done." },
    ]);
  });

  it("flattens assistant message envelopes and normalizes tool ids", () => {
    const events = normaliseAgentTimelineEvents([
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Plan" },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { cmd: "pwd" } },
            { type: "text", text: "Result" },
          ],
        },
      },
    ]);

    expect(events).toEqual([
      { type: "thinking", text: "Plan" },
      { type: "tool_use", tool_use_id: "tool-1", name: "Bash", input: { cmd: "pwd" } },
      { type: "text", text: "Result" },
    ]);
  });

  it("pairs tool_use events with matching tool_result events", () => {
    const items = groupAgentTimelineEvents([
      { type: "tool_use", tool_use_id: "tool-1", name: "Read", input: { file: "a" } },
      { type: "tool_result", tool_use_id: "tool-1", output: "ok" },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]._toolCall).toBe(true);
    expect(items[0].toolUse.name).toBe("Read");
    expect(items[0].toolResult.output).toBe("ok");
  });
});
