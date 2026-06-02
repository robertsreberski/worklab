// Normalizes OpenCode message parts (from `message.part.updated` events and the
// final `session.prompt` response) into the Anthropic-shaped RuntimeEvents the
// rest of the runtime/transcript layer consumes. Sibling of codex-events.js.
//
// OpenCode part shapes (from @opencode-ai/sdk types.gen):
//   ToolPart      { type:"tool", callID, tool, state:{ status, input, output?, error? } }
//   ReasoningPart { type:"reasoning", text }
//   TextPart      { type:"text", text }

export function toolUseEvent(part) {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: part.callID, name: part.tool, input: part.state?.input || {} }],
    },
  };
}

export function toolResultEvent(part) {
  const state = part.state || {};
  const isError = state.status === "error";
  return {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: part.callID,
        content: isError ? (state.error || "") : (state.output || ""),
        is_error: isError,
      }],
    },
  };
}

export function thinkingEvent(part) {
  return {
    type: "assistant",
    message: { content: [{ type: "thinking", text: part.text || "" }] },
  };
}

export function assistantTextEvent(text) {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text: text || "" }] },
  };
}

// A tool part is "settled" once it has produced output or errored — that's when
// we emit the tool_result half of the pair.
export function toolPartSettled(part) {
  const status = part?.state?.status;
  return status === "completed" || status === "error";
}
