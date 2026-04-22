import { describe, it, expect } from "vitest";
import { buildExecuteSystemPrompt } from "../../core/context.js";

describe("buildExecuteSystemPrompt", () => {
  const baseAgent = { name: "coder", instructions: "you are a coder" };
  const baseTask = { id: "t1", title: "demo", description: "desc", instructions: "do things" };

  it("contains agent instructions", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("you are a coder");
  });

  it("contains task title, description, instructions", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("demo");
    expect(p).toContain("desc");
    expect(p).toContain("do things");
  });

  it("renders skill index with priority:always inlined", () => {
    const skills = [
      { name: "pin", trigger: "always", enabled: true, priority: "always", body: "PIN-BODY" },
      { name: "ref", trigger: "on demand", enabled: true, body: "REF-BODY" },
    ];
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills, memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("PIN-BODY");
    expect(p).toContain("- ref: on demand");
    expect(p).not.toContain("REF-BODY");
  });

  it("includes memory and journal tail when present", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "# MEM", journalTail: "- j1", comments: [], pinnedKb: [] });
    expect(p).toContain("# MEM");
    expect(p).toContain("- j1");
  });

  it("renders comment history in order", () => {
    const comments = [
      { author_type: "human", author_id: null, body: "first note", created_at: 1 },
      { author_type: "agent", author_id: "coder", body: "ack", created_at: 2 },
    ];
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments, pinnedKb: [] });
    const firstIdx = p.indexOf("first note");
    const secondIdx = p.indexOf("ack");
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("ends with the cadence instruction", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p.trim().endsWith("if anything rolls up.")).toBe(true);
  });

  it("omits empty sections cleanly (no doubled headers)", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).not.toMatch(/## Memory\s*\n\s*\n\s*## /);
  });

  it("includes pinned KB entries at top", () => {
    const pinnedKb = [{ slug: "conv", title: "Conventions", body: "be nice" }];
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb });
    const instrIdx = p.indexOf("you are a coder");
    const kbIdx = p.indexOf("Conventions");
    expect(kbIdx).toBeGreaterThan(instrIdx);
    expect(p.indexOf("demo")).toBeGreaterThan(kbIdx);
  });
});
