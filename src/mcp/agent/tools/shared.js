// Helpers shared across the agent-side MCP tool modules.

import { join } from "node:path";
import { openDb, runMigrations } from "../../../core/index.js";

// Opens a private DB handle for a single tool invocation, runs migrations,
// invokes `fn`, then closes the handle. The agent-side MCP server runs as a
// short-lived stdio bridge so it does not share a long-running DB handle
// with the rest of Worklab.
export async function withDb(dataDir, fn) {
  const db = openDb(join(dataDir, "worklab.db"));
  runMigrations(db);
  try { return await fn(db); } finally { db.close(); }
}

export function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
