// Persistence side of the agent runtime's compaction events. The runtime
// reports a structured record per compaction; worklab writes it into
// `run_compactions`. Splitting this out of the runtime kernel lets other
// hosts decide whether (and where) to persist the data.

const INSERT_SQL = `
  INSERT INTO run_compactions
    (id, task_run_id, seq, trigger, provider_kind, model, tokens_before, tokens_after,
     chars_before, chars_after, first_kept_index, summary, metadata_json, status, error_text, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function recordRunCompaction(db, record) {
  if (!db || !record?.id || !record?.task_run_id) return;
  db.prepare(INSERT_SQL).run(
    record.id,
    record.task_run_id,
    record.seq,
    record.trigger,
    record.provider_kind,
    record.model,
    record.tokens_before,
    record.tokens_after,
    record.chars_before,
    record.chars_after,
    record.first_kept_index,
    record.summary,
    record.metadata_json,
    record.status,
    record.error_text,
    record.created_at,
  );
}

export function compactionRecorderFor(db) {
  if (!db) return null;
  return (record) => recordRunCompaction(db, record);
}
