import { describe, it, expect } from "vitest";
import { buildExecuteSystemPrompt, buildReviewSystemPrompt } from "../../core/context.js";

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

describe("buildReviewSystemPrompt", () => {
  const baseAgent = { name: "reviewer", instructions: "you are a reviewer" };
  const baseTask = { id: "t1", title: "demo", description: "desc", instructions: "do things" };
  const baseExecution = {
    finalText: "I implemented the feature.",
    events: [],
    agentName: "coder",
    durationMs: 1500,
    numTurns: 3,
  };

  it("contains role / pinned KB / skill index / memory / journal / task block / executor output / directive in order", () => {
    const skills = [
      { name: "pin", trigger: "always", enabled: true, priority: "always", body: "PIN-BODY" },
      { name: "ref", trigger: "on demand", enabled: true, body: "REF-BODY" },
    ];
    const pinnedKb = [{ slug: "conv", title: "Conventions", body: "be nice" }];
    const comments = [
      { author_type: "human", author_id: null, body: "some comment", created_at: 1 },
    ];
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills,
      memory: "# MEM",
      journalTail: "- j1",
      comments,
      pinnedKb,
      execution: baseExecution,
    });
    const roleIdx = p.indexOf("you are a reviewer");
    const kbIdx = p.indexOf("Conventions");
    const skillIdx = p.indexOf("- ref: on demand");
    const memIdx = p.indexOf("# MEM");
    const journalIdx = p.indexOf("- j1");
    const taskIdx = p.indexOf("**Title:** demo");
    const execIdx = p.indexOf("## Executor output");
    const directiveIdx = p.indexOf("VERDICT: APPROVE");
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(kbIdx).toBeGreaterThan(roleIdx);
    expect(skillIdx).toBeGreaterThan(kbIdx);
    expect(memIdx).toBeGreaterThan(skillIdx);
    expect(journalIdx).toBeGreaterThan(memIdx);
    expect(taskIdx).toBeGreaterThan(journalIdx);
    expect(execIdx).toBeGreaterThan(taskIdx);
    expect(directiveIdx).toBeGreaterThan(execIdx);
  });

  it("contains the executor finalText verbatim", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { ...baseExecution, finalText: "Here is my work: foo()." },
    });
    expect(p).toContain("Here is my work: foo().");
  });

  it("executor output header reflects agentName, numTurns, durationMs", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { ...baseExecution, agentName: "coder", numTurns: 4, durationMs: 250 },
    });
    expect(p).toContain("## Executor output (by coder, 4 turns, 250ms)");
  });

  it("formats duration <1000ms as `<N>ms`", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { ...baseExecution, durationMs: 999 },
    });
    expect(p).toContain("999ms");
    expect(p).not.toContain("999.0s");
  });

  it("formats duration >=1000ms as `<N.N>s`", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { ...baseExecution, durationMs: 2350 },
    });
    expect(p).toContain("2.4s");
    expect(p).not.toContain("2350ms");
  });

  it("formats exactly 1000ms as `1.0s`", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { ...baseExecution, durationMs: 1000 },
    });
    expect(p).toContain("1.0s");
    expect(p).not.toContain("1000ms");
  });

  it("renders fallback line when finalText is empty", () => {
    for (const empty of ["", null, undefined]) {
      const p = buildReviewSystemPrompt({
        agent: baseAgent,
        task: baseTask,
        skills: [],
        memory: "",
        journalTail: "",
        comments: [],
        pinnedKb: [],
        execution: { ...baseExecution, finalText: empty },
      });
      expect(p).toContain("_The executor produced no final text._");
    }
  });

  it("ends with the review directive (exact spec wording)", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: baseExecution,
    });
    const directive = "Review the executor's work against the task instructions. Respond with a final message whose first line is either `VERDICT: APPROVE` or `VERDICT: REJECT`. If REJECT, follow with bullet-pointed notes the executor can act on.";
    expect(p.trim().endsWith(directive)).toBe(true);
  });

  it("does NOT contain the CADENCE instruction", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: baseExecution,
    });
    expect(p).not.toContain("journal_append");
    expect(p).not.toContain("journal_summary");
  });

  it("omits empty sections cleanly (no doubled headers, no bare headers)", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: baseExecution,
    });
    expect(p).not.toMatch(/## Memory\s*\n\s*\n\s*## /);
    expect(p).not.toMatch(/## Recent journal\s*\n\s*\n\s*## /);
    expect(p).not.toMatch(/## Pinned knowledge\s*\n\s*\n\s*## /);
    expect(p).not.toMatch(/\n\n\n\n/);
  });

  it("pinned KB entries appear between role and task block", () => {
    const pinnedKb = [{ slug: "conv", title: "Conventions", body: "be nice" }];
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb,
      execution: baseExecution,
    });
    const roleIdx = p.indexOf("you are a reviewer");
    const kbIdx = p.indexOf("Conventions");
    const taskIdx = p.indexOf("**Title:** demo");
    expect(kbIdx).toBeGreaterThan(roleIdx);
    expect(taskIdx).toBeGreaterThan(kbIdx);
  });
});
