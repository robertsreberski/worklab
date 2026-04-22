import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournalEntry, appendJournalSummary, readJournalTail, agentJournalPath } from "../../core/journal.js";

describe("journal", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mk() { const d = mkdtempSync(join(tmpdir(), "worklab-journal-")); dirs.push(d); return d; }

  it("agentJournalPath is <dataDir>/agents/<name>/JOURNAL.md", () => {
    expect(agentJournalPath("/root", "coder")).toBe("/root/agents/coder/JOURNAL.md");
  });

  it("appendJournalEntry creates file and writes bullet with ISO timestamp", () => {
    const d = mk();
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "demo", bullet: "first" });
    const p = join(d, "agents/a/JOURNAL.md");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("## ");
    expect(content).toContain("run r1");
    expect(content).toContain("task t1");
    expect(content).toMatch(/- first/);
  });

  it("multiple appends cluster under one run header", () => {
    const d = mk();
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: "one" });
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: "two" });
    const content = readFileSync(join(d, "agents/a/JOURNAL.md"), "utf8");
    const headers = content.match(/^## /gm) || [];
    expect(headers.length).toBe(1);
    expect(content).toMatch(/- one/);
    expect(content).toMatch(/- two/);
  });

  it("different runs each get their own header", () => {
    const d = mk();
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: "a1" });
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r2", taskId: "t2", taskTitle: "y", bullet: "b1" });
    const content = readFileSync(join(d, "agents/a/JOURNAL.md"), "utf8");
    const headers = content.match(/^## /gm) || [];
    expect(headers.length).toBe(2);
  });

  it("appendJournalSummary writes a (summary) line", () => {
    const d = mk();
    appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: "b" });
    appendJournalSummary({ dataDir: d, agent: "a", runId: "r1", text: "all done" });
    const content = readFileSync(join(d, "agents/a/JOURNAL.md"), "utf8");
    expect(content).toMatch(/\(summary\)/);
    expect(content).toMatch(/all done/);
  });

  it("readJournalTail returns last N lines", () => {
    const d = mk();
    for (let i = 0; i < 50; i++) {
      appendJournalEntry({ dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "x", bullet: `item-${i}` });
    }
    const tail = readJournalTail({ dataDir: d, agent: "a", maxLines: 10 });
    const lines = tail.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(tail).toContain("item-49");
  });

  it("readJournalTail returns empty string when journal missing", () => {
    expect(readJournalTail({ dataDir: mk(), agent: "nobody", maxLines: 80 })).toBe("");
  });
});
