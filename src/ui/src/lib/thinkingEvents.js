// Redacted thinking — Claude Code CLI >= 2.1.x finalizes `thinking` blocks that
// carry a signature but no text, and streams the reasoning volume separately as
// `system/thinking_tokens` estimates. The worker folds those estimates into
// `thinking_progress` events and tags the finalized blocks (see
// src/worker/event-coalescer.js); these helpers cover both the tagged shape and
// the untouched provider shape still present in already-persisted run logs.

export function isRedactedThinkingBlock(block) {
  if (block?.type !== "thinking") return false;
  if (String(block.text || block.thinking || "").trim()) return false;
  return Boolean(block.signature) || block.redacted === true;
}

export function hasRedactedThinkingBlock(event) {
  const content = event?.message?.content || event?.content;
  return Array.isArray(content) && content.some(isRedactedThinkingBlock);
}

export function formatThinkingTokens(value) {
  if (value == null) return null;
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function redactedThinkingLabel(event) {
  const tokens = formatThinkingTokens(event?.estimated_tokens);
  return tokens ? `Thought for ~${tokens} tokens` : "Thinking not returned by the provider";
}

export function thinkingProgressLabel(event) {
  const tokens = formatThinkingTokens(event?.estimated_tokens);
  return tokens ? `Thinking… ~${tokens} tokens` : "Thinking…";
}

export const REDACTED_THINKING_HINT =
  "The provider returned an encrypted thinking block with no readable text, so only its token estimate is available.";
