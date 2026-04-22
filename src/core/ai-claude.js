import { query } from "@anthropic-ai/claude-agent-sdk";

function thinkingForEffort(effort) {
  if (effort === "low") return { thinking: { type: "disabled" } };
  return { thinking: { type: "adaptive" }, effort };
}

function extractText(event) {
  if (event.type !== "assistant" || !event.message?.content) return "";
  let out = "";
  for (const block of event.message.content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}

export async function generateClaudeResponse(systemPrompt, options) {
  const {
    messages,
    model,
    effort = "medium",
    cwd,
    mcpServers,
    allowedTools,
    disallowedTools,
    permissionMode = "bypassPermissions",
    maxTurns = 30,
    abortSignal,
    onEvent = () => {},
  } = options;

  const thinkingOpts = thinkingForEffort(effort);

  const stream = query({
    prompt: messages,
    options: {
      systemPrompt,
      model: model.model,
      maxTurns,
      cwd,
      permissionMode,
      allowedTools,
      disallowedTools,
      mcpServers,
      ...thinkingOpts,
    },
  });

  let text = "";
  let usage = {};
  let durationMs = 0;
  let numTurns = 0;
  let cancelled = false;
  const capturedEvents = [];

  const abortHandler = async () => {
    cancelled = true;
    if (stream.return) await stream.return();
  };
  if (abortSignal) {
    if (abortSignal.aborted) await abortHandler();
    else abortSignal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    for await (const event of stream) {
      capturedEvents.push(event);
      onEvent(event);
      if (event.type === "assistant") text += extractText(event);
      else if (event.type === "result") {
        usage = event.usage || {};
        durationMs = event.duration_ms || 0;
        numTurns = event.num_turns || 0;
      }
      if (cancelled) break;
    }
  } finally {
    if (abortSignal) abortSignal.removeEventListener?.("abort", abortHandler);
  }

  return {
    text,
    events: capturedEvents,
    usage,
    durationMs,
    numTurns,
    model: model.model,
    effort,
    cancelled,
  };
}
