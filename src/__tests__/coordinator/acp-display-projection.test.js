import { describe, expect, it } from "vitest";

import {
  createAcpDisplayProjection,
  WORKLAB_ACP_COMPANION_FIELD,
  WORKLAB_ACP_PROJECTED_FIELD,
} from "../../coordinator/spawn-worker/acp-display-projection.js";

function sdkEvent(event) {
  return { type: "sdk_event", event };
}

function rawUpdate(update) {
  return sdkEvent({ type: "acp_session_update", update });
}

describe("ACP display projection", () => {
  it("builds cumulative native messages, thoughts, and tool lifecycle upserts", () => {
    const projection = createAcpDisplayProjection();
    const reasoning = "Inspecting the task";
    const toolInput = "TOOL_INPUT_SENTINEL";
    const toolOutput = "TOOL_OUTPUT_SENTINEL";
    const credential = "PRIVATE_CREDENTIAL_SENTINEL";
    const events = [
      rawUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: reasoning },
      }),
      sdkEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", text: reasoning }] },
      }),
      rawUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: " and choosing a tool." },
      }),
      sdkEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", text: " and choosing a tool." }] },
      }),
      rawUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "provider-message-private",
        content: { type: "text", text: "#" },
      }),
      sdkEvent({ type: "assistant", message: { content: [{ type: "text", text: "#" }] } }),
      rawUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "provider-message-private",
        content: { type: "text", text: "## Hello" },
      }),
      sdkEvent({ type: "assistant", message: { content: [{ type: "text", text: "## Hello" }] } }),
      rawUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "provider-tool-private",
        title: "Read agenda",
        kind: "read",
        status: "in_progress",
        rawInput: {
          query: toolInput,
          apiKey: credential,
          sessionId: "provider-session-private",
          _meta: { transport: "private" },
        },
      }),
      sdkEvent({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "provider-tool-private",
            name: "Read agenda",
            input: { query: toolInput },
          }],
        },
      }),
      rawUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "provider-tool-private",
        status: "completed",
        rawOutput: {
          result: toolOutput,
          session_id: "provider-session-private",
          _meta: { response: "private" },
        },
      }),
      sdkEvent({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "provider-tool-private",
            content: toolOutput,
          }],
        },
      }),
    ];

    const projected = events.map((event) => projection.project(event));
    const displayEvents = projected
      .filter((entry) => entry.displayEvent)
      .map((entry) => entry.displayEvent);
    const companions = projected.filter((entry) => entry.suppressDisplay && (
      entry.rawEvent?.[WORKLAB_ACP_COMPANION_FIELD] === true
    ));

    const blockTypes = (event) => event.message?.content?.map((block) => block.type) || [];
    const thoughts = displayEvents.filter((event) => blockTypes(event).includes("thinking"));
    const messages = displayEvents.filter((event) => blockTypes(event).includes("text"));
    const tools = displayEvents.filter((event) => blockTypes(event).includes("tool_use"));

    expect(thoughts).toHaveLength(2);
    expect(thoughts[0]._worklab_display_key).toBe(thoughts[1]._worklab_display_key);
    expect(thoughts.at(-1).message.content).toEqual([{
      type: "thinking",
      text: `${reasoning} and choosing a tool.`,
    }]);
    expect(messages).toHaveLength(2);
    expect(messages[0]._worklab_display_key).toBe(messages[1]._worklab_display_key);
    expect(messages.at(-1).message.content).toEqual([{ type: "text", text: "### Hello" }]);
    expect(tools).toHaveLength(2);
    expect(tools[0]._worklab_display_key).toBe(tools[1]._worklab_display_key);
    const [toolUse, toolResult] = tools.at(-1).message.content;
    expect(toolUse).toEqual({
      type: "tool_use",
      id: tools.at(-1)._worklab_display_key,
      name: "Read agenda",
      input: { query: toolInput, apiKey: "[redacted]" },
    });
    expect(toolResult).toEqual({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify({ result: toolOutput }),
      is_error: false,
    });
    expect(displayEvents.every((event) => (
      event.type === "assistant"
      && event.source === "acp"
      && event[WORKLAB_ACP_PROJECTED_FIELD] === true
    ))).toBe(true);
    expect(companions).toHaveLength(6);

    const serializedDisplay = JSON.stringify(displayEvents);
    expect(serializedDisplay).not.toMatch(
      /provider-message-private|provider-tool-private|provider-session-private|_meta|sessionId|session_id|rawInput|rawOutput/u,
    );
    expect(serializedDisplay).toContain(reasoning);
    expect(serializedDisplay).toContain(toolInput);
    expect(serializedDisplay).toContain(toolOutput);
    expect(serializedDisplay).not.toContain(credential);
    expect(projected[0].rawEvent.event.update.content.text).toBe(reasoning);
    expect(projected[8].rawEvent.event.update.toolCallId).toBe("provider-tool-private");
  });

  it("marks non-text message companions while keeping them out of display history", () => {
    const projection = createAcpDisplayProjection();
    const secret = "PRIVATE_IMAGE_SENTINEL";
    const raw = projection.project(rawUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: secret, mimeType: "image/png" },
    }));
    const companion = projection.project(sdkEvent({
      type: "assistant",
      message: { content: [{ type: "image", data: secret, mimeType: "image/png" }] },
    }));

    expect(raw).toMatchObject({ suppressDisplay: true });
    expect(raw.displayEvent).toBeUndefined();
    expect(companion).toMatchObject({
      suppressDisplay: true,
      rawEvent: { [WORKLAB_ACP_COMPANION_FIELD]: true },
    });
  });

  it("applies ACP patch semantics and renders failed terminal updates without a start", () => {
    const projection = createAcpDisplayProjection();
    const first = projection.project(rawUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "provider-tool-id",
      title: "Run command",
      name: "shell",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
    }));
    const cleared = projection.project(rawUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "provider-tool-id",
      title: null,
      name: null,
      kind: null,
      rawInput: null,
    }));
    const failed = projection.project(rawUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "provider-tool-id",
      status: "failed",
      content: { type: "text", text: "command failed" },
    }));

    expect(first.displayKey).toBe(cleared.displayKey);
    expect(cleared.displayKey).toBe(failed.displayKey);
    expect(cleared.displayEvent.message.content).toEqual([{
      type: "tool_use",
      id: first.displayKey,
      name: "shell",
      input: {},
    }]);
    expect(failed.displayEvent.message.content).toEqual([
      {
        type: "tool_use",
        id: first.displayKey,
        name: "shell",
        input: {},
      },
      {
        type: "tool_result",
        tool_use_id: first.displayKey,
        content: JSON.stringify({ type: "text", text: "command failed" }),
        is_error: true,
      },
    ]);
  });

  it("starts a new native thinking block when another event interrupts the burst", () => {
    const projection = createAcpDisplayProjection();
    const first = projection.project(rawUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "First" },
    }));
    projection.project(sdkEvent({
      type: "assistant",
      message: { content: [{ type: "thinking", text: "First" }] },
    }));
    const continued = projection.project(rawUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: " thought" },
    }));
    projection.project(rawUpdate({
      sessionUpdate: "usage_update",
      used: 10,
      size: 1_000,
    }));
    const next = projection.project(rawUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Second thought" },
    }));

    expect(first.displayKey).toBe(continued.displayKey);
    expect(continued.displayEvent.message.content[0].text).toBe("First thought");
    expect(next.displayKey).not.toBe(first.displayKey);
    expect(next.displayEvent.message.content[0].text).toBe("Second thought");
  });

  it("bounds cumulative native message and thinking text while raw chunks continue", () => {
    const projection = createAcpDisplayProjection({ textLimit: 1_000 });
    const first = projection.project(rawUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a".repeat(900) },
    }));
    projection.project(sdkEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "a".repeat(900) }] },
    }));
    const overflow = projection.project(rawUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "b".repeat(200) },
    }));
    projection.project(sdkEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "b".repeat(200) }] },
    }));
    const afterLimit = projection.project(rawUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "c".repeat(200) },
    }));

    expect(first.displayEvent.message.content[0].text).toHaveLength(900);
    expect(overflow.displayEvent.message.content[0].text).toContain(
      "[truncated; full raw log available]",
    );
    expect(overflow.displayEvent.message.content[0].text.length).toBeLessThan(1_100);
    expect(afterLimit).toMatchObject({ suppressDisplay: true });

    const thought = projection.project(rawUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "t".repeat(1_200) },
    }));
    const afterThoughtLimit = projection.project(rawUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "ignored" },
    }));
    expect(thought.displayEvent.message.content[0].text).toContain(
      "[truncated; full raw log available]",
    );
    expect(afterThoughtLimit).toMatchObject({ suppressDisplay: true });
  });
});
