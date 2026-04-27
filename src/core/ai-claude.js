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

function extractResultText(event) {
  if (event.type !== "result") return "";
  if (typeof event.result === "string") return event.result;
  if (event.result != null) return JSON.stringify(event.result);
  if (typeof event.final_output === "string") return event.final_output;
  if (event.final_output != null) return JSON.stringify(event.final_output);
  return "";
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

  // Single-turn: concatenate user messages into one prompt string for the SDK
  const promptString = Array.isArray(messages)
    ? messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
    : String(messages || "");

  const stream = query({
    prompt: promptString,
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
  let resultText = "";
  let cancelled = false;
  let errorMessage = null;
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
      else if (event.type === "error") {
        errorMessage = event.error?.message || event.error || "sdk stream error";
        break;
      } else if (event.type === "result") {
        usage = event.usage || {};
        durationMs = event.duration_ms || 0;
        numTurns = event.num_turns || 0;
        resultText = extractResultText(event) || resultText;
      }
      if (cancelled) break;
    }
  } finally {
    if (abortSignal) abortSignal.removeEventListener?.("abort", abortHandler);
  }

  return {
    text: resultText || text,
    events: capturedEvents,
    usage,
    durationMs,
    numTurns,
    model: model.model,
    effort,
    cancelled,
    error: errorMessage,
  };
}
