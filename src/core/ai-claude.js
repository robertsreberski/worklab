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

function stringifyError(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function humanizeSubtype(subtype) {
  return String(subtype || "").replace(/^error_/, "").replace(/_/g, " ").trim();
}

function resultEventError(event) {
  if (event.type !== "result") return null;
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  const errors = Array.isArray(event.errors) ? event.errors.filter(Boolean) : [];
  const explicit = stringifyError(event.error) || stringifyError(event.message);
  if (!event.is_error && !subtype.startsWith("error_") && errors.length === 0 && !explicit) return null;

  const detail = explicit || errors.map(stringifyError).filter(Boolean).join("; ");
  const label = humanizeSubtype(subtype);
  const message = subtype === "error_max_turns"
    ? "Claude stopped before final output: max turns reached"
    : `Claude result error${label ? ` (${label})` : ""}${detail ? `: ${detail}` : ""}`;
  return {
    message,
    failureKind: subtype === "error_max_turns" ? "usage_limit" : "provider_unavailable",
  };
}

function makeRuntimeWarning(message) {
  return {
    warning_kind: "claude_post_success_error",
    message,
  };
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
    maxTurns,
    abortSignal,
    onEvent = () => {},
  } = options;

  const thinkingOpts = thinkingForEffort(effort);

  // Single-turn: concatenate user messages into one prompt string for the SDK
  const promptString = Array.isArray(messages)
    ? messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
    : String(messages || "");

  const queryOptions = {
    systemPrompt,
    model: model.model,
    cwd,
    permissionMode,
    allowedTools,
    disallowedTools,
    mcpServers,
    ...thinkingOpts,
  };
  if (Number.isFinite(Number(maxTurns)) && Number(maxTurns) > 0) {
    queryOptions.maxTurns = Number(maxTurns);
  }

  const stream = query({ prompt: promptString, options: queryOptions });

  let text = "";
  let usage = {};
  let durationMs = 0;
  let numTurns = 0;
  let resultText = "";
  let cancelled = false;
  let errorMessage = null;
  let failureKind = null;
  let successfulResultSeen = false;
  let postSuccessErrorSeen = false;
  const runtimeWarnings = [];
  const capturedEvents = [];

  const finalText = () => resultText || text;

  function hasUsableFinalOutput() {
    return String(finalText() || "").trim().length > 0;
  }

  function preservePostSuccessError(message) {
    if (postSuccessErrorSeen) return;
    postSuccessErrorSeen = true;
    runtimeWarnings.push(makeRuntimeWarning(message));
  }

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
        const message = event.error?.message || event.error || "sdk stream error";
        if (successfulResultSeen && hasUsableFinalOutput()) {
          preservePostSuccessError(`Claude SDK emitted an error after final output; preserved final result. ${message}`);
        } else {
          errorMessage = message;
          failureKind = "provider_unavailable";
        }
        break;
      } else if (event.type === "result") {
        const resultError = resultEventError(event);
        if (resultError) {
          if (successfulResultSeen && hasUsableFinalOutput()) {
            preservePostSuccessError(`Claude SDK emitted an error after final output; preserved final result. ${resultError.message}`);
          } else {
            errorMessage = resultError.message;
            failureKind = resultError.failureKind;
          }
        } else {
          usage = event.usage || {};
          durationMs = event.duration_ms || 0;
          numTurns = event.num_turns || 0;
          resultText = extractResultText(event) || resultText;
          successfulResultSeen = true;
        }
      }
      if (cancelled) break;
    }
  } catch (err) {
    if (!cancelled) {
      const message = err?.message || String(err);
      if (successfulResultSeen && hasUsableFinalOutput()) {
        preservePostSuccessError(`Claude SDK stream failed after final output; preserved final result. ${message}`);
      } else {
        errorMessage = message;
        failureKind = "provider_unavailable";
      }
    }
  } finally {
    if (abortSignal) abortSignal.removeEventListener?.("abort", abortHandler);
  }

  return {
    text: finalText(),
    events: capturedEvents,
    usage,
    durationMs,
    numTurns,
    model: model.model,
    effort,
    cancelled,
    error: errorMessage,
    failureKind,
    runtimeWarnings,
  };
}
