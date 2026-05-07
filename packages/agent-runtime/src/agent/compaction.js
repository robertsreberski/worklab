import { randomUUID } from "node:crypto";

export const COMPACTED_CONTEXT_MARKER = "Compacted prior Worklab context";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_TRIGGER_RATIO = 0.85;
const DEFAULT_KEEP_RECENT_TOKENS = 24000;
const DEFAULT_SUMMARY_MAX_TOKENS = 16000;
const DEFAULT_MIN_SAVINGS_TOKENS = 20000;
const DEFAULT_TOOL_PAYLOAD_COMPACTION_TRIGGER_CHARS = 0;
const DEFAULT_TOOL_PRUNE_TRIGGER_TOKENS = 40000;
// intelligence-ramp Phase 3: lifted from 16K/20K/12K. Mid-task tool reads
// (large file edits, long bash output, deep MCP results) were being silently
// clipped before the agent could reason about them. The 256KB hard ceiling
// in tool-bloat.js still protects against runaway payloads.
const DEFAULT_TOOL_TEXT_LIMIT_CHARS = 64000;
const DEFAULT_BASH_OUTPUT_LIMIT_CHARS = 64000;
const DEFAULT_MCP_TEXT_LIMIT_CHARS = 48000;
const DEFAULT_SEARCH_RESULT_LIMIT = 100;
const DEFAULT_IMAGE_INLINE_MAX_BYTES = 250000;
const DEFAULT_TOOL_PAYLOAD_MAX_BYTES = 262144;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 120000;

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function clampInteger(value, fallback, min, max) {
  return Math.floor(clampNumber(value, fallback, min, max));
}

function jsonString(value) {
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

function base64Bytes(data) {
  const text = String(data || "");
  if (!text) return 0;
  const clean = text.includes(",") ? text.slice(text.indexOf(",") + 1) : text;
  return Math.floor(clean.length * 0.75);
}

function textPart(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  if (typeof value.text === "string") return value.text;
  if (typeof value.thinking === "string") return value.thinking;
  if (value.type === "image") return `[image ${base64Bytes(value.data)} bytes]`;
  if (value.type === "toolCall") return `${value.name || "tool"} ${jsonString(value.arguments || value.input || {})}`;
  return jsonString(value);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textPart).join("\n");
  return textPart(content);
}

function messageText(message) {
  if (!message) return "";
  const base = contentText(message.content);
  if (message.role === "toolResult") {
    return [
      `Tool result: ${message.toolName || "unknown"}`,
      message.isError ? "Status: error" : "",
      base,
      message.details ? jsonString(message.details) : "",
    ].filter(Boolean).join("\n");
  }
  return base;
}

export function estimateAgentMessageTokens(message) {
  const text = messageText(message);
  let chars = text.length + 12;
  let imageBytes = 0;
  const parts = Array.isArray(message?.content) ? message.content : [];
  for (const part of parts) {
    if (part?.type === "image") imageBytes += base64Bytes(part.data);
  }
  const tokens = Math.ceil(chars / 4) + Math.ceil(imageBytes / 3);
  return { tokens, chars, imageBytes };
}

export function estimateAgentMessages(messages = []) {
  return messages.reduce((acc, message) => {
    const next = estimateAgentMessageTokens(message);
    acc.tokens += next.tokens;
    acc.chars += next.chars;
    acc.imageBytes += next.imageBytes;
    return acc;
  }, { tokens: 0, chars: 0, imageBytes: 0 });
}

export function estimateFirstTurnInput({ systemPrompt = "", messages = [] } = {}) {
  const overheadChars = String(systemPrompt || "").length;
  const overheadTokens = Math.ceil(overheadChars / 4);
  const messageEstimate = estimateAgentMessages(messages);
  return {
    overheadTokens,
    overheadChars,
    inputTokens: overheadTokens + messageEstimate.tokens,
    inputChars: overheadChars + messageEstimate.chars,
  };
}

export function resolveAgentCompactionPolicy(settings = {}, model = {}) {
  const contextWindow = clampInteger(model?.contextWindow, DEFAULT_CONTEXT_WINDOW, 32000, 10_000_000);
  const triggerRatio = clampNumber(
    settings.agent_compaction_trigger_ratio,
    DEFAULT_TRIGGER_RATIO,
    0.2,
    0.95,
  );
  const reserveTokens = Math.max(16000, Math.min(64000, Math.floor(contextWindow * 0.25)));
  const ratioTrigger = Math.floor(contextWindow * triggerRatio);
  const reserveTrigger = Math.max(1, contextWindow - reserveTokens);
  return {
    enabled: settings.agent_compaction_enabled !== false,
    contextWindow,
    triggerRatio,
    triggerTokens: Math.min(ratioTrigger, reserveTrigger),
    keepRecentTokens: clampInteger(settings.agent_compaction_keep_recent_tokens, DEFAULT_KEEP_RECENT_TOKENS, 4000, 200000),
    summaryMaxTokens: clampInteger(settings.agent_compaction_summary_max_tokens, DEFAULT_SUMMARY_MAX_TOKENS, 1000, 64000),
    compactionMinSavingsTokens: clampInteger(settings.agent_compaction_min_savings_tokens, DEFAULT_MIN_SAVINGS_TOKENS, 0, 500000),
    toolPayloadCompactionTriggerChars: clampInteger(
      settings.agent_tool_payload_compaction_trigger_chars,
      DEFAULT_TOOL_PAYLOAD_COMPACTION_TRIGGER_CHARS,
      0,
      10 * 1024 * 1024,
    ),
    toolPruneTriggerTokens: clampInteger(settings.agent_tool_prune_trigger_tokens, DEFAULT_TOOL_PRUNE_TRIGGER_TOKENS, 0, 500000),
    toolTextLimitChars: clampInteger(settings.agent_tool_text_limit_chars, DEFAULT_TOOL_TEXT_LIMIT_CHARS, 1000, 200000),
    bashOutputLimitChars: clampInteger(settings.agent_bash_output_limit_chars, DEFAULT_BASH_OUTPUT_LIMIT_CHARS, 1000, 200000),
    mcpTextLimitChars: clampInteger(settings.agent_mcp_text_limit_chars, DEFAULT_MCP_TEXT_LIMIT_CHARS, 1000, 200000),
    searchResultLimit: clampInteger(settings.agent_search_result_limit, DEFAULT_SEARCH_RESULT_LIMIT, 10, 1000),
    imageInlineMaxBytes: clampInteger(settings.agent_image_inline_max_bytes, DEFAULT_IMAGE_INLINE_MAX_BYTES, 0, 10 * 1024 * 1024),
    toolPayloadMaxBytes: clampInteger(settings.agent_tool_payload_max_bytes, DEFAULT_TOOL_PAYLOAD_MAX_BYTES, 0, 16 * 1024 * 1024),
    mcpCallTimeoutMs: clampInteger(settings.agent_mcp_call_timeout_ms, DEFAULT_MCP_CALL_TIMEOUT_MS, 1000, Number.MAX_SAFE_INTEGER),
  };
}

function assistantToolCalls(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((part) => part?.type === "toolCall");
}

function hasToolCalls(message) {
  return assistantToolCalls(message).length > 0;
}

function chooseFirstKeptIndex(messages, keepRecentTokens) {
  if (!Array.isArray(messages) || messages.length <= 2) return -1;
  let tokens = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    tokens += estimateAgentMessageTokens(messages[i]).tokens;
    if (tokens >= keepRecentTokens) {
      start = i;
      break;
    }
  }
  if (start <= 0 || start >= messages.length) return -1;

  while (start > 0 && messages[start]?.role === "toolResult") start -= 1;
  if (start > 0 && messages[start]?.role === "assistant" && !hasToolCalls(messages[start])) {
    for (let i = start - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") {
        start = i;
        break;
      }
      if (messages[i]?.role === "toolResult") break;
    }
  }
  return start <= 0 ? -1 : start;
}

function oneLine(value, limit = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}

function extractPathish(value) {
  if (!value || typeof value !== "object") return "";
  return value.file_path || value.path || value.command || value.pattern || value.url || "";
}

function summarizeCompactedMessages(messages, { maxChars }) {
  const previousSummaries = [];
  const userNotes = [];
  const assistantNotes = [];
  const toolActions = [];
  const toolErrors = [];
  const changedFiles = new Set();

  for (const message of messages) {
    const text = messageText(message);
    if (text.includes(COMPACTED_CONTEXT_MARKER)) {
      previousSummaries.push(oneLine(text, 1000));
      continue;
    }
    if (message.role === "user") {
      userNotes.push(oneLine(text));
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = assistantToolCalls(message);
      if (toolCalls.length) {
        for (const call of toolCalls) {
          const args = call.arguments || call.input || {};
          const pathish = extractPathish(args);
          toolActions.push(`${call.name || "tool"}${pathish ? `: ${oneLine(pathish, 180)}` : ""}`);
          if (["Write", "Edit"].includes(call.name) && args.file_path) changedFiles.add(args.file_path);
        }
      } else {
        assistantNotes.push(oneLine(text));
      }
      continue;
    }
    if (message.role === "toolResult") {
      const details = message.details || {};
      const params = details.params || details.input || {};
      const pathish = extractPathish(params);
      toolActions.push(`${message.toolName || details.tool || "tool"} result${pathish ? `: ${oneLine(pathish, 180)}` : ""}`);
      const changes = details.changes || params.changes || [];
      for (const change of Array.isArray(changes) ? changes : []) {
        if (change?.path) changedFiles.add(change.path);
      }
      if (message.isError) toolErrors.push(oneLine(text, 300));
    }
  }

  const sections = [
    previousSummaries.length ? ["Historical context from previous compactions:", ...previousSummaries.slice(-6).map((item) => `- ${item}`)].join("\n") : "",
    userNotes.length ? ["Recent user/task instructions from compacted prefix:", ...userNotes.slice(-8).map((item) => `- ${item}`)].join("\n") : "",
    assistantNotes.length ? ["Agent progress from compacted prefix:", ...assistantNotes.slice(-8).map((item) => `- ${item}`)].join("\n") : "",
    toolActions.length ? ["Tool activity from compacted prefix:", ...toolActions.slice(-20).map((item) => `- ${item}`)].join("\n") : "",
    changedFiles.size ? ["Files likely touched before compaction:", ...[...changedFiles].slice(0, 20).map((item) => `- ${item}`)].join("\n") : "",
    toolErrors.length ? ["Tool errors observed before compaction:", ...toolErrors.slice(-8).map((item) => `- ${item}`)].join("\n") : "",
  ].filter(Boolean);

  const summary = sections.join("\n\n") || "Prior context contained no compactable text.";
  return summary.length <= maxChars
    ? summary
    : `${summary.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n[compaction summary truncated]`;
}

function buildCompactionMessage({ id, seq, metrics, firstKeptIndex, compactedCount, summary }) {
  return {
    role: "user",
    timestamp: Date.now(),
    content: [
      `# ${COMPACTED_CONTEXT_MARKER}`,
      "",
      `Compaction id: ${id}`,
      `Compaction sequence: ${seq}`,
      `Compacted messages: ${compactedCount}`,
      `First kept message index: ${firstKeptIndex}`,
      `Estimated tokens before compaction: ${metrics.before.tokens}`,
      `Estimated tokens after compaction: ${metrics.after.tokens}`,
      "",
      "The raw earlier transcript was compacted to keep this long autonomous session within the model context window. Continue from the current workspace state and the recent uncompressed messages below.",
      "",
      summary,
    ].join("\n"),
  };
}

function firstNonEmptyLine(text) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return "";
}

function summarizeToolResultBody(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  let textChars = 0;
  let firstSnippet = "";
  let imageCount = 0;
  let imageBytes = 0;
  for (const part of parts) {
    if (part?.type === "text") {
      const t = String(part.text || "");
      textChars += t.length;
      if (!firstSnippet) firstSnippet = firstNonEmptyLine(t);
    } else if (part?.type === "image") {
      imageCount += 1;
      imageBytes += base64Bytes(part.data);
    }
  }
  const facts = [];
  if (textChars > 0) facts.push(`${textChars} text chars`);
  if (imageCount > 0) facts.push(`${imageCount} image${imageCount === 1 ? "" : "s"} (~${imageBytes} bytes)`);
  if (message?.isError) facts.push("status: error");
  if (firstSnippet) {
    const snip = firstSnippet.length > 160 ? `${firstSnippet.slice(0, 160).trimEnd()}…` : firstSnippet;
    facts.push(`first line: "${snip}"`);
  }
  return facts.join("; ");
}

// Replace older tool_result bodies with a 1–3 sentence lossy summary
// instead of dropping them. Keeps the agent able to reason about prior
// work (filename, byte count, error status, first-line excerpt) without
// paying the original payload cost. The full payload remains on disk
// under <runArtifactDir>/tool-output/ for explicit re-fetch via the
// artifact path that tool-bloat.js records in details.
function pruneToolResultContent(message, metrics) {
  const details = {
    ...(message.details || {}),
    context_pruned: true,
    pruned_tokens_estimate: metrics.tokens,
    pruned_chars_estimate: metrics.chars,
  };
  const toolLabel = message.toolName || details.tool || "tool";
  const artifact = details.artifact_path || details.full_output_path || details.path || null;
  const summary = summarizeToolResultBody(message);
  const lines = [
    `[older ${toolLabel} result, summarized to free ~${metrics.tokens} tokens of context]`,
  ];
  if (summary) lines.push(summary);
  if (artifact) lines.push(`Full output preserved at: ${artifact}`);
  else lines.push("Re-issue a targeted tool call (narrower query / smaller range) if the raw payload is needed again.");
  const content = [{ type: "text", text: lines.join("\n") }];
  return { ...message, content, details };
}

function pruneOldToolResults(messages, policy) {
  if (!Array.isArray(messages) || !policy?.toolPruneTriggerTokens) {
    return { changed: false, messages, prunedCount: 0, tokensBefore: 0, tokensAfter: 0 };
  }
  const firstProtectedIndex = chooseFirstKeptIndex(messages, policy.keepRecentTokens);
  if (firstProtectedIndex <= 0) {
    return { changed: false, messages, prunedCount: 0, tokensBefore: 0, tokensAfter: 0 };
  }

  let prunableTokens = 0;
  const metricsByIndex = new Map();
  for (let i = 0; i < firstProtectedIndex; i += 1) {
    if (messages[i]?.role !== "toolResult") continue;
    if (messages[i]?.details?.context_pruned) continue;
    const metrics = estimateAgentMessageTokens(messages[i]);
    prunableTokens += metrics.tokens;
    metricsByIndex.set(i, metrics);
  }
  if (prunableTokens < policy.toolPruneTriggerTokens) {
    return { changed: false, messages, prunedCount: 0, tokensBefore: prunableTokens, tokensAfter: prunableTokens };
  }

  let prunedCount = 0;
  const next = messages.map((message, index) => {
    const metrics = metricsByIndex.get(index);
    if (!metrics) return message;
    prunedCount += 1;
    return pruneToolResultContent(message, metrics);
  });
  const tokensAfter = [...metricsByIndex.keys()]
    .reduce((sum, index) => sum + estimateAgentMessageTokens(next[index]).tokens, 0);
  return {
    changed: prunedCount > 0,
    messages: next,
    prunedCount,
    tokensBefore: prunableTokens,
    tokensAfter,
  };
}

function replaceMessagesInPlace(target, next) {
  if (!Array.isArray(target) || target === next) return next;
  target.splice(0, target.length, ...next);
  return target;
}

function truncateText(text, limit, label) {
  const value = String(text || "");
  if (value.length <= limit) {
    return { text: value, truncated: false, originalLength: value.length };
  }
  // First-class truncation marker: tells the model exactly what was cut and
  // what it should do about it. The audit found agents failing tasks because
  // they didn't notice silent ellipses — be loud and actionable.
  const totalKb = Math.round(value.length / 1024);
  const shownKb = Math.round(limit / 1024);
  const marker = [
    "",
    `[!!! ${label || "tool"} OUTPUT TRUNCATED — ${shownKb}KB of ${totalKb}KB shown above. The tool returned ${value.length - limit} more characters that you cannot see.]`,
    "If those characters matter for the task, narrow the query (smaller range, more specific pattern) or paginate. Don't assume the missing tail is empty.",
  ].join("\n");
  return {
    text: `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`,
    truncated: true,
    originalLength: value.length,
  };
}

export function compactToolResultForContext(result, policy, { toolName = "tool" } = {}) {
  if (!Array.isArray(result?.content) || !policy) return { changed: false, result };
  const limit = toolName === "Bash" ? policy.bashOutputLimitChars : policy.toolTextLimitChars;
  let changed = false;
  let originalTextChars = 0;
  let keptTextChars = 0;
  let omittedImages = 0;
  const content = result.content.map((part) => {
    if (part?.type === "text") {
      const truncated = truncateText(part.text || "", limit, toolName);
      originalTextChars += truncated.originalLength;
      keptTextChars += truncated.text.length;
      if (truncated.truncated) changed = true;
      return { ...part, text: truncated.text };
    }
    if (part?.type === "image") {
      const bytes = base64Bytes(part.data);
      if (policy.imageInlineMaxBytes >= 0 && bytes > policy.imageInlineMaxBytes) {
        changed = true;
        omittedImages += 1;
        return {
          type: "text",
          text: `[omitted inline image from ${toolName}: ${bytes} bytes exceeds ${policy.imageInlineMaxBytes} byte context budget]`,
        };
      }
      return part;
    }
    const serialized = jsonString(part);
    const truncated = truncateText(serialized, limit, toolName);
    originalTextChars += truncated.originalLength;
    keptTextChars += truncated.text.length;
    if (truncated.truncated || truncated.text !== serialized) changed = true;
    return { type: "text", text: truncated.text };
  });

  if (!changed) return { changed: false, result };
  return {
    changed: true,
    result: {
      ...result,
      content,
      details: {
        ...(result.details || {}),
        context_compacted: true,
        original_text_chars: originalTextChars || null,
        kept_text_chars: keptTextChars || null,
        omitted_images: omittedImages || null,
        text_limit_chars: limit,
        image_inline_max_bytes: policy.imageInlineMaxBytes,
      },
    },
  };
}

export function isLikelyContextTermination(message, diagnostics = {}) {
  const text = String(message || "");
  if (!/terminated|aborted before final output|aborted before final|stream.*aborted|context window|context budget/i.test(text)) return false;
  const compactions = Number(diagnostics.context_compactions) || 0;
  if (compactions > 0) return true;
  const estimate = Number(diagnostics.context_tokens_estimate_max || diagnostics.context_tokens_estimate || 0);
  const trigger = Number(diagnostics.context_compaction_trigger_tokens || 0);
  return Boolean(trigger > 0 && estimate >= trigger * 0.85);
}

export function createAgentCompactionManager({
  runId,
  providerKind,
  modelReference,
  model,
  settings = {},
  onEvent,
  onCompactionRecorded,
} = {}) {
  const policy = resolveAgentCompactionPolicy(settings, model);
  let compactionCount = 0;
  let toolResultsCompacted = 0;
  let toolResultsPruned = 0;
  let toolPayloadCharsSinceCompaction = 0;
  let maxToolPayloadCharsSinceCompaction = 0;
  let forcedCompactionReason = null;
  let maxContextTokensEstimate = 0;
  let lastCompactionId = null;
  let lastError = null;
  let skippedLowSavings = 0;
  let lastLowSavingsSkipTokens = 0;

  function emit(event) {
    onEvent?.(event);
  }

  // The host (worklab worker) owns persistence: it receives the structured
  // record below and writes it into `run_compactions`. The kernel emits a
  // runtime_warning if the host's callback throws.
  function record(row) {
    if (!onCompactionRecorded || !runId) return;
    const persisted = {
      id: row.id,
      task_run_id: runId,
      seq: row.seq,
      trigger: row.trigger,
      provider_kind: providerKind || null,
      model: modelReference || model?.id || null,
      tokens_before: row.tokensBefore || null,
      tokens_after: row.tokensAfter || null,
      chars_before: row.charsBefore || null,
      chars_after: row.charsAfter || null,
      first_kept_index: row.firstKeptIndex ?? null,
      summary: row.summary || "",
      metadata_json: JSON.stringify(row.metadata || {}),
      status: row.status || "succeeded",
      error_text: row.errorText || null,
      created_at: Date.now(),
    };
    try {
      onCompactionRecorded(persisted);
    } catch (err) {
      lastError = err?.message || String(err);
      emit({
        type: "runtime_warning",
        warning_kind: "context_compaction_record_failed",
        message: lastError,
      });
    }
  }

  async function transformContext(messages = [], signal) {
    const original = estimateAgentMessages(messages);
    maxContextTokensEstimate = Math.max(maxContextTokensEstimate, original.tokens);
    if (!policy.enabled || signal?.aborted) return messages;

    let workingMessages = messages;
    const pruned = pruneOldToolResults(workingMessages, policy);
    if (pruned.changed) {
      workingMessages = replaceMessagesInPlace(messages, pruned.messages);
      toolResultsPruned += pruned.prunedCount;
      toolPayloadCharsSinceCompaction = 0;
      const afterPrune = estimateAgentMessages(workingMessages);
      emit({
        type: "tool_context_pruned",
        run_id: runId || null,
        pruned_tool_results: pruned.prunedCount,
        tokens_before: original.tokens,
        tokens_after: afterPrune.tokens,
        tokens_saved: original.tokens - afterPrune.tokens,
        pruned_tool_tokens_before: pruned.tokensBefore,
        pruned_tool_tokens_after: pruned.tokensAfter,
        pruned_tool_tokens_saved: pruned.tokensBefore - pruned.tokensAfter,
      });
    }

    const before = estimateAgentMessages(workingMessages);
    const trigger = forcedCompactionReason || (before.tokens >= policy.triggerTokens ? "token_budget" : null);
    const lowSavingsBackoff = policy.compactionMinSavingsTokens > 0
      && before.tokens <= lastLowSavingsSkipTokens + Math.max(1000, Math.floor(policy.compactionMinSavingsTokens / 2));
    if (!trigger || lowSavingsBackoff) return workingMessages;

    const firstKeptIndex = chooseFirstKeptIndex(workingMessages, policy.keepRecentTokens);
    if (firstKeptIndex <= 0) return workingMessages;

    const id = `cmp_${randomUUID()}`;
    const seq = compactionCount + 1;
    emit({
      type: "context_compaction_started",
      id,
      run_id: runId || null,
      seq,
      trigger,
      tokens_before: before.tokens,
      trigger_tokens: policy.triggerTokens,
      keep_recent_tokens: policy.keepRecentTokens,
    });

    try {
      const compacted = workingMessages.slice(0, firstKeptIndex);
      const recent = workingMessages.slice(firstKeptIndex);
      const summaryMaxChars = Math.max(4000, policy.summaryMaxTokens * 4);
      const summary = summarizeCompactedMessages(compacted, { maxChars: summaryMaxChars });
      const provisional = [
        {
          role: "user",
          content: summary,
          timestamp: Date.now(),
        },
        ...recent,
      ];
      const after = estimateAgentMessages(provisional);
      const summaryMessage = buildCompactionMessage({
        id,
        seq,
        metrics: { before, after },
        firstKeptIndex,
        compactedCount: compacted.length,
        summary,
      });
      const nextMessages = [summaryMessage, ...recent];
      const finalAfter = estimateAgentMessages(nextMessages);
      const savingsTokens = before.tokens - finalAfter.tokens;
      const emergencyTriggerTokens = Math.floor(policy.contextWindow * 0.95);
      if (
        policy.compactionMinSavingsTokens > 0
        && savingsTokens < policy.compactionMinSavingsTokens
        && before.tokens < emergencyTriggerTokens
      ) {
        skippedLowSavings += 1;
        lastLowSavingsSkipTokens = before.tokens;
        forcedCompactionReason = null;
        emit({
          type: "runtime_warning",
          warning_kind: "context_compaction_skipped_low_savings",
          message: `Skipped context compaction because estimated savings were ${savingsTokens} tokens below the ${policy.compactionMinSavingsTokens} token minimum.`,
          diagnostics: {
            trigger,
            tokens_before: before.tokens,
            tokens_after: finalAfter.tokens,
            savings_tokens: savingsTokens,
            min_savings_tokens: policy.compactionMinSavingsTokens,
          },
        });
        return workingMessages;
      }
      compactionCount += 1;
      lastCompactionId = id;
      record({
        id,
        seq,
        trigger,
        tokensBefore: before.tokens,
        tokensAfter: finalAfter.tokens,
        charsBefore: before.chars,
        charsAfter: finalAfter.chars,
        firstKeptIndex,
        summary,
        metadata: {
          context_window: policy.contextWindow,
          trigger_tokens: policy.triggerTokens,
          keep_recent_tokens: policy.keepRecentTokens,
          min_savings_tokens: policy.compactionMinSavingsTokens,
          savings_tokens: savingsTokens,
          tool_payload_chars_since_compaction: toolPayloadCharsSinceCompaction,
          compacted_messages: compacted.length,
          kept_messages: recent.length,
        },
      });
      toolPayloadCharsSinceCompaction = 0;
      forcedCompactionReason = null;
      emit({
        type: "context_compaction_completed",
        id,
        run_id: runId || null,
        seq,
        tokens_before: before.tokens,
        tokens_after: finalAfter.tokens,
        tokens_saved: savingsTokens,
        chars_before: before.chars,
        chars_after: finalAfter.chars,
        compacted_messages: compacted.length,
        kept_messages: recent.length,
        first_kept_index: firstKeptIndex,
      });
      return replaceMessagesInPlace(messages, nextMessages);
    } catch (err) {
      lastError = err?.message || String(err);
      record({
        id,
        seq,
        trigger,
        tokensBefore: before.tokens,
        charsBefore: before.chars,
        firstKeptIndex,
        summary: "",
        status: "failed",
        errorText: lastError,
      });
      emit({
        type: "runtime_warning",
        warning_kind: "context_compaction_failed",
        message: lastError,
      });
      return workingMessages;
    }
  }

  async function afterToolCall({ toolCall, result }, signal) {
    if (signal?.aborted) return undefined;
    const compacted = compactToolResultForContext(result, policy, { toolName: toolCall?.name || "tool" });
    const visibleResult = compacted.changed ? compacted.result : result;
    const payloadChars = estimateAgentMessageTokens({
      role: "toolResult",
      toolName: toolCall?.name || "tool",
      content: visibleResult?.content || [],
      details: visibleResult?.details || null,
    }).chars;
    toolPayloadCharsSinceCompaction += payloadChars;
    maxToolPayloadCharsSinceCompaction = Math.max(maxToolPayloadCharsSinceCompaction, toolPayloadCharsSinceCompaction);
    if (
      policy.enabled
      && policy.toolPayloadCompactionTriggerChars > 0
      && toolPayloadCharsSinceCompaction >= policy.toolPayloadCompactionTriggerChars
    ) {
      forcedCompactionReason = forcedCompactionReason || "tool_payload_budget";
    }
    if (!compacted.changed) return undefined;
    toolResultsCompacted += 1;
    emit({
      type: "tool_result_compacted",
      tool_use_id: toolCall?.id || null,
      name: toolCall?.name || null,
      text_limit_chars: compacted.result.details?.text_limit_chars || null,
      original_text_chars: compacted.result.details?.original_text_chars || null,
      kept_text_chars: compacted.result.details?.kept_text_chars || null,
      omitted_images: compacted.result.details?.omitted_images || null,
    });
    return {
      content: compacted.result.content,
      details: compacted.result.details,
    };
  }

  function diagnostics() {
    return {
      context_compaction_enabled: policy.enabled,
      context_compactions: compactionCount,
      context_compaction_last_id: lastCompactionId,
      context_compaction_last_error: lastError,
      context_compactions_skipped_low_savings: skippedLowSavings,
      context_window_tokens: policy.contextWindow,
      context_compaction_trigger_tokens: policy.triggerTokens,
      context_keep_recent_tokens: policy.keepRecentTokens,
      context_compaction_min_savings_tokens: policy.compactionMinSavingsTokens,
      context_tokens_estimate_max: maxContextTokensEstimate,
      tool_results_compacted: toolResultsCompacted,
      tool_results_pruned: toolResultsPruned,
      tool_payload_chars_since_compaction: toolPayloadCharsSinceCompaction,
      tool_payload_chars_since_compaction_max: maxToolPayloadCharsSinceCompaction,
      tool_payload_compaction_trigger_chars: policy.toolPayloadCompactionTriggerChars,
      tool_prune_trigger_tokens: policy.toolPruneTriggerTokens,
      context_compaction_pending_reason: forcedCompactionReason,
      tool_text_limit_chars: policy.toolTextLimitChars,
      bash_output_limit_chars: policy.bashOutputLimitChars,
      mcp_text_limit_chars: policy.mcpTextLimitChars,
      search_result_limit: policy.searchResultLimit,
      image_inline_max_bytes: policy.imageInlineMaxBytes,
      mcp_call_timeout_ms: policy.mcpCallTimeoutMs,
    };
  }

  return {
    policy,
    transformContext,
    afterToolCall,
    diagnostics,
  };
}
