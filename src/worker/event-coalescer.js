const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_CHARS = 4000;

function messageContent(event) {
  return event?.message?.content || event?.content;
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

function eventWithText(event, blockKind, text) {
  const block = blockKind === "thinking"
    ? { type: "thinking", text }
    : { type: "text", text };
  if (event.message?.content) {
    return {
      ...event,
      message: {
        ...event.message,
        content: [block],
      },
    };
  }
  return { ...event, content: [block] };
}

export function createSdkEventCoalescer(emit, {
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  let pending = null;
  let timer = null;

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

  function emitEvent(event) {
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
};
