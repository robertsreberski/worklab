import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/test-db.js";
import { appendJournalEntry, writeMemory } from "../../core/journal.js";
import { agentJournalHash, readAgentMemoryState } from "../../core/memory.js";

describe("agent memory state", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function fixture() {
    const dataDir = mkdtempSync(join(tmpdir(), "worklab-memory-"));
    dirs.push(dataDir);
    const db = makeTestDb();
    const now = Date.now();
    db.prepare("INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("alice", "Alice", "claude", "claude:claude-sonnet-4-6", now, now);
    return { dataDir, db, now };
  }

  function appendJournal(dataDir, bullet = "remember the deploy checklist") {
    appendJournalEntry({
      dataDir,
      agent: "alice",
      runId: `run-${Math.random().toString(36).slice(2)}`,
      taskId: "task-1",
      taskTitle: "Memory task",
      bullet,
    });
  }

  function seedConsolidationRun(db, runId = "run-memory") {
    db.prepare(`
      INSERT INTO task_runs (id, task_id, mode, agent_name, started_at, status)
      VALUES (?, NULL, 'consolidate', 'alice', ?, 'complete')
    `).run(runId, Date.now());
  }

  it("reports no_journal when no journal or memory exists", () => {
    const { db, dataDir } = fixture();

    expect(readAgentMemoryState({ db, dataDir, agent: "alice" })).toMatchObject({
      exists: false,
      journal_exists: false,
      journal_changed: false,
      freshness: "no_journal",
      content: "",
    });
  });

  it("reports not_consolidated when a journal exists but memory has not been written", () => {
    const { db, dataDir } = fixture();
    appendJournal(dataDir);

    expect(readAgentMemoryState({ db, dataDir, agent: "alice" })).toMatchObject({
      exists: false,
      journal_exists: true,
      journal_changed: false,
      freshness: "not_consolidated",
    });
  });

  it("reports current when MEMORY.md matches the recorded journal hash", () => {
    const { db, dataDir, now } = fixture();
    appendJournal(dataDir);
    writeMemory({ dataDir, agent: "alice", content: "# Facts\n- Deploys require a checklist." });
    const hash = agentJournalHash({ dataDir, agent: "alice" });
    seedConsolidationRun(db);
    db.prepare(`
      INSERT INTO agent_consolidations (agent_name, last_journal_hash, last_consolidated_at, last_run_id)
      VALUES (?, ?, ?, ?)
    `).run("alice", hash, now, "run-memory");

    const state = readAgentMemoryState({ db, dataDir, agent: "alice" });

    expect(state).toMatchObject({
      exists: true,
      journal_exists: true,
      journal_changed: false,
      freshness: "current",
      last_run_id: "run-memory",
    });
    expect(state.content).toContain("Deploys require a checklist.");
    expect(state.size_bytes).toBeGreaterThan(0);
    expect(state.updated_at).toBeGreaterThan(0);
  });

  it("reports stale when the journal changes after consolidation", () => {
    const { db, dataDir, now } = fixture();
    appendJournal(dataDir, "old fact");
    writeMemory({ dataDir, agent: "alice", content: "# Facts\n- old fact" });
    const hash = agentJournalHash({ dataDir, agent: "alice" });
    seedConsolidationRun(db);
    db.prepare(`
      INSERT INTO agent_consolidations (agent_name, last_journal_hash, last_consolidated_at, last_run_id)
      VALUES (?, ?, ?, ?)
    `).run("alice", hash, now, "run-memory");

    appendJournal(dataDir, "new fact");

    expect(readAgentMemoryState({ db, dataDir, agent: "alice" })).toMatchObject({
      exists: true,
      journal_exists: true,
      journal_changed: true,
      freshness: "stale",
    });
  });

  it("reports consolidating while a consolidation run is active", () => {
    const { db, dataDir } = fixture();
    appendJournal(dataDir);

    expect(readAgentMemoryState({ db, dataDir, agent: "alice", consolidating: true })).toMatchObject({
      journal_exists: true,
      freshness: "consolidating",
    });
  });
});
