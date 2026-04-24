import { createTaskFromSchedule, nextFireAt, rowToSchedule } from "../core/schedules.js";

const TICK_MS = 60_000;

function refreshEnabledSchedules(db, now = Date.now()) {
  const rows = db.prepare("SELECT * FROM schedules WHERE enabled = 1 ORDER BY updated_at DESC").all();
  const update = db.prepare("UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const schedule = rowToSchedule(row);
    const next = nextFireAt(schedule.cadence, Math.max(now - 1000, schedule.last_fired_at || 0));
    if (next !== schedule.next_fire_at) update.run(next, now, schedule.id);
  }
}

export function createScheduleManager({ db, broker, logger } = {}) {
  let interval = null;

  function runDueSchedules(now = Date.now()) {
    const due = db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC, rowid ASC").all(now);
    const update = db.prepare("UPDATE schedules SET last_fired_at = ?, next_fire_at = ?, updated_at = ? WHERE id = ?");
    const started = [];
    for (const row of due) {
      try {
        const schedule = rowToSchedule(row);
        const task = createTaskFromSchedule({ db, schedule, broker, triggerType: "automatic", now });
        const next = nextFireAt(schedule.cadence, now + 1000);
        update.run(now, next, now, schedule.id);
        broker?.broadcast?.("global", { type: "schedule_triggered", id: schedule.id, taskId: task.id, trigger: "automatic" });
        started.push({ scheduleId: schedule.id, taskId: task.id });
      } catch (error) {
        logger?.warn?.({ err: error.message, scheduleId: row.id }, "scheduled task spawn failed");
      }
    }
    return { started, at: now };
  }

  function start() {
    if (interval) return;
    refreshEnabledSchedules(db);
    interval = setInterval(() => runDueSchedules(), TICK_MS);
    interval.unref?.();
  }

  async function shutdown() {
    if (interval) clearInterval(interval);
    interval = null;
  }

  return {
    start,
    shutdown,
    tick: runDueSchedules,
    refresh: () => refreshEnabledSchedules(db),
  };
}
