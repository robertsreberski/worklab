import { getTaskById } from "./db/queries/tasks.js";

const TASK_KEY_PREFIX = "T";
const TASK_KEY_SETTING = "task_key_next";
const TASK_KEY_RE = /^T-(\d+)$/i;

export function formatTaskKey(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid task key number: ${value}`);
  return `${TASK_KEY_PREFIX}-${n}`;
}

export function normalizeTaskKey(value) {
  if (typeof value !== "string") return null;
  const match = TASK_KEY_RE.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return formatTaskKey(n);
}

export function taskKeyNumber(value) {
  const normalized = normalizeTaskKey(value);
  if (!normalized) return null;
  return Number(normalized.slice(2));
}

function readTaskKeySetting(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(TASK_KEY_SETTING);
  if (!row) return null;
  const parsed = Number(row.value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function writeTaskKeySetting(db, next) {
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(TASK_KEY_SETTING, String(next));
}

export function maxTaskKeyNumber(db) {
  const rows = db.prepare("SELECT task_key FROM tasks WHERE task_key IS NOT NULL AND task_key <> ''").all();
  let max = 0;
  for (const row of rows) {
    const n = taskKeyNumber(row.task_key);
    if (n && n > max) max = n;
  }
  return max;
}

function taskKeyExists(db, key) {
  return !!db.prepare("SELECT 1 FROM tasks WHERE task_key = ? LIMIT 1").get(key);
}

export function nextTaskKey(db) {
  let next = Math.max(readTaskKeySetting(db) || 1, maxTaskKeyNumber(db) + 1);
  let key = formatTaskKey(next);
  while (taskKeyExists(db, key)) {
    next += 1;
    key = formatTaskKey(next);
  }
  writeTaskKeySetting(db, next + 1);
  return key;
}

export function backfillTaskKeys(db) {
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT id
      FROM tasks
      WHERE task_key IS NULL OR task_key = ''
      ORDER BY created_at ASC, id ASC
    `).all();
    const update = db.prepare("UPDATE tasks SET task_key = ? WHERE id = ?");
    for (const row of rows) {
      update.run(nextTaskKey(db), row.id);
    }
    const next = Math.max(readTaskKeySetting(db) || 1, maxTaskKeyNumber(db) + 1);
    writeTaskKeySetting(db, next);
  });
  tx();
}

export function resolveTaskRow(db, value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const key = normalizeTaskKey(raw);
  if (key) {
    const byKey = db.prepare("SELECT * FROM tasks WHERE task_key = ?").get(key);
    if (byKey) return byKey;
  }
  return getTaskById(db, raw) || null;
}

export function resolveTaskId(db, value) {
  return resolveTaskRow(db, value)?.id || null;
}
