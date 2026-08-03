import { describe, expect, it } from "vitest";

import {
  createAcpDisplayProjection,
  WORKLAB_ACP_COMPANION_FIELD,
} from "../../coordinator/spawn-worker/acp-display-projection.js";

function sdkEvent(event) {
  return { type: "sdk_event", event };
}

function rawUpdate(update) {
  return sdkEvent({ type: "acp_session_update", update });
}

describe("ACP display projection", () => {
  it("builds cumulative message, safe activity, and named tool upserts", () => {
    const projection = createAcpDisplayProjection();
    const privateReasoning = "PRIVATE_REASONING_SENTINEL";
    const privateToolInput = "PRIVATE_TOOL_INPUT_SENTINEL";
    const privateToolOutput = "PRIVATE_TOOL_OUTPUT_SENTINEL";
    const events = [
      rawUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: privateReasoning },
      }),
      sdkEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", text: privateReasoning }] },
      }),
      rawUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: `${privateReasoning}-continued` },
      }),
      sdkEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", text: `${privateReasoning}-continued` }] },
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
        rawInput: { token: privateToolInput },
      }),
      sdkEvent({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "provider-tool-private",
            name: "Read agenda",
            input: { token: privateToolInput },
          }],
        },
      }),
      rawUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "provider-tool-private",
        status: "completed",
        rawOutput: privateToolOutput,
      }),
      sdkEvent({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "provider-tool-private",
            content: privateToolOutput,
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

    const activity = displayEvents.filter((event) => (
      event.update?.sessionUpdate === "agent_thought_chunk"
    ));
    const messages = displayEvents.filter((event) => (
      event.update?.sessionUpdate === "agent_message_chunk"
    ));
    const tools = displayEvents.filter((event) => (
      ["tool_call", "tool_call_update"].includes(event.update?.sessionUpdate)
    ));

    expect(activity).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(messages[0]._worklab_display_key).toBe(messages[1]._worklab_display_key);
    expect(messages.at(-1).update.content.text).toBe("### Hello");
    expect(tools).toHaveLength(2);
    expect(tools[0]._worklab_display_key).toBe(tools[1]._worklab_display_key);
    expect(tools.at(-1).update).toMatchObject({
      title: "Read agenda",
      kind: "read",
      status: "completed",
    });
    expect(companions).toHaveLength(6);

    const serializedDisplay = JSON.stringify(displayEvents);
    expect(serializedDisplay).not.toMatch(
      /PRIVATE_|provider-message-private|provider-tool-private|rawInput|rawOutput/u,
    );
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

  it("bounds the cumulative display answer while raw chunks continue", () => {
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

    expect(first.displayEvent.update.content.text).toHaveLength(900);
    expect(overflow.displayEvent.update.content.text).toContain(
      "[truncated; full raw log available]",
    );
    expect(overflow.displayEvent.update.content.text.length).toBeLessThan(1_100);
    expect(afterLimit).toMatchObject({ suppressDisplay: true });
  });
});
