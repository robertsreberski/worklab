import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { agentJournalPath, agentMemoryPath, readJournalTail } from "./journal.js";
import { getAgentConsolidation } from "./db/queries/agent-consolidations.js";

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readFileIfExists(path) {
  if (!existsSync(path)) return { exists: false, content: "", sizeBytes: 0, updatedAt: null };
  const content = readFileSync(path, "utf8");
  const stat = statSync(path);
  return {
    exists: true,
    content,
    sizeBytes: stat.size,
    updatedAt: Math.trunc(stat.mtimeMs),
  };
}

export function agentJournalHash({ dataDir, agent }) {
  const path = agentJournalPath(dataDir, agent);
  if (!existsSync(path)) return null;
  return sha256Buffer(readFileSync(path));
}

export function readAgentMemoryContent({ dataDir, agent }) {
  return readFileIfExists(agentMemoryPath(dataDir, agent)).content;
}

export function readAgentMemoryContext({ dataDir, agent, maxJournalLines = 80 }) {
  return {
    memory: readAgentMemoryContent({ dataDir, agent }),
    journalTail: readJournalTail({ dataDir, agent, maxLines: maxJournalLines }),
  };
}

export function readAgentMemoryState({ db, dataDir, agent, consolidating = false } = {}) {
  const memory = readFileIfExists(agentMemoryPath(dataDir, agent));
  const journalPath = agentJournalPath(dataDir, agent);
  const journalExists = existsSync(journalPath);
  const journalHash = journalExists ? sha256Buffer(readFileSync(journalPath)) : null;
  const row = db ? getAgentConsolidation(db, agent) || null : null;
  const lastJournalHash = row?.last_journal_hash || null;
  const journalChanged = Boolean(journalHash && lastJournalHash && journalHash !== lastJournalHash);

  let freshness = "current";
  if (consolidating) freshness = "consolidating";
  else if (!journalExists) freshness = "no_journal";
  else if (!memory.exists || !lastJournalHash) freshness = "not_consolidated";
  else if (journalChanged) freshness = "stale";

  return {
    agent,
    content: memory.content,
    exists: memory.exists,
    size_bytes: memory.sizeBytes,
    updated_at: memory.updatedAt,
    last_consolidated_at: row?.last_consolidated_at || null,
    last_run_id: row?.last_run_id || null,
    journal_exists: journalExists,
    journal_changed: journalChanged,
    freshness,
  };
}
