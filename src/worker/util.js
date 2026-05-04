// Shared helpers for worker-mode runners.

export function maxTurnsForModel(model, fallback) {
  if (model?.sdk === "claude") return undefined;
  if (model?.sdk === "codex") return undefined;
  if (model?.sdk === "pi" && model?.provider === "openai-codex") return undefined;
  return fallback;
}
