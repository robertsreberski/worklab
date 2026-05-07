import { statSync } from "node:fs";
import { MAX_READ_LINE_CHARS, READ_HISTORY_LIMIT } from "./constants.js";

export const readHistory = new Map();

export function boundedInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

export function safeStat(path) {
  try { return statSync(path); } catch { return null; }
}

export function rememberRead(target, start, count) {
  const key = `${target}:${start}:${count}`;
  const repeated = readHistory.has(key);
  readHistory.set(key, Date.now());
  if (readHistory.size > READ_HISTORY_LIMIT) {
    const oldest = [...readHistory.entries()].sort((a, b) => a[1] - b[1]).slice(0, readHistory.size - READ_HISTORY_LIMIT);
    for (const [entry] of oldest) readHistory.delete(entry);
  }
  return repeated;
}

export function trimLine(line) {
  const text = String(line ?? "");
  if (text.length <= MAX_READ_LINE_CHARS) return text;
  return `${text.slice(0, MAX_READ_LINE_CHARS)} [line truncated at ${MAX_READ_LINE_CHARS} of ${text.length} chars]`;
}
