// src/__tests__/e2e/smoke.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../api/server.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";

describe("e2e smoke", () => {
  let http, baseUrl, tmp, db;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-"));
    db = openDb(join(tmp, "test.db"));
    runMigrations(db);
    const { app } = createServer({ db, logger: { info: () => {}, error: () => {}, debug: () => {} } });
    http = createHttpServer(app);
    await new Promise((r) => http.listen(0, r));
    const { port } = http.address();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise((r) => http.close(r));
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("full task lifecycle via HTTP", async () => {
    // create
    let res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "smoke task" }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json();

    // list
    res = await fetch(`${baseUrl}/api/tasks`);
    const { tasks } = await res.json();
    expect(tasks.some((t) => t.id === task.id)).toBe(true);

    // move through workflow stages
    for (const stage of ["plan", "execute", "review", "done"]) {
      res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      expect(res.status).toBe(200);
      const { task: updated } = await res.json();
      expect(updated.stage).toBe(stage);
    }

    // verify completed_at set
    res = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    const { task: final } = await res.json();
    expect(final.completed_at).toBeTruthy();

    // comment
    res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "done!" }),
    });
    expect(res.status).toBe(201);

    // delete
    res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await fetch(`${baseUrl}/api/schedules`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });
});
