import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";

export function makeTestDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}
