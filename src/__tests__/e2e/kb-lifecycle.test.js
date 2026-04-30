// src/__tests__/e2e/kb-lifecycle.test.js
//
// End-to-end test of the KB HTTP routes and filesystem persistence.
//
// Three scenarios:
//   A) HTTP CRUD + filesystem persistence — create, list, verify file, restart
//      server against same dir, confirm filesystem is source of truth.
//   B) PATCH + DELETE round-trip — update meta, filter by pinned, verify disk,
//      delete, confirm file is gone.
//   C) Agent-authored entry — bypass HTTP, call kbCreate() directly with a
//      custom author, verify GET returns the correct author value.
import { describe, it, expect } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../api/server.js";
import { openDb } from "../../core/db/open.js";
import { runMigrations } from "../../core/db/migrations/runner.js";
import { kbCreate, kbPath } from "../../core/kb.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

/**
 * Minimal watcher stub — KB routes don't depend on the watcher, but
 * createServer() passes it through to the task routes which reference it.
 */
const noopWatcher = {
  handleRunRequested: () => {},
  cancel: () => {},
  shutdown: async () => {},
  isActive: () => false,
};

/**
 * Boot a fresh server + HTTP listener pointing at `dataDir`.
 * Returns { http, baseUrl, db } for the caller.
 */
async function bootServer(dataDir) {
  const db = openDb(join(dataDir, "test.db"));
  runMigrations(db);
  const { app } = createServer({ db, logger: silentLogger, watcher: noopWatcher, dataDir });
  const http = createHttpServer(app);
  await new Promise((resolve) => http.listen(0, resolve));
  const baseUrl = `http://localhost:${http.address().port}`;
  return { http, baseUrl, db };
}

async function stopServer({ http, db }) {
  await new Promise((resolve) => http.close(resolve));
  db.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e: KB lifecycle", () => {
  it("Scenario A — HTTP CRUD + filesystem persistence across server restart", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-kb-a-"));
    try {
      // 1. Boot first server.
      const first = await bootServer(tmp);

      // 2. POST /api/kb
      const createRes = await fetch(`${first.baseUrl}/api/kb`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "team-handbook",
          title: "Team handbook",
          body: "# intro\n\nHello.",
        }),
      });
      // 3. Assert 201 with entry.
      expect(createRes.status).toBe(201);
      const { entry: createdEntry } = await createRes.json();
      expect(createdEntry.meta.slug).toBe("team-handbook");
      expect(createdEntry.meta.title).toBe("Team handbook");
      expect(createdEntry.body).toContain("Hello.");

      // 4. GET /api/kb → list contains the new slug.
      const listRes = await fetch(`${first.baseUrl}/api/kb`);
      expect(listRes.status).toBe(200);
      const { entries } = await listRes.json();
      expect(entries.some((e) => e.slug === "team-handbook")).toBe(true);

      // 5. Assert file exists on disk with correct frontmatter fields.
      const filePath = kbPath(tmp, "team-handbook");
      expect(existsSync(filePath)).toBe(true);
      const fileContent = readFileSync(filePath, "utf8");
      expect(fileContent).toContain("title: Team handbook");
      expect(fileContent).toContain("slug: team-handbook");
      expect(fileContent).toContain("author: human");
      expect(fileContent).toContain("created_at:");
      expect(fileContent).toContain("updated_at:");
      expect(fileContent).toContain("Hello.");

      // 6. Stop the first server + DB.
      await stopServer(first);

      // 7. Open a fresh DB + server pointing at the SAME tmp data dir.
      // The DB is fresh (different file path), so the filesystem IS the source of truth.
      const second = await bootServer(join(tmp));
      // Override the DB path so we truly get a new DB, not the same file.
      // Actually bootServer opens test.db in that dir — same file. Let's use a
      // distinct name to prove filesystem independence.
      await stopServer(second);
      // Re-boot with a new DB filename to prove the filesystem alone drives the list.
      const secondDb = openDb(join(tmp, "test2.db"));
      runMigrations(secondDb);
      const { app: app2 } = createServer({
        db: secondDb,
        logger: silentLogger,
        watcher: noopWatcher,
        dataDir: tmp,
      });
      const http2 = createHttpServer(app2);
      await new Promise((resolve) => http2.listen(0, resolve));
      const baseUrl2 = `http://localhost:${http2.address().port}`;

      // 8. GET /api/kb still returns the entry (filesystem is source of truth).
      const listRes2 = await fetch(`${baseUrl2}/api/kb`);
      expect(listRes2.status).toBe(200);
      const { entries: entries2 } = await listRes2.json();
      expect(entries2.some((e) => e.slug === "team-handbook")).toBe(true);

      // 9. GET /api/kb/:slug → meta + body intact.
      const getRes = await fetch(`${baseUrl2}/api/kb/team-handbook`);
      expect(getRes.status).toBe(200);
      const { entry: fetchedEntry } = await getRes.json();
      expect(fetchedEntry.meta.slug).toBe("team-handbook");
      expect(fetchedEntry.meta.title).toBe("Team handbook");
      expect(fetchedEntry.meta.author).toBe("human");
      expect(fetchedEntry.body).toContain("Hello.");

      await new Promise((resolve) => http2.close(resolve));
      secondDb.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Scenario B — PATCH + DELETE round-trip", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-kb-b-"));
    try {
      const { http, baseUrl, db } = await bootServer(tmp);

      // 1. Create an entry.
      const createRes = await fetch(`${baseUrl}/api/kb`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "ops-runbook",
          title: "Ops runbook",
          body: "Initial content.",
        }),
      });
      expect(createRes.status).toBe(201);

      // 2. PATCH /api/kb/:slug with { pinned: true, tags: ["a", "b"] } → 200.
      const patchRes = await fetch(`${baseUrl}/api/kb/ops-runbook`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true, tags: ["a", "b"] }),
      });
      expect(patchRes.status).toBe(200);
      const { entry: patchedEntry } = await patchRes.json();
      expect(patchedEntry.meta.pinned).toBe(true);
      expect(patchedEntry.meta.tags).toEqual(["a", "b"]);

      // 3. GET /api/kb?pinned=true → entry is in the list.
      const pinnedListRes = await fetch(`${baseUrl}/api/kb?pinned=true`);
      expect(pinnedListRes.status).toBe(200);
      const { entries: pinnedEntries } = await pinnedListRes.json();
      expect(pinnedEntries.some((e) => e.slug === "ops-runbook")).toBe(true);

      // 4. Verify file on disk has pinned: true.
      const filePath = kbPath(tmp, "ops-runbook");
      expect(existsSync(filePath)).toBe(true);
      const fileContent = readFileSync(filePath, "utf8");
      expect(fileContent).toContain("pinned: true");

      // 5. DELETE /api/kb/:slug → 204.
      const deleteRes = await fetch(`${baseUrl}/api/kb/ops-runbook`, { method: "DELETE" });
      expect(deleteRes.status).toBe(204);

      // 6. File no longer exists on disk.
      expect(existsSync(filePath)).toBe(false);

      await stopServer({ http, db });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Scenario C — agent-authored entry (simulating MCP write)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "worklab-e2e-kb-c-"));
    try {
      const { http, baseUrl, db } = await bootServer(tmp);

      // 1. Bypass HTTP route — call kbCreate directly with a custom author.
      kbCreate({
        dataDir: tmp,
        slug: "agent-notes",
        title: "Agent notes",
        body: "Captured by the agent.",
        author: "my-agent",
      });

      // 2. GET /api/kb/:slug → meta.author === "my-agent".
      const getRes = await fetch(`${baseUrl}/api/kb/agent-notes`);
      expect(getRes.status).toBe(200);
      const { entry } = await getRes.json();
      expect(entry.meta.author).toBe("my-agent");
      expect(entry.body).toContain("Captured by the agent.");

      await stopServer({ http, db });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
