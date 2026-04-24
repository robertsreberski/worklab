import { describe, expect, it } from "vitest";
import { makeTestServer } from "../helpers/test-server.js";

describe("schedules routes", () => {
  it("lists schedules and returns created detail", async () => {
    const { agent } = makeTestServer();

    const create = await agent.post("/api/schedules").send({
      title: "Weekly review",
      cadence: { type: "weekly", weekdays: [1], hour: 9, minute: 30 },
      enabled: true,
    }).expect(201);

    expect(create.body.schedule.title).toBe("Weekly review");
    expect(create.body.schedule.cadence).toMatchObject({ type: "weekly", weekdays: [1], hour: 9, minute: 30 });
    expect(create.body.schedule.upcoming_fires.length).toBeGreaterThan(0);

    const list = await agent.get("/api/schedules").expect(200);
    expect(list.body.schedules).toHaveLength(1);
    expect(list.body.schedules[0]).toMatchObject({
      id: create.body.schedule.id,
      title: "Weekly review",
      enabled: true,
    });
  });

  it("manual run spawns a normal task linked to the schedule", async () => {
    const { agent, db } = makeTestServer();
    const create = await agent.post("/api/schedules").send({
      title: "Daily standup notes",
      instructions: "Capture blockers and decisions.",
      cadence: { type: "daily", hour: 8, minute: 0 },
      enabled: true,
    }).expect(201);

    const run = await agent.post(`/api/schedules/${create.body.schedule.id}/run`).expect(201);
    expect(run.body.task.title).toBe("Daily standup notes");

    const taskRow = db.prepare("SELECT title, source_schedule_id FROM tasks WHERE id = ?").get(run.body.task.id);
    const spawnRow = db.prepare("SELECT schedule_id, task_id, trigger_type FROM schedule_spawns WHERE task_id = ?").get(run.body.task.id);

    expect(taskRow).toMatchObject({
      title: "Daily standup notes",
      source_schedule_id: create.body.schedule.id,
    });
    expect(spawnRow).toMatchObject({
      schedule_id: create.body.schedule.id,
      task_id: run.body.task.id,
      trigger_type: "manual",
    });
  });
});
