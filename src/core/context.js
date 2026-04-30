// Re-export shim. Real implementation lives in src/agent/prompt/system-prompt.js
// as part of the Phase 5 decomposition. The file is wholesale prompt
// construction so it moved as a single unit; future passes can break out
// individual builders (skills index, tool surface) into siblings.
export * from "../agent/prompt/system-prompt.js";
