import { describe, expect, it } from "vitest";
import { normalizeWorklabEvents } from "../../ui/src/components/EventTimeline.jsx";
import { normalizeToolTokenEvent } from "../../ui/src/components/primitives/ToolToken.jsx";
import { mergeRunEvents } from "../../ui/src/lib/useRunStream.js";

describe("worklab event timeline normalization", () => {
  it("compacts final result payloads after visible assistant text", () => {
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "Done." }] },
        },
      },
      {
        type: "final",
        text: "Done.",
        model: "model-a",
        usage: { input_tokens: 10, output_tokens: 3 },
        durationMs: 500,
        numTurns: 1,
      },
    ]);

    expect(events[0].message.content[0].text).toBe("Done.");
    expect(events[1]).toMatchObject({
      type: "final",
      compact: true,
      text: "Done.",
      model: "model-a",
      durationMs: 500,
      numTurns: 1,
    });
  });

  it("keeps different delivered final text visible after intermediate assistant text", () => {
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "I will gather the data." }] },
        },
      },
      {
        type: "final",
        text: "# Report\n\nFinal delivered answer.",
        worklab_result: { schema: "worklab.v2", decision: "advance", summary: "Short result", details: "Useful detail" },
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);

    expect(events[1]).toEqual({
      type: "final",
      text: "# Report\n\nFinal delivered answer.\n\nin 1 / out 2",
      structured: { schema: "worklab.v2", decision: "advance", summary: "Short result", details: "Useful detail" },
    });
  });

  it("keeps final text visible when no assistant text event was recorded", () => {
    const events = normalizeWorklabEvents([
      { type: "started" },
      {
        type: "final",
        text: "Only final text.",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);

    expect(events[1]).toEqual({
      type: "final",
      text: "Only final text.\n\nin 1 / out 2",
    });
  });

  it("uses worklab_result final_text for visible final rows", () => {
    const events = normalizeWorklabEvents([
      {
        type: "final",
        text: "{\"schema\":\"worklab.v2\"}",
        worklab_result: { final_text: "Human-facing final comment", summary: "Short result", details: "Useful detail" },
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);

    expect(events[0]).toEqual({
      type: "final",
      text: "Human-facing final comment\n\nin 1 / out 2",
      structured: { final_text: "Human-facing final comment", summary: "Short result", details: "Useful detail" },
    });
  });

  it("strips embedded worklab JSON from visible final text", () => {
    const events = normalizeWorklabEvents([
      {
        type: "final",
        text: [
          "Delivered answer.",
          "```json",
          "{\"schema\":\"worklab.v2\",\"stage\":\"execute\",\"decision\":\"advance\",\"summary\":\"Short\",\"details\":\"Detail\",\"artifacts\":{},\"blocking_issues\":[],\"pending_actions\":[],\"subtasks\":[]}",
          "```",
        ].join("\n"),
        worklab_result: { schema: "worklab.v2", decision: "advance", summary: "Short", details: "Detail" },
      },
    ]);

    expect(events[0]).toEqual({
      type: "final",
      text: "Delivered answer.",
      structured: { schema: "worklab.v2", decision: "advance", summary: "Short", details: "Detail" },
    });
  });

  it("hides noisy CLI housekeeping events and keeps runtime warnings readable", () => {
    const events = normalizeWorklabEvents([
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "hook_started", hook: "PreToolUse" } } },
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "init" } } },
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "turn_failed", message: "bad" } } },
      { type: "runtime_warning", warning_kind: "unstructured_result_fallback", message: "final text is not JSON" },
    ]);

    expect(events).toEqual([
      { type: "cli_event", raw: { type: "turn_failed", message: "bad" } },
      { type: "runtime_warning", warning_kind: "unstructured_result_fallback", message: "final text is not JSON" },
    ]);
  });

  it("normalizes historical Codex file change CLI events as file edits", () => {
    const changes = [{ path: "/workspace/catching-up/build_wp_p2_tree.py", kind: "add" }];
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "cli_event",
          raw: { type: "item.started", item: { id: "item_file", type: "file_change", changes, status: "in_progress" } },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "cli_event",
          raw: { type: "item.completed", item: { id: "item_file", type: "file_change", changes, status: "completed" } },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "item_file",
            name: "file_edit",
            input: { changes, status: "in_progress" },
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "item_file",
            content: { changes, status: "completed" },
            is_error: false,
          }],
        },
      },
    ]);
  });

  it("normalizes direct Codex app-server command item events as tool calls", () => {
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "item.started",
          item: {
            type: "command_execution",
            id: "cmd1",
            command: "/bin/zsh -lc 'memory_pressure -Q'",
            aggregated_output: "",
            exit_code: null,
            status: "inProgress",
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "cmd1",
            command: "/bin/zsh -lc 'memory_pressure -Q'",
            aggregated_output: "System-wide memory free percentage: 68%\n",
            exit_code: 0,
            status: "completed",
          },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "cmd1",
            name: "command_execution",
            input: { command: "/bin/zsh -lc 'memory_pressure -Q'" },
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "cmd1",
            content: "System-wide memory free percentage: 68%\n",
            is_error: false,
          }],
        },
      },
    ]);
  });

  it("normalizes direct Codex app-server MCP item events as tool calls", () => {
    const events = normalizeWorklabEvents([
      {
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          id: "mcp1",
          server: "worklab",
          tool: "journal_append",
          arguments: { bullet: "checked memory" },
          result: null,
          error: null,
          status: "inProgress",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          id: "mcp1",
          server: "worklab",
          tool: "journal_append",
          arguments: { bullet: "checked memory" },
          result: { content: [{ type: "text", text: "{\"ok\":true}" }], structuredContent: null },
          error: null,
          status: "completed",
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "mcp1",
            name: "mcp__worklab__journal_append",
            input: { bullet: "checked memory" },
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "mcp1",
            content: [{ type: "text", text: "{\"ok\":true}" }],
            is_error: false,
          }],
        },
      },
    ]);
  });

  it("normalizes provider result errors as visible errors", () => {
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "result",
          subtype: "error_max_turns",
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
      { type: "worklab_result_error", message: "invalid worklab_result" },
    ]);

    expect(events).toEqual([
      { type: "error", message: "Stopped before final output: max turns reached" },
      { type: "error", message: "invalid worklab_result" },
    ]);
  });

  it("hides mid-run structured result candidates", () => {
    const events = normalizeWorklabEvents([
      { type: "started" },
      {
        type: "sdk_event",
        event: {
          type: "worklab_result_candidate",
          source: "agent_message",
          text: "{\"schema\":\"worklab.v2\"}",
          worklab_result: { schema: "worklab.v2", decision: "advance", summary: "progress" },
        },
      },
      {
        type: "final",
        worklab_result: { schema: "worklab.v2", decision: "advance", summary: "done", details: "" },
        usage: {},
      },
    ]);

    expect(events).toEqual([
      { type: "started" },
      {
        type: "final",
        text: "done",
        structured: { schema: "worklab.v2", decision: "advance", summary: "done", details: "" },
      },
    ]);
  });

  it("keeps normalized structured output events visible", () => {
    const worklabResult = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Done",
      final_text: "Implemented.",
    };
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "structured_output",
          source: "StructuredOutput",
          tool_use_id: "structured-1",
          value: worklabResult,
          worklab_result: worklabResult,
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "structured_output",
        source: "StructuredOutput",
        tool_use_id: "structured-1",
        value: worklabResult,
        worklab_result: worklabResult,
      },
    ]);
  });

  it("keeps live user messages visible as guidance rows", () => {
    const events = normalizeWorklabEvents([
      { type: "live_user_message", body: "Please focus on the API route.", created_at: 123 },
    ]);

    expect(events).toEqual([
      { type: "live_user_message", text: "Please focus on the API route.", created_at: 123 },
    ]);
  });
});

describe("run event merging", () => {
  it("deduplicates hydrated and streamed events by sequence", () => {
    const merged = mergeRunEvents(
      [{ type: "text", text: "two", _event_seq: 2 }],
      [
        { type: "text", text: "one", _event_seq: 1 },
        { type: "text", text: "two updated", _event_seq: 2 },
      ],
    );

    expect(merged).toEqual([
      { type: "text", text: "one", _event_seq: 1 },
      { type: "text", text: "two updated", _event_seq: 2 },
    ]);
  });
});

describe("compact run event labels", () => {
  it("unwraps sdk assistant text for list-row display", () => {
    expect(
      normalizeToolTokenEvent({
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "Checking files" }] },
        },
      }),
    ).toEqual({ type: "text", text: "Checking files" });
  });

  it("uses final worklab result summary when present", () => {
    expect(
      normalizeToolTokenEvent({
        type: "final",
        text: "long final text",
        worklab_result: { final_text: "Final comment", summary: "Short outcome" },
      }),
    ).toEqual({ type: "text", text: "Final comment" });
  });

  it("labels raw Codex file changes as file edits", () => {
    expect(
      normalizeToolTokenEvent({
        type: "sdk_event",
        event: {
          type: "cli_event",
          raw: {
            type: "item.started",
            item: {
              type: "file_change",
              changes: [{ path: "/workspace/catching-up/build_wp_p2_tree.py", kind: "update" }],
            },
          },
        },
      }),
    ).toEqual({
      type: "tool_use",
      name: "file_edit",
      arg: "update build_wp_p2_tree.py",
      status: "running",
    });
  });

  it("labels object-shaped file edit kinds without leaking object strings", () => {
    expect(
      normalizeToolTokenEvent({
        type: "tool_result",
        tool_use_id: "file-1",
        content: {
          status: "completed",
          changes: [{
            path: "/workspace/catching-up/slack/scripts/exact_slack_catchup.py",
            kind: { type: "update", move_path: null },
            line_stats: { added_lines: 4, removed_lines: 1 },
          }],
        },
        is_error: false,
      }),
    ).toEqual({
      type: "tool_use",
      name: "file_edit",
      arg: "update exact_slack_catchup.py (+4 -1)",
      status: "done",
    });
  });

  it("labels completed file edit tool results with line stats", () => {
    expect(
      normalizeToolTokenEvent({
        type: "tool_result",
        tool_use_id: "file-1",
        content: {
          status: "completed",
          changes: [{
            path: "/workspace/catching-up/build_wp_p2_tree.py",
            kind: "update",
            line_stats: { added_lines: 12, removed_lines: 3 },
          }],
        },
        is_error: false,
      }),
    ).toEqual({
      type: "tool_use",
      name: "file_edit",
      arg: "update build_wp_p2_tree.py (+12 -3)",
      status: "done",
    });
  });

  it("labels direct Codex app-server command and MCP item events", () => {
    expect(
      normalizeToolTokenEvent({
        type: "sdk_event",
        event: {
          type: "item.started",
          item: { type: "command_execution", id: "cmd1", command: "pwd", status: "inProgress" },
        },
      }),
    ).toMatchObject({
      type: "tool_use",
      name: "command_execution",
      arg: "pwd",
      status: "running",
    });

    expect(
      normalizeToolTokenEvent({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          id: "mcp1",
          server: "worklab",
          tool: "journal_append",
          arguments: { bullet: "checked memory" },
          status: "completed",
        },
      }),
    ).toMatchObject({
      type: "tool_use",
      name: "mcp__worklab__journal_append",
      arg: "{\"bullet\":\"checked memory\"}",
      status: "done",
    });
  });
});
