import { openDb, runMigrations } from "../../core/db.js";

export function makeTestDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}
