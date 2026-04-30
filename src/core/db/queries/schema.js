// schema_meta + sqlite_master probes used by the API health endpoint.

export function getSchemaVersion(db) {
  if (!db) return null;
  try {
    return db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value || null;
  } catch {
    return null;
  }
}

export function tableExists(db, table) {
  if (!db) return false;
  try {
    return Boolean(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?",
        )
        .get(table),
    );
  } catch {
    return false;
  }
}
