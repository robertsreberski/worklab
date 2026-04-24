import { newScheduleSpawnId, newTaskId } from "./ids.js";

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

export function normalizeCadence(raw = {}) {
  const type = ["daily", "weekly", "monthly"].includes(raw?.type) ? raw.type : "daily";
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

export function cadenceSummary(raw) {
  const cadence = normalizeCadence(raw);
  const time = `${pad2(cadence.hour)}:${pad2(cadence.minute)} UTC`;
  if (cadence.type === "daily") return `Daily · ${time}`;
  if (cadence.type === "weekly") {
    const labels = cadence.weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
    return `Weekly · ${labels} · ${time}`;
  }
  return `Monthly · day ${cadence.day_of_month} · ${time}`;
}

export function nextFireAt(rawCadence, afterMs = Date.now()) {
  const cadence = normalizeCadence(rawCadence);
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

  if (cadence.type === "daily") {
    let candidate = utcCandidate(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), cadence.hour, cadence.minute);
    if (candidate <= start) candidate += 86_400_000;
    return candidate;
  }

  if (cadence.type === "weekly") {
    for (let offset = 0; offset <= 14; offset += 1) {
      const current = new Date(start + offset * 86_400_000);
      if (!cadence.weekdays.includes(current.getUTCDay())) continue;
      const candidate = utcCandidate(
        current.getUTCFullYear(),
        current.getUTCMonth(),
        current.getUTCDate(),
        cadence.hour,
        cadence.minute,
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
    const day = Math.min(cadence.day_of_month, daysInUtcMonth(candidateYear, candidateMonth));
    const candidate = utcCandidate(candidateYear, candidateMonth, day, cadence.hour, cadence.minute);
    if (candidate > start) return candidate;
  }

  return start + 86_400_000;
}

export function upcomingFireTimes(rawCadence, count = 5, afterMs = Date.now()) {
  const times = [];
  let cursor = afterMs;
  for (let index = 0; index < count; index += 1) {
    const next = nextFireAt(rawCadence, cursor);
    times.push(next);
    cursor = next + 1000;
  }
  return times;
}

export function rowToSchedule(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: !!row.enabled,
    tags: JSON.parse(row.tags || "[]"),
    cadence: normalizeCadence(JSON.parse(row.cadence_json || "{}")),
  };
}

export function createTaskFromSchedule({ db, schedule, broker, triggerType = "manual", now = Date.now() }) {
  const taskId = newTaskId();
  const spawnId = newScheduleSpawnId();
  db.prepare(`
    INSERT INTO tasks (
      id, title, instructions, status, executor_agent, reviewer_agent,
      tags, source_schedule_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    schedule.title,
    schedule.instructions || "",
    schedule.executor_agent || null,
    schedule.reviewer_agent || null,
    JSON.stringify(schedule.tags || []),
    schedule.id,
    now,
    now,
  );
  db.prepare(`
    INSERT INTO schedule_spawns (id, schedule_id, task_id, trigger_type, fired_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(spawnId, schedule.id, taskId, triggerType, now);
  broker?.broadcast?.("global", { type: "task_created", id: taskId });
  broker?.broadcast?.("global", { type: "schedule_updated", id: schedule.id });
  return {
    id: taskId,
    title: schedule.title,
    status: "todo",
    created_at: now,
    source_schedule_id: schedule.id,
  };
}
