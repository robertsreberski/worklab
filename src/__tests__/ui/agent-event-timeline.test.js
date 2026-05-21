import { describe, expect, it } from "vitest";
import {
  groupAgentTimelineEvents,
  isActiveStreamingTimelineItem,
  normaliseAgentTimelineEvents,
  providerRequestTargetLabel,
  runtimeWarningText,
} from "../../ui/src/components/AgentEventTimeline.jsx";
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

  it("coalesces consecutive text fragments", () => {
    const events = normaliseAgentTimelineEvents([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "thinking", text: "Done" },
    ]);

    expect(events).toEqual([
      { type: "text", text: "Hello" },
      { type: "thinking", text: "Done" },
    ]);
  });

  it("deduplicates completed text snapshots after streamed fragments", () => {
    const fullText = "Checking output and preparing the next edit.";
    const events = normaliseAgentTimelineEvents([
      { type: "text", text: "Checking output" },
      { type: "text", text: " and preparing" },
      { type: "text", text: fullText },
    ]);

    expect(events).toEqual([
      { type: "text", text: fullText },
    ]);
  });

  it("deduplicates Codex completed thinking snapshots after streamed fragments", () => {
    const fullText = "**Correcting structure output**\n\nI realized I emitted a structured progress object.";
    const events = normaliseAgentTimelineEvents([
      {
        type: "assistant",
        message: { content: [{ type: "thinking", text: "**Correcting structure output**\n\nI" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "thinking", text: " realized" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "thinking", text: " I emitted a structured progress object." }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "thinking", text: fullText }] },
      },
    ]);

    expect(events).toEqual([
      { type: "thinking", text: fullText },
    ]);
  });

  it("marks only the tail timeline item as actively streaming", () => {
    expect(isActiveStreamingTimelineItem({ streaming: true, index: 1, length: 3 })).toBe(false);
    expect(isActiveStreamingTimelineItem({ streaming: true, index: 2, length: 3 })).toBe(true);
    expect(isActiveStreamingTimelineItem({ streaming: false, index: 2, length: 3 })).toBe(false);
  });

  it("does not duplicate the SDK prefix for full provider runtime refs", () => {
    expect(providerRequestTargetLabel({
      sdk: "pi",
      model: "pi:JmPScFlw8qog:qwen3.6:latest",
    })).toBe("pi:JmPScFlw8qog:qwen3.6:latest");
    expect(providerRequestTargetLabel({ sdk: "claude", model: "claude-sonnet-4-6" })).toBe("claude/claude-sonnet-4-6");
  });

  it("renders MCP init warnings with the server name", () => {
    expect(runtimeWarningText({
      warning_kind: "mcp_init_failed",
      server: "apple-mcp",
      message: "fetch failed",
    })).toBe("MCP apple-mcp unavailable: fetch failed");
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

  it("renders run todo tool calls as paired timeline tool calls", () => {
    const items = groupAgentTimelineEvents([
      { type: "text", text: "Starting" },
      { type: "tool_use", tool_use_id: "todo-1", name: "mcp__worklab__todo_write", input: { todos: [] } },
      { type: "tool_result", tool_use_id: "todo-1", output: "{\"ok\":true}", is_error: false },
      { type: "tool_use", tool_use_id: "todo-2", name: "mcp__worklab__todo_read", input: {} },
      { type: "tool_result", tool_use_id: "todo-2", output: "{\"todo_state\":{\"todos\":[]}}", is_error: false },
      { type: "text", text: "Continuing" },
    ]);

    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ type: "text", text: "Starting" });
    expect(items[1]).toMatchObject({
      _toolCall: true,
      toolUse: { tool_use_id: "todo-1", name: "mcp__worklab__todo_write" },
      toolResult: { tool_use_id: "todo-1", output: "{\"ok\":true}", is_error: false },
    });
    expect(items[2]).toMatchObject({
      _toolCall: true,
      toolUse: { tool_use_id: "todo-2", name: "mcp__worklab__todo_read" },
      toolResult: { tool_use_id: "todo-2", output: "{\"todo_state\":{\"todos\":[]}}", is_error: false },
    });
    expect(items[3]).toEqual({ type: "text", text: "Continuing" });
  });

  it("attaches structured output to the matching tool call", () => {
    const structured = { schema: "worklab.v2", summary: "Done", final_text: "Implemented." };
    const items = groupAgentTimelineEvents([
      { type: "tool_use", tool_use_id: "structured-1", name: "StructuredOutput", input: structured },
      { type: "structured_output", tool_use_id: "structured-1", value: structured, worklab_result: structured },
      { type: "tool_result", tool_use_id: "structured-1", output: "Structured output received." },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]._toolCall).toBe(true);
    expect(items[0].structuredOutput).toMatchObject({ worklab_result: structured });
  });

  it("keeps errored StructuredOutput result messages visible", () => {
    const structured = { schema: "worklab.v2", summary: "Done", artifacts: { extra: true } };
    const errorMessage = "Validation failed for tool \"StructuredOutput\": artifacts must not have additional properties";
    const items = groupAgentTimelineEvents([
      { type: "tool_use", tool_use_id: "structured-1", name: "StructuredOutput", input: structured },
      { type: "tool_result", tool_use_id: "structured-1", is_error: true, error: errorMessage },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]._toolCall).toBe(true);
    expect(items[0].toolResult).toMatchObject({
      tool_use_id: "structured-1",
      output: errorMessage,
      error: errorMessage,
      is_error: true,
    });
  });

  it("prefers StructuredOutput result content over fallback error messages", () => {
    const structured = { schema: "worklab.v2", summary: "Done", artifacts: { extra: true } };
    const content = "Validation failed for tool \"StructuredOutput\":\n  - artifacts: must not have additional properties";
    const items = groupAgentTimelineEvents([
      { type: "tool_use", tool_use_id: "structured-1", name: "StructuredOutput", input: structured },
      {
        type: "tool_result",
        tool_use_id: "structured-1",
        content,
        is_error: true,
        error: "schema validation failed",
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]._toolCall).toBe(true);
    expect(items[0].toolResult.output).toBe(content);
    expect(items[0].toolResult.error).toBe("schema validation failed");
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

  it("collapses linked Edit and file_edit events into one visible file edit", () => {
    const changes = [{
      path: "/workspace/worklab/src/ui/src/routes/TaskDetail.jsx",
      kind: "update",
      line_stats: { added_lines: 10, removed_lines: 2 },
    }];
    const items = groupAgentTimelineEvents([
      { type: "tool_use", tool_use_id: "edit-1", name: "Edit", input: { file_path: "src/ui/src/routes/TaskDetail.jsx" } },
      { type: "tool_use", tool_use_id: "file_edit:edit-1", name: "file_edit", input: { changes, status: "in_progress" } },
      { type: "tool_result", tool_use_id: "file_edit:edit-1", content: { changes, status: "completed" }, is_error: false },
      { type: "tool_result", tool_use_id: "edit-1", output: "Successfully edited /workspace/worklab/src/ui/src/routes/TaskDetail.jsx" },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]._toolCall).toBe(true);
    expect(items[0].toolUse).toMatchObject({
      tool_use_id: "file_edit:edit-1",
      name: "file_edit",
      display_name: "Edit",
      source_tool_use_id: "edit-1",
    });
    expect(items[0].toolResult).toMatchObject({
      tool_use_id: "file_edit:edit-1",
      is_error: false,
    });
    expect(fileEditSummary(items[0].toolResult.content)).toBe("update TaskDetail.jsx (+10 -2)");
  });

  it("keeps unmatched Edit results visible when no file edit summary exists", () => {
    const items = groupAgentTimelineEvents([
      { type: "tool_use", tool_use_id: "edit-1", name: "Edit", input: { file_path: "src/app.js" } },
      { type: "tool_use", tool_use_id: "file_edit:edit-1", name: "file_edit", input: { changes: [], status: "in_progress" } },
      { type: "tool_result", tool_use_id: "edit-1", output: "Error: old_string not found" },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]._toolCall).toBe(true);
    expect(items[0].toolUse.name).toBe("Edit");
    expect(items[0].toolResult.output).toBe("Error: old_string not found");
    expect(items[1]._toolCall).toBe(true);
    expect(items[1].toolUse.name).toBe("file_edit");
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

  it("summarizes object-shaped file edit kinds", () => {
    expect(fileEditSummary({
      status: "completed",
      changes: [{
        path: "/workspace/catching-up/slack/scripts/exact_slack_catchup.py",
        kind: { type: "update", move_path: null },
        line_stats: { added_lines: 4, removed_lines: 1 },
      }],
    })).toBe("update exact_slack_catchup.py (+4 -1)");
  });
});
