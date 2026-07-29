const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_CHARS = 4000;
export const THINKING_PROGRESS_INTERVAL_MS = 750;

// Provider housekeeping chatter. Claude Code CLI >= 2.1.x emits a `system/status`
// ping per request and a `system/thinking_tokens` estimate every few hundred
// tokens; persisting them evicts real content from the run log window and
// renders as raw rows in the timeline. `compact_boundary`, `task_started` and
// `task_notification` stay — they are diagnostically useful.
const DROPPED_PROVIDER_EVENT_TYPES = new Set([
  "hook_started",
  "hook_response",
  "init",
  "rate_limit_event",
]);
const DROPPED_SYSTEM_SUBTYPES = new Set([
  "hook_started",
  "hook_response",
  "init",
  "status",
]);

function messageContent(event) {
  return event?.message?.content || event?.content;
}

// CLI adapters wrap provider payloads as { type: "cli_event", raw }; SDK
// adapters pass the payload through directly. Both shapes carry the same
// `system` subtypes, so unwrap once and apply the same predicates.
function providerPayload(event) {
  if (event?.type === "cli_event" && event.raw) return event.raw;
  return event;
}

function isDroppedProviderSystemEvent(event) {
  const payload = providerPayload(event);
  if (!payload) return false;
  if (DROPPED_PROVIDER_EVENT_TYPES.has(payload.type)) return true;
  return payload.type === "system" && DROPPED_SYSTEM_SUBTYPES.has(payload.subtype);
}

function thinkingTokensFromEvent(event) {
  const payload = providerPayload(event);
  if (payload?.type !== "system" || payload.subtype !== "thinking_tokens") return null;
  const total = Number(payload.estimated_tokens);
  const delta = Number(payload.estimated_tokens_delta);
  return {
    total: Number.isFinite(total) ? total : null,
    delta: Number.isFinite(delta) ? delta : null,
  };
}

// Redacted thinking: the provider finalizes a `thinking` block that carries a
// signature but no text, so there is nothing to render. Tag it so the UI can
// show the token estimate instead of an empty row.
function isRedactedThinkingBlock(block) {
  if (block?.type !== "thinking") return false;
  if (String(block.text || block.thinking || "").trim()) return false;
  return Boolean(block.signature) || block.redacted === true;
}

function annotateRedactedThinking(event, estimatedTokens) {
  const content = messageContent(event);
  if (!Array.isArray(content) || !content.some(isRedactedThinkingBlock)) return null;
  let consumed = false;
  const next = content.map((block) => {
    if (!isRedactedThinkingBlock(block)) return block;
    const tokens = !consumed && estimatedTokens > 0 ? estimatedTokens : null;
    consumed = true;
    return { type: "thinking", text: "", redacted: true, estimated_tokens: tokens };
  });
  return eventWithContent(event, next);
}

function coalescibleBlockFromEvent(event) {
  if (!event || (event.type !== "assistant" && event.type !== "message")) return null;
  const content = messageContent(event);
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0];
  if (!block || (block.type !== "text" && block.type !== "thinking")) return null;
  const text = block.text || block.thinking || "";
  if (!text) return null;
  return { kind: block.type, text };
}

function mergeStreamingText(current, next) {
  const left = current || "";
  const right = next || "";
  if (!right) return left;
  if (!left) return right;
  if (left === right) return left;

  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (leftTrimmed && rightTrimmed) {
    if (leftTrimmed === rightTrimmed) return left;
    if (rightTrimmed.length >= leftTrimmed.length && rightTrimmed.startsWith(leftTrimmed)) return right;
  }

  return `${left}${right}`;
}

function eventWithContent(event, content) {
  if (event.message?.content) {
    return {
      ...event,
      message: {
        ...event.message,
        content,
      },
    };
  }
  return { ...event, content };
}

function eventWithText(event, blockKind, text) {
  const block = blockKind === "thinking"
    ? { type: "thinking", text }
    : { type: "text", text };
  return eventWithContent(event, [block]);
}

export function createSdkEventCoalescer(emit, {
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxChars = DEFAULT_MAX_CHARS,
  thinkingProgressIntervalMs = THINKING_PROGRESS_INTERVAL_MS,
} = {}) {
  let pending = null;
  let timer = null;
  let thinkingTokens = 0;
  let thinkingTokensDelta = 0;
  let lastThinkingProgressAt = null;

  function clearFlushTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function scheduleFlush() {
    if (timer || flushIntervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  function flush() {
    clearFlushTimer();
    if (!pending) return;
    const event = eventWithText(pending.event, pending.kind, pending.text);
    pending = null;
    emit(event);
  }

  function resetThinkingTokens() {
    thinkingTokens = 0;
    thinkingTokensDelta = 0;
    lastThinkingProgressAt = null;
  }

  // `estimated_tokens` is the running total for the current thinking block, so
  // fold every estimate into one throttled progress event instead of emitting
  // the hundreds the provider sends.
  function trackThinkingTokens({ total, delta }) {
    if (total != null) thinkingTokens = total;
    else if (delta != null) thinkingTokens += delta;
    if (delta != null) thinkingTokensDelta += delta;

    const now = Date.now();
    if (lastThinkingProgressAt != null && now - lastThinkingProgressAt < thinkingProgressIntervalMs) return;
    lastThinkingProgressAt = now;
    const emittedDelta = thinkingTokensDelta;
    thinkingTokensDelta = 0;
    flush();
    emit({ type: "thinking_progress", estimated_tokens: thinkingTokens, estimated_tokens_delta: emittedDelta });
  }

  function emitEvent(event) {
    if (isDroppedProviderSystemEvent(event)) return;

    const tokens = thinkingTokensFromEvent(event);
    if (tokens) {
      trackThinkingTokens(tokens);
      return;
    }

    const redacted = annotateRedactedThinking(event, thinkingTokens);
    if (redacted) {
      resetThinkingTokens();
      flush();
      emit(redacted);
      return;
    }

    const block = coalescibleBlockFromEvent(event);
    if (!block) {
      flush();
      emit(event);
      return;
    }

    if (pending && pending.kind !== block.kind) flush();
    if (!pending) {
      pending = { event, kind: block.kind, text: block.text };
    } else {
      pending.text = mergeStreamingText(pending.text, block.text);
      pending.event = event;
    }

    if (pending.text.length >= maxChars) {
      flush();
    } else {
      scheduleFlush();
    }
  }

  return {
    emit: emitEvent,
    flush,
  };
}

export const __eventCoalescerTest = {
  mergeStreamingText,
  isDroppedProviderSystemEvent,
  thinkingTokensFromEvent,
  annotateRedactedThinking,
};
