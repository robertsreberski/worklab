import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createFileEditToolResultEvent,
  createFileEditToolUseEvent,
  fileChangeSummary,
  readFileChangeSnapshot,
  statsForCompletedChange,
} from "../../core/file-change-stats.js";
import { formatLiveInputGuidance } from "../../core/live-input.js";
import { estimateCost } from "../../core/cost.js";
import { backendCapabilities } from "../../core/backend.js";

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

const CLAUDE_FILE_EDIT_MATCHER = "Edit|Write|NotebookEdit";

function mergeHookMatchers(existing = {}, additions = {}) {
  const merged = {};
  for (const [name, groups] of Object.entries(existing || {})) {
    if (Array.isArray(groups)) merged[name] = [...groups];
  }
  for (const [name, groups] of Object.entries(additions || {})) {
    if (!Array.isArray(groups) || !groups.length) continue;
    merged[name] = [...(merged[name] || []), ...groups];
  }
  return merged;
}

function objectInput(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function claudeEditPath(toolName, toolInput) {
  const input = objectInput(toolInput);
  if (toolName === "NotebookEdit") return input.notebook_path || input.file_path || "";
  return input.file_path || "";
}

function claudeEditKind(toolName, before) {
  if (toolName === "Write" && before && !before.exists) return "add";
  return "update";
}

function fileEditStateKey(input, toolUseID, path) {
  return toolUseID || input?.tool_use_id || input?.toolUseID || `${input?.tool_name || "file_edit"}:${path}`;
}

function fileEditPayload(change, { status, before, after, error } = {}) {
  const lineStats = statsForCompletedChange(change, before, after);
  const completedChange = lineStats ? { ...change, line_stats: lineStats } : change;
  const summary = fileChangeSummary([completedChange]);
  return {
    changes: [completedChange],
    status,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
  };
}

function createClaudeFileEditHooks({ cwd, emitEvent }) {
  const edits = new Map();
  const runCwd = cwd || process.cwd();

  function createState(input, toolUseID, { readBefore = true } = {}) {
    const toolName = input?.tool_name;
    const path = claudeEditPath(toolName, input?.tool_input);
    if (!path) return null;
    const resolvedPath = resolve(runCwd, path);
    const key = fileEditStateKey(input, toolUseID, resolvedPath);
    const before = readBefore ? readFileChangeSnapshot(resolvedPath) : null;
    return {
      key,
      id: `file_edit:${key}`,
      path: resolvedPath,
      change: { path: resolvedPath, kind: claudeEditKind(toolName, before) },
      before,
      started: false,
    };
  }

  function emitStart(state) {
    if (!state || state.started) return;
    emitEvent(createFileEditToolUseEvent(state.id, {
      changes: [state.change],
      status: "in_progress",
    }));
    state.started = true;
  }

  function complete(input, toolUseID, { status, error } = {}) {
    const directKey = toolUseID || input?.tool_use_id || input?.toolUseID;
    const fallback = createState(input, toolUseID, { readBefore: false });
    const state = (directKey && edits.get(directKey)) || (fallback?.key && edits.get(fallback.key)) || fallback;
    if (!state) return;
    emitStart(state);
    const after = readFileChangeSnapshot(state.path);
    const payload = fileEditPayload(state.change, {
      status,
      before: state.before,
      after,
      error,
    });
    emitEvent(createFileEditToolResultEvent(state.id, payload, { isError: status === "failed" }));
    edits.delete(state.key);
  }

  return {
    PreToolUse: [{
      matcher: CLAUDE_FILE_EDIT_MATCHER,
      hooks: [async (input, toolUseID) => {
        const state = createState(input, toolUseID);
        if (!state) return {};
        edits.set(state.key, state);
        emitStart(state);
        return {};
      }],
    }],
    PostToolUse: [{
      matcher: CLAUDE_FILE_EDIT_MATCHER,
      hooks: [async (input, toolUseID) => {
        complete(input, toolUseID, { status: "completed" });
        return {};
      }],
    }],
    PostToolUseFailure: [{
      matcher: CLAUDE_FILE_EDIT_MATCHER,
      hooks: [async (input, toolUseID) => {
        complete(input, toolUseID, {
          status: "failed",
          error: stringifyError(input?.error) || "tool failed",
        });
        return {};
      }],
    }],
  };
}

function promptStringFromMessages(messages) {
  return Array.isArray(messages)
    ? messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
    : String(messages || "");
}

function makeSdkUserMessage(body, sessionId, uuid = randomUUID()) {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid,
    message: {
      role: "user",
      content: body,
    },
  };
}

async function* livePromptMessages({ initialPrompt, liveInput, sessionId }) {
  yield makeSdkUserMessage(initialPrompt, sessionId);
  for await (const message of liveInput) {
    yield makeSdkUserMessage(formatLiveInputGuidance(message.body), sessionId, message.id || randomUUID());
  }
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
    hooks,
    permissionMode = "bypassPermissions",
    maxTurns,
    abortSignal,
    onEvent = () => {},
  } = options;

  const thinkingOpts = thinkingForEffort(effort);

  const promptString = promptStringFromMessages(messages);
  const runtimeWarnings = [];
  const capturedEvents = [];

  function emitEvent(event) {
    if (!event) return;
    capturedEvents.push(event);
    onEvent(event);
  }

  const queryOptions = {
    systemPrompt,
    model: model.model,
    cwd,
    permissionMode,
    allowedTools,
    disallowedTools,
    mcpServers,
    hooks: mergeHookMatchers(hooks, createClaudeFileEditHooks({ cwd, emitEvent })),
    ...thinkingOpts,
  };
  if (Number.isFinite(Number(maxTurns)) && Number(maxTurns) > 0) {
    queryOptions.maxTurns = Number(maxTurns);
  }

  const prompt = options.liveInput
    ? livePromptMessages({ initialPrompt: promptString, liveInput: options.liveInput, sessionId: randomUUID() })
    : promptString;
  const stream = query({ prompt, options: queryOptions });

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
      emitEvent(event);
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
          if (options.liveInput) break;
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

  const reference = model.reference || `claude:${model.model}`;
  const inputTokens = usage?.input_tokens ?? usage?.inputTokens ?? 0;
  const outputTokens = usage?.output_tokens ?? usage?.outputTokens ?? 0;
  const cachedTokens = usage?.cache_read_input_tokens ?? usage?.cache_read_tokens ?? 0;
  const cacheCreationTokens = usage?.cache_creation_input_tokens ?? usage?.cache_creation_tokens ?? 0;
  const costUsd = estimateCost({
    db: options.db,
    model: reference,
    inputTokens,
    outputTokens,
    cachedTokens,
  });
  const enrichedUsage = {
    ...usage,
    input_tokens: inputTokens || null,
    output_tokens: outputTokens || null,
    cache_read_tokens: cachedTokens || null,
    cache_creation_tokens: cacheCreationTokens || null,
    cost_usd: costUsd,
  };

  return {
    text: finalText(),
    events: capturedEvents,
    usage: enrichedUsage,
    durationMs,
    numTurns,
    model: model.model,
    effort,
    sdk: "claude",
    cancelled,
    error: errorMessage,
    failureKind,
    runtimeWarnings,
  };
}

export const claudeSdkBackend = {
  kind: "claude",
  capabilities: backendCapabilities("claude"),
  execute: generateClaudeResponse,
};
