import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-db.js";
import { createScheduleManager } from "../../coordinator/schedule-manager.js";

function stubBroker() {
  const events = [];
  return {
    events,
    broadcast: (_channel, payload) => events.push(payload),
  };
}

describe("schedule manager", () => {
  it("spawns due schedules and advances next_fire_at", () => {
    const db = makeTestDb();
    const broker = stubBroker();
    const now = Date.UTC(2026, 0, 5, 9, 0, 0, 0);

    db.prepare(`
      INSERT INTO schedules (
        id, title, instructions, tags, cadence_json,
        enabled, next_fire_at, created_at, updated_at
      ) VALUES (?, ?, '', '[]', ?, 1, ?, ?, ?)
    `).run(
      "sched_1",
      "Daily sync",
      JSON.stringify({ type: "daily", hour: 9, minute: 0 }),
      now,
      now - 10_000,
      now - 10_000,
    );

    const manager = createScheduleManager({ db, broker });
    const result = manager.tick(now);

    expect(result.started).toHaveLength(1);
    const task = db.prepare("SELECT title, source_schedule_id FROM tasks").get();
    const schedule = db.prepare("SELECT last_fired_at, next_fire_at FROM schedules WHERE id = 'sched_1'").get();
    const spawn = db.prepare("SELECT schedule_id, trigger_type FROM schedule_spawns").get();

    expect(task).toMatchObject({ title: "Daily sync", source_schedule_id: "sched_1" });
    expect(spawn).toMatchObject({ schedule_id: "sched_1", trigger_type: "automatic" });
    expect(schedule.last_fired_at).toBe(now);
    expect(schedule.next_fire_at).toBeGreaterThan(now);
    expect(broker.events.some((event) => event.type === "schedule_triggered")).toBe(true);
  });
});
