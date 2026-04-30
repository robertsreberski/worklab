// Shared helpers for worker-mode runners.

export function maxTurnsForModel(model, fallback) {
  if (["claude", "claude-code", "codex"].includes(model?.sdk)) return undefined;
  return fallback;
}
