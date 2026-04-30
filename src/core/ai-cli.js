// Re-export shim. Real implementation lives in src/ai/providers/claude-cli.js
// as part of the Phase 3 provider-layer extraction. The file remains named
// "claude-cli" because it currently exposes the Claude Code CLI adapter.
// A future codex-cli.js sibling will share helpers; until then both providers
// live in this one file.
export * from "../ai/providers/claude-cli.js";
