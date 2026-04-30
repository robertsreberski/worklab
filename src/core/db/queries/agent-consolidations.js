// agent_consolidations queries — per-agent memory consolidation watermarks.

export function getAgentConsolidation(db, agentName) {
  return db
    .prepare("SELECT * FROM agent_consolidations WHERE agent_name = ?")
    .get(agentName);
}

export function getAgentConsolidationHash(db, agentName) {
  return db
    .prepare("SELECT last_journal_hash FROM agent_consolidations WHERE agent_name = ?")
    .get(agentName);
}

export function upsertAgentConsolidation(db, { agentName, journalHash, consolidatedAt, runId }) {
  db.prepare(
    `INSERT INTO agent_consolidations
       (agent_name, last_journal_hash, last_consolidated_at, last_run_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_name) DO UPDATE SET
       last_journal_hash = excluded.last_journal_hash,
       last_consolidated_at = excluded.last_consolidated_at,
       last_run_id = excluded.last_run_id`,
  ).run(agentName, journalHash, consolidatedAt, runId);
}
