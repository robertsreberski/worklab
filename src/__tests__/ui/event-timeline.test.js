import { describe, expect, it } from "vitest";
import {
  normalizeAcpTimelineEvent,
  normalizeWorklabEvents,
} from "../../ui/src/components/EventTimeline.jsx";
import { normalizeToolTokenEvent } from "../../ui/src/components/primitives/ToolToken.jsx";
import { mergeRunEvents } from "../../ui/src/lib/useRunStream.js";

describe("worklab event timeline normalization", () => {
  it("projects unknown ACP session updates to a label without raw protocol data", () => {
    const event = normalizeAcpTimelineEvent({
      type: "acp_session_update",
      sessionId: "secret-session-id",
      update: {
        sessionUpdate: "future_update",
        response: { content: "secret-response" },
        values: { token: "secret-value" },
        _meta: { authorization: "secret-auth" },
      },
    });

    expect(event).toEqual({
      type: "acp_session_update",
      updateType: "future_update",
      title: "ACP session update: Future Update",
    });
    expect(JSON.stringify(event)).not.toMatch(/secret|response|values|_meta|sessionId/);
  });

  it("projects a legacy ACP tool as a native block and drops its duplicate companion", () => {
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          sessionId: "session-private",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Run checks",
            kind: "execute",
            status: "pending",
            rawInput: { apiKey: "private-input" },
            rawOutput: "private-output",
            locations: [{ path: "/private/workspace" }],
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: "Run checks",
              input: { apiKey: "private-input" },
            }],
          },
        },
      },
    ]);

    expect(events).toEqual([{
      type: "assistant",
      source: "acp",
      message: {
        content: [{
          type: "tool_use",
          id: "acp:legacy-tool:1",
          name: "Run checks",
          input: { apiKey: "[redacted]" },
        }],
      },
      _worklab_acp_projected: true,
      _worklab_display_key: "acp:legacy-tool:1",
    }]);
    expect(JSON.stringify(events)).not.toMatch(/private|rawInput|rawOutput|locations|sessionId|tool-1/);
  });

  it("suppresses a marked ACP companion without requiring its raw predecessor", () => {
    const secret = "PRIVATE_ORPHAN_ACP_REASONING";
    const events = normalizeWorklabEvents([{
      type: "sdk_event",
      _worklab_acp_companion: true,
      _event_seq: 42,
      event: {
        type: "assistant",
        message: {
          content: [{ type: "thinking", text: secret }],
        },
      },
    }]);

    expect(events).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("passes coordinator-native ACP message, thinking, and tool envelopes through unchanged", () => {
    const events = [
      {
        type: "assistant",
        source: "acp",
        message: { content: [{ type: "text", text: "Cumulative answer" }] },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:message:1",
      },
      {
        type: "assistant",
        source: "acp",
        message: { content: [{ type: "thinking", text: "Reviewing files" }] },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:thought:2",
      },
      {
        type: "assistant",
        source: "acp",
        message: {
          content: [
            { type: "tool_use", id: "acp:tool:3", name: "Run checks", input: { command: "npm test" } },
            {
              type: "tool_result",
              tool_use_id: "acp:tool:3",
              content: "Tests passed",
              is_error: false,
            },
          ],
        },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:tool:3",
      },
    ];

    expect(normalizeWorklabEvents(events)).toEqual(events);
  });

  it("preserves a legacy ACP programmatic tool name across null partial updates", () => {
    const events = normalizeWorklabEvents([
      {
        type: "acp_session_update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "provider-tool",
          title: "Run command",
          name: "shell",
          status: "in_progress",
          rawInput: { command: "npm test" },
        },
      },
      {
        type: "acp_session_update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "provider-tool",
          title: null,
          name: null,
          status: "completed",
          rawOutput: "passed",
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].message.content).toEqual([
      {
        type: "tool_use",
        id: "acp:legacy-tool:1",
        name: "shell",
        input: { command: "npm test" },
      },
      {
        type: "tool_result",
        tool_use_id: "acp:legacy-tool:1",
        content: "passed",
        is_error: false,
      },
    ]);
  });

  it("renders payload-less legacy safe projections as native redacted and empty blocks", () => {
    const events = normalizeWorklabEvents([
      {
        type: "acp_session_update",
        update: { sessionUpdate: "agent_thought_chunk" },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:activity:1",
      },
      {
        type: "acp_session_update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "acp:tool:2",
          title: "Run checks",
          status: "completed",
        },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:tool:2",
      },
    ]);

    expect(events).toEqual([
      {
        type: "assistant",
        source: "acp",
        message: {
          content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: null }],
        },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:activity:1",
      },
      {
        type: "assistant",
        source: "acp",
        message: {
          content: [
            {
              type: "tool_use",
              id: "acp:tool:2",
              name: "Run checks",
              input: {},
            },
            {
              type: "tool_result",
              tool_use_id: "acp:tool:2",
              content: "",
              is_error: false,
            },
          ],
        },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:tool:2",
      },
    ]);
  });

  it("projects raw ACP plans and terminal tools without duplicate companions", () => {
    const events = normalizeWorklabEvents([
      {
        type: "acp_session_update",
        sessionId: "private-session",
        update: {
          sessionUpdate: "plan_update",
          entries: [{
            content: "Verify the build",
            priority: "high",
            status: "in_progress",
            _meta: { token: "private-plan-meta" },
          }],
          response: "private-plan-response",
        },
      },
      {
        type: "plan",
        source: "acp",
        update: {
          sessionUpdate: "plan_update",
          entries: [{ content: "Verify the build", priority: "high", status: "in_progress" }],
          raw: "private-plan-companion",
        },
      },
      {
        type: "acp_session_update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-2",
          title: "Build",
          status: "completed",
          rawOutput: "Build passed",
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-2", content: "Build passed" }],
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "acp_plan",
        action: "plan_update",
        title: "ACP plan updated",
        entries: [{ content: "Verify the build", priority: "high", status: "in_progress" }],
      },
      {
        type: "assistant",
        source: "acp",
        message: {
          content: [
            {
              type: "tool_use",
              id: "acp:legacy-tool:1",
              name: "Build",
              input: {},
            },
            {
              type: "tool_result",
              tool_use_id: "acp:legacy-tool:1",
              content: "Build passed",
              is_error: false,
            },
          ],
        },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:legacy-tool:1",
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private|rawOutput|response|_meta|sessionId|tool-2/);
  });

  it("compacts a realistic legacy ACP stream into native reasoning and tool blocks", () => {
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          sessionId: "PRIVATE_SESSION_SENTINEL",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Reviewing " },
            rawInput: "PRIVATE_RAW_INPUT_SENTINEL",
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: {
            content: [{
              type: "thinking",
              thinking: "Reviewing ",
              signature: "PRIVATE_SESSION_SENTINEL",
            }],
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          sessionId: "PRIVATE_SESSION_SENTINEL",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "the workspace." },
            rawOutput: "PRIVATE_RAW_OUTPUT_SENTINEL",
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: {
            content: [{
              type: "thinking",
              thinking: "the workspace.",
              signature: "PRIVATE_SESSION_SENTINEL",
            }],
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          sessionId: "PRIVATE_SESSION_SENTINEL",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "#" },
            rawInput: "PRIVATE_RAW_INPUT_SENTINEL",
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "#" }] },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          sessionId: "PRIVATE_SESSION_SENTINEL",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "## Hello" },
            rawOutput: "PRIVATE_RAW_OUTPUT_SENTINEL",
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "## Hello" }] },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          sessionId: "PRIVATE_SESSION_SENTINEL",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Run checks",
            kind: "execute",
            status: "in_progress",
            rawInput: { token: "PRIVATE_RAW_INPUT_SENTINEL" },
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: "Run checks",
              input: { token: "PRIVATE_RAW_INPUT_SENTINEL" },
            }],
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          sessionId: "PRIVATE_SESSION_SENTINEL",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            rawOutput: "Checks passed",
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Checks passed",
            }],
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "acp_session_update",
          sessionId: "PRIVATE_SESSION_SENTINEL",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-2",
            title: "Inspect files",
            kind: "read",
            status: "pending",
            rawInput: { path: "/workspace/src" },
          },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-2",
              name: "Inspect files",
              input: { path: "/workspace/src" },
            }],
          },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "assistant",
        source: "acp",
        message: { content: [{ type: "thinking", text: "Reviewing the workspace." }] },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:legacy-thought:1",
      },
      { type: "text", text: "### Hello", source: "acp" },
      {
        type: "assistant",
        source: "acp",
        message: {
          content: [
            {
              type: "tool_use",
              id: "acp:legacy-tool:1",
              name: "Run checks",
              input: { token: "[redacted]" },
            },
            {
              type: "tool_result",
              tool_use_id: "acp:legacy-tool:1",
              content: "Checks passed",
              is_error: false,
            },
          ],
        },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:legacy-tool:1",
      },
      {
        type: "assistant",
        source: "acp",
        message: {
          content: [{
            type: "tool_use",
            id: "acp:legacy-tool:2",
            name: "Inspect files",
            input: { path: "/workspace/src" },
          }],
        },
        _worklab_acp_projected: true,
        _worklab_display_key: "acp:legacy-tool:2",
      },
    ]);

    const serialized = JSON.stringify(events);
    for (const sentinel of [
      "PRIVATE_RAW_INPUT_SENTINEL",
      "PRIVATE_RAW_OUTPUT_SENTINEL",
      "PRIVATE_SESSION_SENTINEL",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).not.toMatch(/ACP agent activity|ACP tool ·|tool-1|tool-2/);
  });

  it("strictly projects normalized ACP context and provider lifecycle events", () => {
    const events = normalizeWorklabEvents([
      {
        type: "context_usage",
        source: "acp",
        model: "acp:profile-a",
        context: { used: 42, window: 1_000, response: "private-context" },
        cost: { amount: 0.25, currency: "USD", values: "private-cost" },
        _meta: { secret: "private-meta" },
      },
      {
        type: "provider_request_completed",
        sdk: "acp",
        model: "acp:profile-a",
        runtime: "acp-stdio",
        durationMs: 125.4,
        cancelled: false,
        response: { values: "private-provider" },
      },
      {
        type: "provider_status",
        source: "acp",
        kind: "retry_started",
        model: "acp:profile-a",
        retryIndex: 1,
        reason: "private-retry-reason",
        metadata: { token: "private-retry-meta" },
      },
    ]);

    expect(events).toEqual([
      { type: "acp_context_usage", used: 42, window: 1_000, cost: { amount: 0.25, currency: "USD" } },
      {
        type: "provider_request_completed",
        sdk: "acp",
        model: "acp:profile-a",
        durationMs: 125.4,
        cancelled: false,
      },
      {
        type: "acp_provider_status",
        status: "retry_started",
        title: "Retrying ACP provider",
        retryIndex: 1,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private|response|values|_meta|metadata|reason/);
  });

  it("never retains ACP interaction response values in timeline rows", () => {
    const event = normalizeAcpTimelineEvent({
      type: "acp_interaction_resolved",
      interaction_id: "private-interaction-id",
      interaction_kind: "permission",
      state: "resolved",
      disposition: "selected",
      response: { content: "private-answer", values: { token: "private-token" } },
    });

    expect(event).toEqual({
      type: "acp_interaction",
      action: "resolved",
      title: "ACP interaction resolved",
      detail: "Permission · Resolved · Selected",
    });
    expect(JSON.stringify(event)).not.toMatch(/private|response|values|interaction_id/);
  });

  it("allowlists labels from ACP command, mode, config, and session updates", () => {
    const events = [
      {
        type: "acp_session_update",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{
            name: "review",
            description: "Review changes",
            input: { hint: "Optional focus", response: "private-command" },
            _meta: { token: "private-command-meta" },
          }],
        },
      },
      {
        type: "acp_session_update",
        update: { sessionUpdate: "current_mode_update", currentModeId: "review", values: "private-mode" },
      },
      {
        type: "acp_session_update",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ id: "tone", name: "Tone", type: "select", currentValue: "private-value" }],
        },
      },
      {
        type: "acp_session_update",
        update: {
          sessionUpdate: "session_info_update",
          title: "Release review",
          updatedAt: "2026-08-02T18:00:00Z",
          response: "private-session-info",
        },
      },
    ].map(normalizeAcpTimelineEvent);

    expect(events[0]).toMatchObject({
      type: "acp_session_update",
      title: "ACP commands updated",
      items: [{ label: "review", detail: "Review changes · Optional focus" }],
    });
    expect(events[1]).toMatchObject({ title: "ACP session mode updated", detail: "Mode: review" });
    expect(events[2]).toMatchObject({
      title: "ACP configuration options updated",
      items: [{ label: "Tone", detail: "select" }],
    });
    expect(events[3]).toMatchObject({
      title: "ACP session information updated",
      items: [
        { label: "Title", detail: "Release review" },
        { label: "Updated", detail: "2026-08-02T18:00:00Z" },
      ],
    });
    expect(JSON.stringify(events)).not.toMatch(/private|response|values|_meta|currentValue/);
  });

  it("normalizes coordinator worktree reconciliation events", () => {
    expect(normalizeWorklabEvents([{
      type: "worktree_reconcile",
      status: "merged",
      ok: true,
      message: "Worktree merged into source checkout: abc1234 -> def5678.",
      branch: "worklab/run/run-1",
      sourceHeadBefore: "abc123456",
      sourceHeadAfter: "def567890",
      branchHead: "def567890",
    }])).toEqual([{
      type: "worktree_reconcile",
      text: "Worktree merged into source checkout: abc1234 -> def5678.",
      tone: "success",
      status: "merged",
      branch: "worklab/run/run-1",
      sourceHeadBefore: "abc1234",
      sourceHeadAfter: "def5678",
      branchHead: "def5678",
    }]);
  });

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

  it("compacts final result payloads after fragmented assistant text", () => {
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "Do" }] },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: "ne." }] },
        },
      },
      {
        type: "final",
        text: "Done.",
        model: "model-a",
      },
    ]);

    expect(events[2]).toMatchObject({
      type: "final",
      compact: true,
      text: "Done.",
      model: "model-a",
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

  it("hides provider status and thinking-token estimate events", () => {
    const events = normalizeWorklabEvents([
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "status", status: "requesting" } } },
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50 } } },
      { type: "sdk_event", event: { type: "system", subtype: "status", status: "requesting" } },
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } } } },
    ]);

    expect(events).toEqual([
      { type: "cli_event", raw: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } } },
    ]);
  });

  it("attaches hidden thinking-token estimates to the redacted block that follows", () => {
    const events = normalizeWorklabEvents([
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50 } } },
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "thinking_tokens", estimated_tokens: 207, estimated_tokens_delta: 157 } } },
      { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "sig-1" }] } } },
      { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "sig-2" }] } } },
    ]);

    expect(events).toEqual([
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 207 }] } },
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: null }] } },
    ]);
  });

  it("keeps token counts the worker already attached to redacted blocks", () => {
    const events = normalizeWorklabEvents([
      { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 420 }] } } },
    ]);

    expect(events).toEqual([
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 420 }] } },
    ]);
  });

  it("collapses thinking progress rows and drops the one a redacted block supersedes", () => {
    const events = normalizeWorklabEvents([
      { type: "thinking_progress", estimated_tokens: 50, estimated_tokens_delta: 50 },
      { type: "thinking_progress", estimated_tokens: 300, estimated_tokens_delta: 250 },
      { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 300 }] } } },
      { type: "thinking_progress", estimated_tokens: 80, estimated_tokens_delta: 80 },
    ]);

    expect(events).toEqual([
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 300 }] } },
      { type: "thinking_progress", estimated_tokens: 80, estimated_tokens_delta: 80 },
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

  it("keeps Codex file edits while filtering adjacent system and thinking metadata", () => {
    const changes = [{ path: "/workspace/src/index.js", kind: "update" }];
    const events = normalizeWorklabEvents([
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "status", status: "requesting" } } },
      { type: "sdk_event", event: { type: "cli_event", raw: { type: "system", subtype: "thinking_tokens", estimated_tokens: 144 } } },
      { type: "sdk_event", event: { type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "sig-1" }] } } },
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
      { type: "assistant", message: { content: [{ type: "thinking", text: "", redacted: true, estimated_tokens: 144 }] } },
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

  it("hides standalone worklab result assistant text before the terminal final event", () => {
    const progress = {
      schema: "worklab.v2",
      stage: "plan",
      decision: "advance",
      summary: "Repo structure found; now checking current rails.",
      details: "This is only progress, not the final plan.",
      final_text: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
    };
    const done = {
      schema: "worklab.v2",
      stage: "plan",
      decision: "advance",
      summary: "Plan ready.",
      details: "Final plan body.",
      final_text: "Plan ready.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
    };

    const events = normalizeWorklabEvents([
      { type: "started" },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: JSON.stringify(progress) }] },
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "cmd-1", name: "command_execution", input: { command: "git status --short" } }] },
        },
      },
      {
        type: "final",
        text: JSON.stringify(done),
        worklab_result: done,
        usage: {},
      },
    ]);

    expect(events).toEqual([
      { type: "started" },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "cmd-1", name: "command_execution", input: { command: "git status --short" } }] },
      },
      {
        type: "final",
        text: "Plan ready.",
        structured: done,
      },
    ]);
  });

  it("hides compacted standalone worklab result assistant text before the terminal final event", () => {
    const done = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "Integrated the v0 flow.",
      details: "Changed files and verified the app.",
      final_text: "Done. The v0 flow is integrated.",
      artifacts: {},
      blocking_issues: [],
      pending_actions: [],
      questions: [],
      subtasks: [],
      verification_evidence: [
        { kind: "test", command_or_url: "npm test", exit_code_or_status: "0", snippet: "passed", reason: "" },
      ],
    };
    const compactedText = `${JSON.stringify(done).slice(0, 420)}\n[truncated 277 chars; full raw log available]`;
    const events = normalizeWorklabEvents([
      { type: "started" },
      {
        type: "sdk_event",
        event: {
          type: "assistant",
          message: { content: [{ type: "text", text: compactedText }] },
        },
      },
      {
        type: "final",
        text: JSON.stringify(done),
        worklab_result: done,
        usage: {},
      },
    ]);

    expect(events).toEqual([
      { type: "started" },
      {
        type: "final",
        text: "Done. The v0 flow is integrated.",
        structured: done,
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

  it("normalizes Claude SDK result structured_output events as structured output", () => {
    const worklabResult = {
      schema: "worklab.v2",
      stage: "plan",
      decision: "delegate",
      summary: "Delegating audit tracks",
      final_text: "Plan ready.",
      subtasks: [{ title: "Audit server", instructions: "Read-only audit" }],
    };
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "result",
          subtype: "success",
          result: "Plan ready.",
          structured_output: worklabResult,
          usage: { input_tokens: 10, output_tokens: 5 },
          duration_ms: 100,
          num_turns: 2,
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "structured_output",
        source: "claude_sdk_output_format",
        value: worklabResult,
        worklab_result: worklabResult,
      },
    ]);
  });

  it("does not duplicate Claude structured output when a normalized event follows the SDK result", () => {
    const worklabResult = {
      schema: "worklab.v2",
      stage: "plan",
      decision: "delegate",
      summary: "Delegating audit tracks",
      final_text: "Plan ready.",
    };
    const events = normalizeWorklabEvents([
      {
        type: "sdk_event",
        event: {
          type: "result",
          subtype: "success",
          result: "Plan ready.",
          structured_output: worklabResult,
        },
      },
      {
        type: "sdk_event",
        event: {
          type: "structured_output",
          source: "claude_sdk_output_format",
          value: worklabResult,
          worklab_result: worklabResult,
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "structured_output",
        source: "claude_sdk_output_format",
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

  it("upserts coordinator ACP display revisions by stable display key", () => {
    const merged = mergeRunEvents(
      [{
        type: "acp_session_update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hel" },
        },
        _worklab_display_key: "acp:message:1",
        _worklab_display_revision: 1,
        _event_seq: 10,
      }],
      [{
        type: "acp_session_update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        },
        _worklab_display_key: "acp:message:1",
        _worklab_display_revision: 2,
        _event_seq: 12,
      }],
      { limit: 10 },
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      _worklab_display_key: "acp:message:1",
      _worklab_display_revision: 2,
      _event_seq: 12,
      update: { content: { text: "Hello" } },
    });
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
