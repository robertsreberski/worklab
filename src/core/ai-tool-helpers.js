// Re-export shim. Real implementation lives in src/agent/tools/index.js as
// part of the Phase 4 agent-kernel extraction. The 8 built-in tool impls
// (Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch) and their
// shared helpers all live in that file; a future per-tool split is left
// for when the helpers can be cleanly factored out.
export * from "../agent/tools/index.js";
