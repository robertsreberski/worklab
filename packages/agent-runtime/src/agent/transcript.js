// Snapshot/render helpers for preserving partial agent progress across
// continuations. The worker writes a bounded "transcript tail" when a run
// terminates with usable progress but no structured result, and the coordinator
// passes it through `diagnosticsSeed.resume_snapshot` so the next worker can
// prepend it to the system prompt.

import { readRuntimeBrand } from "./tools/shared/runtime-context.js";

// intelligence-ramp Phase 5.3: keep more turns but reserve verbatim slots for
// the most recent few. Older turns ride along as one-paragraph summaries so
// the SDK-mode agent can reason about the whole arc without paying the full
// payload cost (CLI agents get true session resume; this is the SDK fallback).
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_VERBATIM_TURNS = 3;
const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_TOOL_RESULT_CHARS = 2_400;
const DEFAULT_ASSISTANT_TEXT_CHARS = 4_000;
const DEFAULT_TURN_SUMMARY_CHARS = 320;

function truncate(text, limit, suffix = "…") {
  const value = String(text ?? "");
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function flattenContent(content) {
  if (!Array.isArray(content)) {
    if (typeof content === "string") return content;
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "thinking" && typeof block.text === "string") return block.text;
      if (block.type === "tool_result") {
        if (typeof block.content === "string") return block.content;
        if (Array.isArray(block.content)) return flattenContent(block.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function describeToolUse(block) {
  if (!block || block.type !== "tool_use") return null;
  return {
    id: block.id || null,
    name: block.name || "",
    input_summary: truncate(JSON.stringify(block.input || {}), DEFAULT_TOOL_RESULT_CHARS),
  };
}

function describeToolResult(block, { toolResultChars }) {
  if (!block || block.type !== "tool_result") return null;
  return {
    tool_use_id: block.tool_use_id || null,
    is_error: !!block.is_error,
    content: truncate(flattenContent(block.content), toolResultChars || DEFAULT_TOOL_RESULT_CHARS),
  };
}

// Compress one turn into a single short paragraph: tool names + an excerpt
// of the assistant text. Used for older turns that we keep around for
// continuity but can't afford verbatim.
function summarizeTurn(turn, { maxChars = DEFAULT_TURN_SUMMARY_CHARS } = {}) {
  const parts = [];
  if (turn.assistant_text) {
    const firstLine = turn.assistant_text.split(/\r?\n/).find((line) => line.trim());
    if (firstLine) parts.push(truncate(firstLine.trim(), Math.floor(maxChars * 0.6)));
  }
  const toolUseNames = (turn.tool_uses || []).map((u) => u.name).filter(Boolean);
  if (toolUseNames.length) {
    parts.push(`tools: ${toolUseNames.slice(0, 5).join(", ")}${toolUseNames.length > 5 ? "…" : ""}`);
  }
  const errorCount = (turn.tool_results || []).filter((r) => r.is_error).length;
  if (errorCount > 0) parts.push(`${errorCount} tool error${errorCount === 1 ? "" : "s"}`);
  return truncate(parts.join("; ") || "no narrative", maxChars);
}

// Walk the captured event log backwards and collect the most recent N turns
// worth of (assistant text, tool calls, tool results). Returns null when there
// is nothing usable to resume from. Older turns beyond `verbatimTurns` are
// summarized into a one-paragraph snippet; only the trailing `verbatimTurns`
// keep their full assistant text + tool detail.
export function buildTranscriptTailSnapshot(events, {
  maxTurns = DEFAULT_MAX_TURNS,
  verbatimTurns = DEFAULT_VERBATIM_TURNS,
  maxChars = DEFAULT_MAX_CHARS,
  toolResultChars = DEFAULT_TOOL_RESULT_CHARS,
  assistantTextChars = DEFAULT_ASSISTANT_TEXT_CHARS,
  turnSummaryChars = DEFAULT_TURN_SUMMARY_CHARS,
} = {}) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const turns = [];
  let currentAssistantText = "";
  let currentThinking = "";
  let currentToolUses = [];
  let currentToolResults = [];

  function flushTurn() {
    if (!currentAssistantText && !currentThinking && currentToolUses.length === 0 && currentToolResults.length === 0) {
      return;
    }
    turns.push({
      assistant_text: truncate(currentAssistantText.trim(), assistantTextChars) || null,
      thinking: truncate(currentThinking.trim(), assistantTextChars) || null,
      tool_uses: currentToolUses,
      tool_results: currentToolResults,
    });
    currentAssistantText = "";
    currentThinking = "";
    currentToolUses = [];
    currentToolResults = [];
  }

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          currentAssistantText += block.text;
        } else if (block?.type === "thinking" && typeof block.text === "string") {
          currentThinking += block.text;
        } else if (block?.type === "tool_use") {
          const summary = describeToolUse(block);
          if (summary) currentToolUses.push(summary);
        }
      }
    } else if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_result") {
          const summary = describeToolResult(block, { toolResultChars });
          if (summary) currentToolResults.push(summary);
        }
      }
      if (currentToolResults.length > 0) flushTurn();
    } else if (event.type === "final" || event.type === "error" || event.type === "cancelled") {
      flushTurn();
    }
  }
  flushTurn();

  if (turns.length === 0) return null;
  const totalCap = Math.max(1, Number(maxTurns) || DEFAULT_MAX_TURNS);
  const verbatimCap = Math.max(1, Number(verbatimTurns) || DEFAULT_VERBATIM_TURNS);
  const tailWindow = turns.slice(-totalCap);
  const verbatimSlice = tailWindow.slice(-Math.min(verbatimCap, tailWindow.length));
  const summarizedSlice = tailWindow.slice(0, Math.max(0, tailWindow.length - verbatimSlice.length));
  // Each summarized entry retains its turn index (so renderResumeSnapshot
  // labels them correctly) and a one-paragraph description.
  const earlierTurnSummaries = summarizedSlice.map((turn, idx) => ({
    turn_index: turns.length - tailWindow.length + idx + 1,
    summary: summarizeTurn(turn, { maxChars: turnSummaryChars }),
  }));
  const brand = readRuntimeBrand();
  const snapshot = {
    schema: `${brand.schemaPrefix}.transcript-tail.v1`,
    captured_at: Date.now(),
    turn_count: turns.length,
    earlier_turn_summaries: earlierTurnSummaries,
    turns: verbatimSlice,
  };
  const json = JSON.stringify(snapshot);
  if (json.length <= maxChars) return snapshot;
  // Fall back to fewer verbatim turns if the JSON exceeds maxChars; the
  // summaries are tiny and stay.
  let trimmedTurns = verbatimSlice.slice();
  while (trimmedTurns.length > 1 && JSON.stringify({ ...snapshot, turns: trimmedTurns }).length > maxChars) {
    trimmedTurns = trimmedTurns.slice(1);
  }
  return { ...snapshot, turns: trimmedTurns, truncated: true };
}

export function renderResumeSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.turns) || snapshot.turns.length === 0) return "";
  const lines = [];
  lines.push("<resume_context>");
  lines.push(`A previous attempt at this task ran ${snapshot.turn_count || snapshot.turns.length} turn(s) before the provider connection dropped.`);
  lines.push("Below is the trail of recent work so you can continue from where it left off rather than starting over. Tool results are abbreviated; re-read files as needed if you require the full content.");
  lines.push("");
  // Phase 5.3: earlier turns are present as one-paragraph summaries; only the
  // most recent few are verbatim. Render summaries first so the agent gets
  // the full arc, then the recent verbatim turns for fine-grained context.
  if (Array.isArray(snapshot.earlier_turn_summaries) && snapshot.earlier_turn_summaries.length > 0) {
    lines.push("### Earlier turns (summarized)");
    for (const entry of snapshot.earlier_turn_summaries) {
      lines.push(`- Turn ${entry.turn_index}: ${entry.summary}`);
    }
    lines.push("");
  }
  const verbatimStartIndex = (snapshot.turn_count || snapshot.turns.length) - snapshot.turns.length + 1;
  snapshot.turns.forEach((turn, index) => {
    const label = `Turn ${verbatimStartIndex + index}`;
    lines.push(`### ${label}`);
    if (turn.thinking) {
      lines.push(`Thinking: ${turn.thinking}`);
    }
    if (turn.assistant_text) {
      lines.push(`Assistant: ${turn.assistant_text}`);
    }
    if (Array.isArray(turn.tool_uses) && turn.tool_uses.length > 0) {
      for (const use of turn.tool_uses) {
        lines.push(`Tool call: ${use.name}(${use.input_summary || ""})`);
      }
    }
    if (Array.isArray(turn.tool_results) && turn.tool_results.length > 0) {
      for (const result of turn.tool_results) {
        const prefix = result.is_error ? "Tool result (error)" : "Tool result";
        lines.push(`${prefix}: ${result.content || ""}`);
      }
    }
    lines.push("");
  });
  lines.push("</resume_context>");
  return lines.join("\n");
}

export const RESUME_SNAPSHOT_DEFAULTS = {
  maxTurns: DEFAULT_MAX_TURNS,
  verbatimTurns: DEFAULT_VERBATIM_TURNS,
  maxChars: DEFAULT_MAX_CHARS,
  toolResultChars: DEFAULT_TOOL_RESULT_CHARS,
  assistantTextChars: DEFAULT_ASSISTANT_TEXT_CHARS,
  turnSummaryChars: DEFAULT_TURN_SUMMARY_CHARS,
};
