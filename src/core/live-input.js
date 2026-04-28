export const LIVE_INPUT_MAX_BODY_LENGTH = 8_000;

const LIVE_INPUT_PROVIDERS = new Set(["claude", "codex"]);

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

export function formatLiveInputGuidance(text) {
  return [
    "Live guidance from the user:",
    String(text || ""),
    "",
    "Apply this guidance before continuing. It may correct, narrow, or override your current approach.",
    "Keep satisfying the original Worklab task and existing comments except where this live guidance conflicts with them.",
    "When there is a conflict, the newest human live guidance wins. Do not discard the broader task unless the user explicitly asks to replace it.",
  ].join("\n");
}

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
