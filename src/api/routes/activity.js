const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimeFilter(value, { endOfDay = false } = {}) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const start = Date.parse(`${raw}T00:00:00.000Z`);
    return Number.isFinite(start) ? start + (endOfDay ? DAY_MS - 1 : 0) : null;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptySummary() {
  return {
    run_count: 0,
    costed_run_count: 0,
    total_cost_usd: 0,
    average_cost_usd: null,
    running_count: 0,
    error_count: 0,
  };
}

export function registerActivityRoutes(app, { db }) {
  app.get("/api/activity", (req, res) => {
    const requestedLimit = parseInt(req.query.limit || "50", 10);
    const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 50, 200));
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;
    const baseFilters = [];
    const baseParams = [];
    const from = parseTimeFilter(req.query.from);
    const to = parseTimeFilter(req.query.to, { endOfDay: true });
    if (req.query.agent) {
      baseFilters.push("r.agent_name = ?");
      baseParams.push(req.query.agent);
    }
    if (req.query.status) {
      baseFilters.push("(r.status = ? OR r.process_status = ?)");
      baseParams.push(req.query.status, req.query.status);
    }
    if (from != null) {
      baseFilters.push("r.started_at >= ?");
      baseParams.push(from);
    }
    if (to != null) {
      baseFilters.push("r.started_at <= ?");
      baseParams.push(to);
    }
    const listFilters = [...baseFilters];
    const listParams = [...baseParams];
    if (cursor) {
      listFilters.unshift("r.started_at < ?");
      listParams.unshift(cursor);
    }
    const cols = `
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
    const sql = `SELECT ${cols} FROM task_runs r
      LEFT JOIN tasks t ON t.id = r.task_id
      LEFT JOIN automation_runs ar ON ar.run_id = r.id
      LEFT JOIN automations a ON a.id = ar.automation_id
      LEFT JOIN agent_logs l ON l.task_run_id = r.id
      ${listFilters.length ? `WHERE ${listFilters.join(" AND ")}` : ""}
      ORDER BY r.started_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...listParams, limit + 1);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? items[items.length - 1].started_at : null;

    const summarySql = `
      SELECT
        COUNT(*) AS run_count,
        COUNT(COALESCE(r.cost_usd, l.cost_usd)) AS costed_run_count,
        COALESCE(SUM(COALESCE(r.cost_usd, l.cost_usd)), 0) AS total_cost_usd,
        SUM(CASE WHEN r.status = 'running' OR r.process_status = 'running' THEN 1 ELSE 0 END) AS running_count,
        SUM(CASE WHEN r.status IN ('error', 'failed') OR r.process_status IN ('error', 'failed') THEN 1 ELSE 0 END) AS error_count
      FROM task_runs r
      LEFT JOIN agent_logs l ON l.task_run_id = r.id
      ${baseFilters.length ? `WHERE ${baseFilters.join(" AND ")}` : ""}
    `;
    const row = db.prepare(summarySql).get(...baseParams);
    const costedRunCount = Number(row?.costed_run_count || 0);
    const totalCostUsd = Number(row?.total_cost_usd || 0);
    const summary = row ? {
      run_count: Number(row.run_count || 0),
      costed_run_count: costedRunCount,
      total_cost_usd: totalCostUsd,
      average_cost_usd: costedRunCount > 0 ? totalCostUsd / costedRunCount : null,
      running_count: Number(row.running_count || 0),
      error_count: Number(row.error_count || 0),
    } : emptySummary();

    res.json({ items, nextCursor, summary });
  });
}
