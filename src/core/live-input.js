export const LIVE_INPUT_MAX_BODY_LENGTH = 8_000;

const LIVE_INPUT_PROVIDERS = new Set(["claude", "openai", "vercel", "codex", "pi"]);

export function supportsLiveInputProvider(providerKind) {
  return LIVE_INPUT_PROVIDERS.has(String(providerKind || ""));
}

export function normalizeLiveInputBody(value, { limit = LIVE_INPUT_MAX_BODY_LENGTH } = {}) {
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) {
    return { ok: false, error: "message body is required", code: "invalid_body" };
  }
  if (body.length > limit) {
    return {
      ok: false,
      error: `message body must be ${limit} characters or fewer`,
      code: "body_too_large",
    };
  }
  return { ok: true, body };
}

// formatLiveInputGuidance moved to src/ai/live-input-prompt.js — providers
// are the only consumers and that location keeps the kernel/edge layer free
// of the prompt-string concern. Re-exported here so any straggling callers
// keep working.
export { formatLiveInputGuidance } from "@mono-agent/agent-runtime/ai/live-input-prompt.js";

export function createLiveInputQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  let failure = null;

  function wake() {
    while (waiters.length && (items.length || closed || failure)) {
      const waiter = waiters.shift();
      if (failure) waiter.reject(failure);
      else if (items.length) waiter.resolve({ value: items.shift(), done: false });
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  return {
    push(item) {
      if (closed || failure) return false;
      items.push(item);
      wake();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      wake();
    },
    fail(err) {
      if (failure) return;
      failure = err instanceof Error ? err : new Error(String(err || "live input failed"));
      wake();
    },
    async next() {
      if (failure) throw failure;
      if (items.length) return { value: items.shift(), done: false };
      if (closed) return { value: undefined, done: true };
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
