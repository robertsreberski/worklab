// Re-export shim. Real implementation lives in src/ai/failure.js as part of
// the Phase 3 provider-layer extraction. Existing
// `from "../core/failure-kind.js"` imports keep working until callers are
// migrated to `from "../ai/failure.js"`.
export * from "../ai/failure.js";
