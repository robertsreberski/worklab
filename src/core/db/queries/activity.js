// Activity-feed queries. The route shapes filter clauses and bound params
// from the request; helpers here own the column projection, joins, and
// ordering so SQL never lives outside core/db/queries/.

const ACTIVITY_COLS = `
  r.*,
  t.title AS task_title,
  t.task_key AS task_key,
  ar.automation_id,
  ar.trigger_type AS automation_trigger_type,
  ar.fired_at AS automation_fired_at,
  a.title AS automation_title,
  l.model,
  l.effort,
  l.input_tokens,
  l.output_tokens,
  l.cache_read_tokens,
  l.cache_creation_tokens,
  COALESCE(r.cost_usd, l.cost_usd) AS cost_usd,
  l.duration_ms,
  l.num_turns
`;

const ACTIVITY_JOINS = `
  FROM task_runs r
  LEFT JOIN tasks t ON t.id = r.task_id
  LEFT JOIN automation_runs ar ON ar.run_id = r.id
  LEFT JOIN automations a ON a.id = ar.automation_id
  LEFT JOIN agent_logs l ON l.task_run_id = r.id
`;

export function listActivity(db, { filters, params, limit }) {
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `SELECT ${ACTIVITY_COLS} ${ACTIVITY_JOINS} ${where} ORDER BY r.started_at DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit);
}

export function summarizeActivity(db, { filters, params }) {
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `
    SELECT
      COUNT(*) AS run_count,
      COUNT(COALESCE(r.cost_usd, l.cost_usd)) AS costed_run_count,
      COALESCE(SUM(COALESCE(r.cost_usd, l.cost_usd)), 0) AS total_cost_usd,
      SUM(CASE WHEN r.status = 'running' OR r.process_status = 'running' THEN 1 ELSE 0 END) AS running_count,
      SUM(CASE WHEN r.status IN ('error', 'failed') OR r.process_status IN ('error', 'failed') THEN 1 ELSE 0 END) AS error_count
    FROM task_runs r
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    ${where}
  `;
  return db.prepare(sql).get(...params);
}

export function summarizeActivityCostByDay(db, { filters, params }) {
  const costExpression = "COALESCE(r.cost_usd, l.cost_usd)";
  const conditions = [...filters, `${costExpression} IS NOT NULL`];
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT
      strftime('%Y-%m-%d', r.started_at / 1000, 'unixepoch') AS date,
      COALESCE(SUM(${costExpression}), 0) AS total_cost_usd,
      COUNT(${costExpression}) AS costed_run_count
    FROM task_runs r
    LEFT JOIN agent_logs l ON l.task_run_id = r.id
    ${where}
    GROUP BY date
    ORDER BY date ASC
  `;
  return db.prepare(sql).all(...params);
}
