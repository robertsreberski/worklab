import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolHandlers } from "../../mcp/worklab-tools.js";

describe("worklab-tools handlers", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function ctx() {
    const d = mkdtempSync(join(tmpdir(), "worklab-tools-")); dirs.push(d);
    return { dataDir: d, agent: "a", runId: "r1", taskId: "t1", taskTitle: "demo" };
  }

  it("journal_append writes a bullet to the correct file", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    const r = await h.journal_append({ bullet: "hello world" });
    expect(r.ok).toBe(true);
    const content = readFileSync(join(c.dataDir, "agents/a/JOURNAL.md"), "utf8");
    expect(content).toMatch(/- hello world/);
  });

  it("journal_append rejects empty bullet", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await expect(h.journal_append({ bullet: "" })).rejects.toThrow();
  });

  it("journal_summary appends (summary) entry", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    await h.journal_append({ bullet: "b" });
    await h.journal_summary({ text: "done" });
    const content = readFileSync(join(c.dataDir, "agents/a/JOURNAL.md"), "utf8");
    expect(content).toMatch(/\(summary\)/);
  });

  it("memory_read returns empty string when no memory file", async () => {
    const c = ctx();
    const h = createToolHandlers(c);
    const r = await h.memory_read({});
    expect(r.content).toBe("");
  });

  it("memory_read returns existing memory content", async () => {
    const c = ctx();
    mkdirSync(join(c.dataDir, "agents/a"), { recursive: true });
    writeFileSync(join(c.dataDir, "agents/a/MEMORY.md"), "# memory\nstuff");
    const h = createToolHandlers(c);
    const r = await h.memory_read({});
    expect(r.content).toBe("# memory\nstuff");
  });
});
