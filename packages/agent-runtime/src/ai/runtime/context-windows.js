export const DEFAULT_CONTEXT_WINDOW = "default";
export const ONE_MILLION_CONTEXT_WINDOW = "1m";

export const CLAUDE_ONE_MILLION_CONTEXT_MODELS = new Set([
  "claude-opus-4-7",
  "claude-opus-4-6",
]);

export function normalizeContextWindow(value) {
  return value === ONE_MILLION_CONTEXT_WINDOW
    ? ONE_MILLION_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW;
}

export function stripContextWindowSuffix(model) {
  return String(model || "").replace(/\[1m\]$/i, "");
}

export function claudeModelSupportsOneMillionContext(model) {
  return CLAUDE_ONE_MILLION_CONTEXT_MODELS.has(stripContextWindowSuffix(model));
}

export function claudeModelSupportsContextWindow(model, contextWindow) {
  const normalized = normalizeContextWindow(contextWindow);
  if (normalized === DEFAULT_CONTEXT_WINDOW) return true;
  return claudeModelSupportsOneMillionContext(model);
}

export function modelWithContextWindow(model, contextWindow) {
  const base = stripContextWindowSuffix(model);
  if (
    normalizeContextWindow(contextWindow) === ONE_MILLION_CONTEXT_WINDOW
    && claudeModelSupportsOneMillionContext(base)
  ) {
    return `${base}[1m]`;
  }
  return base;
}
