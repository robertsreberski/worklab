// Re-export shim. The actual schema lives in src/core/db/schema/current.js.
// This file remains so existing `from "../core/schema.js"` imports keep
// working through the modularization. Phase 2 will retire most callers; the
// stragglers move in Phase 7.
export { SCHEMA_SQL, SCHEMA_VERSION } from "./db/schema/current.js";
