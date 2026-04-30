// settings table queries (key-value store).

export function getSettingValue(db, key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function listSettings(db) {
  return db.prepare("SELECT key, value FROM settings").all();
}

export function upsertSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
