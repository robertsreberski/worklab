import { newAutomationRunId, newAutomationTriggerId, newRunId } from "./ids.js";
import { insertAutomationRun, insertAutomationTrigger } from "./db/queries/automation-audit.js";
import { normalizeOptionalWebhookId } from "@worklab-ai/webhooks";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clampInt(value, fallback, min, max) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function utcCandidate(year, monthIndex, day, hour, minute) {
  return new Date(Date.UTC(year, monthIndex, day, hour, minute, 0, 0)).getTime();
}

export function parseRunAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalizeTrigger(raw = {}) {
  const type = ["once", "daily", "weekly", "monthly", "webhook"].includes(raw?.type) ? raw.type : "daily";
  if (type === "webhook") {
    return { type, webhook_id: normalizeOptionalWebhookId(raw?.webhook_id) };
  }
  if (type === "once") {
    return { type, run_at: parseRunAt(raw?.run_at) || Date.now() };
  }
  const hour = clampInt(raw?.hour, 9, 0, 23);
  const minute = clampInt(raw?.minute, 0, 0, 59);
  if (type === "weekly") {
    const weekdays = Array.isArray(raw?.weekdays) ? raw.weekdays : [1];
    const normalizedWeekdays = [...new Set(weekdays.map((day) => clampInt(day, 1, 0, 6)))].sort((a, b) => a - b);
    return {
      type,
      hour,
      minute,
      weekdays: normalizedWeekdays.length ? normalizedWeekdays : [1],
    };
  }
  if (type === "monthly") {
    return {
      type,
      hour,
      minute,
      day_of_month: clampInt(raw?.day_of_month, 1, 1, 31),
    };
  }
  return { type, hour, minute };
}

export function triggerSummary(raw) {
  const trigger = normalizeTrigger(raw);
  if (trigger.type === "webhook") return `Webhook · ${trigger.webhook_id}`;
  if (trigger.type === "once") return `Once · ${new Date(trigger.run_at).toLocaleString()}`;
  const time = `${pad2(trigger.hour)}:${pad2(trigger.minute)} UTC`;
  if (trigger.type === "daily") return `Daily · ${time}`;
  if (trigger.type === "weekly") {
    const labels = trigger.weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
    return `Weekly · ${labels} · ${time}`;
  }
  return `Monthly · day ${trigger.day_of_month} · ${time}`;
}

export function nextFireAt(rawTrigger, afterMs = Date.now()) {
  const trigger = normalizeTrigger(rawTrigger);
  if (trigger.type === "webhook") return null;
  if (trigger.type === "once") return trigger.run_at || null;

  const after = new Date(afterMs);
  const start = Date.UTC(
    after.getUTCFullYear(),
    after.getUTCMonth(),
    after.getUTCDate(),
    after.getUTCHours(),
    after.getUTCMinutes(),
    after.getUTCSeconds(),
    after.getUTCMilliseconds(),
  );

  if (trigger.type === "daily") {
    let candidate = utcCandidate(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), trigger.hour, trigger.minute);
    if (candidate <= start) candidate += 86_400_000;
    return candidate;
  }

  if (trigger.type === "weekly") {
    for (let offset = 0; offset <= 14; offset += 1) {
      const current = new Date(start + offset * 86_400_000);
      if (!trigger.weekdays.includes(current.getUTCDay())) continue;
      const candidate = utcCandidate(
        current.getUTCFullYear(),
        current.getUTCMonth(),
        current.getUTCDate(),
        trigger.hour,
        trigger.minute,
      );
      if (candidate > start) return candidate;
    }
  }

  let year = after.getUTCFullYear();
  let month = after.getUTCMonth();
  for (let offset = 0; offset < 24; offset += 1) {
    const monthIndex = month + offset;
    const candidateYear = year + Math.floor(monthIndex / 12);
    const candidateMonth = ((monthIndex % 12) + 12) % 12;
    const day = Math.min(trigger.day_of_month, daysInUtcMonth(candidateYear, candidateMonth));
    const candidate = utcCandidate(candidateYear, candidateMonth, day, trigger.hour, trigger.minute);
    if (candidate > start) return candidate;
  }

  return start + 86_400_000;
}

export function upcomingFireTimes(rawTrigger, count = 5, afterMs = Date.now()) {
  const trigger = normalizeTrigger(rawTrigger);
  if (trigger.type === "webhook") return [];
  if (trigger.type === "once") return trigger.run_at ? [trigger.run_at] : [];
  const times = [];
  let cursor = afterMs;
  for (let index = 0; index < count; index += 1) {
    const next = nextFireAt(trigger, cursor);
    times.push(next);
    cursor = next + 1000;
  }
  return times;
}

export function rowToAutomation(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    tags: JSON.parse(row.tags || "[]"),
    trigger: normalizeTrigger(JSON.parse(row.trigger_json || "{}")),
  };
}

export function nextAutomationStateAfterFire(automation, now = Date.now()) {
  const trigger = normalizeTrigger(automation.trigger);
  if (trigger.type === "once") {
    return { enabled: false, next_fire_at: null };
  }
  return { enabled: true, next_fire_at: nextFireAt(trigger, now + 1000) };
}

export function createAutomationRunRows({ db, automation, triggerType = "manual", providerKind = null, now = Date.now() }) {
  const runId = newRunId();
  const automationRunId = newAutomationRunId();
  db.prepare(`
    INSERT INTO task_runs (
      id, task_id, mode, stage, agent_name, provider_kind,
      started_at, status, process_status, retry_stage
    ) VALUES (?, NULL, 'automation', 'execute', ?, ?, ?, 'running', 'running', 'execute')
  `).run(runId, automation.agent_name, providerKind, now);
  insertAutomationRun(db, {
    id: automationRunId,
    automationId: automation.id,
    runId,
    triggerType,
    firedAt: now,
  });
  return { runId, automationRunId };
}

export function createAutomationTriggerRow({
  db,
  automation,
  triggerType = "manual",
  outcome,
  reason = null,
  runId = null,
  now = Date.now(),
}) {
  const id = newAutomationTriggerId();
  insertAutomationTrigger(db, {
    id,
    automationId: automation.id,
    taskId: automation.task_id,
    runId,
    triggerType,
    outcome,
    reason,
    firedAt: now,
  });
  return { triggerId: id };
}
