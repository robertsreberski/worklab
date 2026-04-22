import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export function agentJournalPath(dataDir, agent) {
  return join(dataDir, "agents", agent, "JOURNAL.md");
}

export function agentMemoryPath(dataDir, agent) {
  return join(dataDir, "agents", agent, "MEMORY.md");
}

function ensureDir(path) {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function isoTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runHeaderRegex(runId) {
  return new RegExp(`^## .* — run ${runId} — `, "m");
}

export function appendJournalEntry({ dataDir, agent, runId, taskId, taskTitle, bullet, now = new Date() }) {
  const path = agentJournalPath(dataDir, agent);
  ensureDir(path);
  let existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const headerPresent = runHeaderRegex(runId).test(existing);
  const ts = isoTimestamp(now);
  if (!headerPresent) {
    const header = `\n## ${ts} — run ${runId} — task ${taskId} (${taskTitle})\n`;
    existing += header;
    writeFileSync(path, existing);
  }
  appendFileSync(path, `- ${bullet}\n`);
}

export function appendJournalSummary({ dataDir, agent, runId, text, now = new Date() }) {
  const path = agentJournalPath(dataDir, agent);
  ensureDir(path);
  const ts = isoTimestamp(now);
  appendFileSync(path, `\n## ${ts} — run ${runId} (summary)\n${text}\n`);
}

export function readJournalTail({ dataDir, agent, maxLines = 80 }) {
  const path = agentJournalPath(dataDir, agent);
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  return lines.slice(-maxLines).join("\n");
}

export function readFullJournal({ dataDir, agent }) {
  const path = agentJournalPath(dataDir, agent);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function writeMemory({ dataDir, agent, content }) {
  const path = agentMemoryPath(dataDir, agent);
  ensureDir(path);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, String(content || "").replace(/\n*$/, "\n"));
  renameSync(tmp, path);
  return path;
}
