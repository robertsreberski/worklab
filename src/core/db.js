// Re-export shim. Real implementation:
//   - openDb / getDb / closeDb  → src/core/db/open.js
//   - runMigrations             → src/core/db/migrations/runner.js
//   - SCHEMA_SQL / SCHEMA_VERSION → src/core/db/schema/current.js (via core/schema.js)
//
// This file remains so existing `from "../core/db.js"` imports keep working
// through the modularization. Phase 7 promotes the eslint boundary rules to
// error level; at that point we'll either retire this shim or document it as
// the canonical entry point.
export { openDb, getDb, closeDb } from "./db/open.js";
export { runMigrations } from "./db/migrations/runner.js";
