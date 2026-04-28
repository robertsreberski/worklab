import { describe, expect, it } from "vitest";
import { groupAgentTimelineEvents, normaliseAgentTimelineEvents } from "../../ui/src/components/AgentEventTimeline.jsx";
import { fileEditSummary } from "../../ui/src/components/ToolCallBlock.jsx";
import { normalizeWorklabEvents } from "../../ui/src/components/EventTimeline.jsx";

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

  it("pairs file edit events without marking completed changes as errors", () => {
    const changes = [{ path: "/workspace/catching-up/build_wp_p2_tree.py", kind: "update" }];
    const items = groupAgentTimelineEvents([
      { type: "tool_use", tool_use_id: "file-1", name: "file_edit", input: { changes, status: "in_progress" } },
      { type: "tool_result", tool_use_id: "file-1", content: { changes, status: "completed" }, is_error: false },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]._toolCall).toBe(true);
    expect(items[0].toolUse.name).toBe("file_edit");
    expect(items[0].toolResult.is_error).toBe(false);
  });

  it("pairs direct Codex command app-server events after Worklab normalization", () => {
    const items = groupAgentTimelineEvents(normalizeWorklabEvents([
      { type: "item.started", item: { type: "command_execution", id: "cmd1", command: "pwd", status: "inProgress" } },
      { type: "item.completed", item: { type: "command_execution", id: "cmd1", command: "pwd", aggregated_output: "/repo\n", exit_code: 0, status: "completed" } },
    ]));

    expect(items).toHaveLength(1);
    expect(items[0]._toolCall).toBe(true);
    expect(items[0].toolUse).toMatchObject({
      tool_use_id: "cmd1",
      name: "command_execution",
      input: { command: "pwd" },
    });
    expect(items[0].toolResult).toMatchObject({
      tool_use_id: "cmd1",
      output: "/repo\n",
      is_error: false,
    });
  });

  it("summarizes file edits with captured line stats", () => {
    expect(fileEditSummary({
      status: "completed",
      changes: [{
        path: "/workspace/catching-up/build_wp_p2_tree.py",
        kind: "update",
        line_stats: { added_lines: 12, removed_lines: 3 },
      }],
    })).toBe("update build_wp_p2_tree.py (+12 -3)");
  });
});
