import { listActivity, summarizeActivity, summarizeActivityCostByDay } from "../../core/db/queries/activity.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COST_CHART_DAYS = 7;
const MAX_FILLED_COST_CHART_DAYS = 45;

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
    cost_by_day: [],
  };
}

function startOfUtcDay(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function costChartRange(from, to) {
  if (from == null && to == null) {
    const end = startOfUtcDay(Date.now());
    return { start: end - ((DEFAULT_COST_CHART_DAYS - 1) * DAY_MS), end };
  }
  if (from == null || to == null) return null;
  const start = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  if (end < start) return null;
  const dayCount = Math.floor((end - start) / DAY_MS) + 1;
  if (dayCount > MAX_FILLED_COST_CHART_DAYS) return null;
  return { start, end };
}

function normalizeCostByDay(rows, range) {
  const normalized = rows.map((row) => ({
    date: row.date,
    total_cost_usd: Number(row.total_cost_usd || 0),
    costed_run_count: Number(row.costed_run_count || 0),
  }));
  if (!range || normalized.length === 0) return normalized;
  const byDate = new Map(normalized.map((row) => [row.date, row]));
  const days = [];
  for (let day = range.start; day <= range.end; day += DAY_MS) {
    const date = isoDay(day);
    days.push(byDate.get(date) || { date, total_cost_usd: 0, costed_run_count: 0 });
  }
  return days;
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
    const rows = listActivity(db, { filters: listFilters, params: listParams, limit: limit + 1 });
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? items[items.length - 1].started_at : null;

    const row = summarizeActivity(db, { filters: baseFilters, params: baseParams });
    const costRange = costChartRange(from, to);
    const costFilters = [...baseFilters];
    const costParams = [...baseParams];
    if (from == null && to == null && costRange) {
      costFilters.push("r.started_at >= ?");
      costParams.push(costRange.start);
      costFilters.push("r.started_at <= ?");
      costParams.push(costRange.end + DAY_MS - 1);
    }
    const costByDay = normalizeCostByDay(
      summarizeActivityCostByDay(db, { filters: costFilters, params: costParams }),
      costRange,
    );
    const costedRunCount = Number(row?.costed_run_count || 0);
    const totalCostUsd = Number(row?.total_cost_usd || 0);
    const summary = row ? {
      run_count: Number(row.run_count || 0),
      costed_run_count: costedRunCount,
      total_cost_usd: totalCostUsd,
      average_cost_usd: costedRunCount > 0 ? totalCostUsd / costedRunCount : null,
      running_count: Number(row.running_count || 0),
      error_count: Number(row.error_count || 0),
      cost_by_day: costByDay,
    } : emptySummary();

    res.json({ items, nextCursor, summary });
  });
}
