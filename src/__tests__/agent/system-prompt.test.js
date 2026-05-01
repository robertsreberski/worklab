import { describe, it, expect } from "vitest";
import { buildConsolidationSystemPrompt, buildExecuteSystemPrompt, buildPlanSystemPrompt, buildReviewSystemPrompt } from "../../agent/prompt/system-prompt.js";

describe("buildExecuteSystemPrompt", () => {
  const baseAgent = { name: "coder", instructions: "you are a coder" };
  const baseTask = { id: "t1", title: "demo", stage: "execute", instructions: "do things" };

  it("contains agent instructions", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("you are a coder");
  });

  it("contains task title, stage, and instructions", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("demo");
    expect(p).toContain("Workflow stage");
    expect(p).toContain("execute");
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

  it("uses agent display names for comment attribution", () => {
    const comments = [
      {
        author_type: "agent",
        author_id: "code-reviewer",
        author: { type: "agent", id: "code-reviewer", display_name: "Code Reviewer" },
        body: "ack",
        created_at: 1,
      },
    ];
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments, pinnedKb: [] });
    expect(p).toContain("### Comment 1 (Code Reviewer)");
    expect(p).not.toContain("agent code-reviewer");
  });

  it("preserves comment bodies and includes bounded prior run history for reruns", () => {
    const prompt = buildExecuteSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [
        {
          author_type: "human",
          author_id: null,
          body: "Please retry this.\n\n- use the clarifying comment\n- double-check the last run",
        },
      ],
      pinnedKb: [],
      priorRuns: [
        {
          id: "run-prior",
          mode: "execute",
          status: "error",
          agentName: "mickey",
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_005_000,
          errorText: "timeout",
          finalText: "Tried a first pass fix.",
          numTurns: 2,
          durationMs: 5_000,
        },
      ],
    });

    expect(prompt).toContain("### Comment 1 (human)");
    expect(prompt).toContain("Please retry this.\n\n- use the clarifying comment\n- double-check the last run");
    expect(prompt).toContain("## Prior run history");
    expect(prompt).toContain("### Run 1 - execute by mickey (error)");
    expect(prompt).toContain("- Run id: run-prior");
    expect(prompt).toContain("- Error: timeout");
    expect(prompt).toContain("**Final output:**\nTried a first pass fix.");
    expect(prompt).toContain("## Available run logs");
    expect(prompt).toContain("call `run_log_read` with a `run_id`");
    expect(prompt).toContain("`run-prior`");
  });

  it("normalizes raw Worklab JSON comments and prior run output before prompting", () => {
    const early = {
      schema: "worklab.v2",
      stage: "execute",
      decision: "advance",
      summary: "early",
      details: "",
      artifacts: {},
      blocking_issues: [],
      pending_actions: ["finish"],
      subtasks: [],
    };
    const final = { ...early, summary: "final", details: "clean details", final_text: "human final comment", pending_actions: [] };
    const prompt = buildExecuteSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [
        { author_type: "agent", author_id: "coder", body: `${JSON.stringify(early)}\n\n${JSON.stringify(final)}` },
      ],
      pinnedKb: [],
      priorRuns: [
        {
          mode: "execute",
          status: "complete",
          agentName: "coder",
          finalText: `${JSON.stringify(early)}\n\n${JSON.stringify(final)}`,
          numTurns: 2,
          durationMs: 1000,
        },
      ],
    });

    expect(prompt).toContain("human final comment");
    expect(prompt).not.toContain("\"schema\":\"worklab.v2\"");
    expect(prompt).not.toContain("early");
    expect(prompt).not.toContain("clean details");
  });

  it("ends with the structured result directive", () => {
    const p = buildExecuteSystemPrompt({ agent: baseAgent, task: baseTask, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("Journal as you work");
    expect(p).toContain("Preserve durable deliverables in the Worklab Knowledge Base");
    expect(p).toContain("the `kb_` prefix means Knowledge Base, not kilobytes");
    expect(p).toContain("save the complete deliverable with `kb_create` or `kb_update`");
    expect(p).toContain("Mention the Worklab Knowledge Base slug or link in `final_text`");
    expect(p).toContain("Worklab needs one final `worklab.v2` JSON object");
    expect(p).toContain("Do not preface the final JSON with process narration");
    expect(p).toContain("the final valid result supersedes earlier structured progress");
    expect(p).toContain("Put the human-facing final comment in `final_text`");
    expect(p).toContain("For plan-stage runs, put the complete implementation plan in `details` / the plan body");
    expect(p).toContain("Use `pending_actions` only with decision \"pause\"");
    expect(p).toContain("Use `subtasks` only with decision \"delegate\"");
    expect(p).toContain('"final_text": "Concise human-facing final comment."');
    expect(p).toContain("For \"advance\", \"approve\", and \"reject\", keep both `pending_actions` and `subtasks` empty.");
    expect(p.trim().endsWith('and "block" when you cannot continue.')).toBe(true);
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

  it("renders delegation policy, available agents, and child summaries", () => {
    const p = buildExecuteSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      delegation: {
        enabled: true,
        canDelegate: true,
        depth: 0,
        maxDepth: 1,
        maxChildrenPerRound: 5,
        maxParallelChildren: 3,
        autoRunChildren: true,
        availableAgents: [
          { name: "researcher", display_name: "Researcher", description: "Parallel research.", sdk: "codex", model: "codex:gpt-5.5", effort: "xhigh" },
        ],
        childTasks: [
          {
            id: "child-1",
            task_key: "T-2",
            title: "Survey sources",
            stage: "done",
            required: true,
            owner_agent: "researcher",
            latest_run: {
              id: "run-child",
              status: "complete",
              process_status: "succeeded",
              decision: "advance",
              summary: "Sources surveyed.",
              artifact_summary: { files_changed: 1 },
            },
          },
        ],
      },
    });

    expect(p).toContain("## Child tasks");
    expect(p).toContain("### T-2: Survey sources");
    expect(p).toContain("Summary: Sources surveyed.");
    expect(p).toContain("## Delegation policy");
    expect(p).toContain("Return decision \"delegate\" when the work naturally splits");
    expect(p).toContain("## Available agents");
    expect(p).toContain("`researcher` (Researcher)");
  });

  it("renders resolved blocker context from latest execute runs", () => {
    const p = buildExecuteSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      resolvedBlockers: [
        {
          id: "blocker-1",
          task_key: "T-7",
          title: "Prepare fixture",
          stage: "done",
          latest_execute_run: {
            id: "run-blocker",
            agentName: "builder",
            status: "complete",
            process_status: "succeeded",
            decision: "advance",
            finalText: "Fixture is ready.",
          },
          artifact_summary: { files: 1, added_lines: 3, removed_lines: 0, run_count: 1 },
          artifacts: [{ path: "fixtures/data.json", display_path: "fixtures/data.json" }],
        },
        {
          id: "blocker-2",
          task_key: "T-8",
          title: "Manual signoff",
          stage: "done",
          latest_execute_run: null,
          artifact_summary: { files: 0 },
          artifacts: [],
        },
      ],
    });

    expect(p).toContain("## Resolved blocker context");
    expect(p).toContain("### T-7: Prepare fixture");
    expect(p).toContain("Latest execute run: `run-blocker` by builder");
    expect(p).toContain("Fixture is ready.");
    expect(p).toContain("Artifacts: 1 file, +3 -0 across 1 run.");
    expect(p).toContain("Changed paths: `fixtures/data.json`.");
    expect(p).toContain("### T-8: Manual signoff");
    expect(p).toContain("Latest execute run: none recorded.");
    expect(p).toContain("`run-blocker` (T-7 blocker execute by builder, complete)");
  });
});

describe("buildPlanSystemPrompt", () => {
  it("uses the planning directive without asking for implementation work", () => {
    const p = buildPlanSystemPrompt({
      agent: { name: "planner", instructions: "plan carefully" },
      task: { id: "t1", title: "demo", stage: "plan", instructions: "do things" },
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
    });
    expect(p).toContain("Plan this task.");
    expect(p).toContain("Do not do implementation work during planning.");
    expect(p).toContain('"details": "Complete implementation plan."');
    expect(p).toContain('"final_text": "Short human-facing plan status."');
    expect(p).toContain('Use decision "advance" when the plan is ready');
    expect(p).not.toContain("Preserve durable deliverables in Knowledge");
  });
});

describe("buildReviewSystemPrompt", () => {
  const baseAgent = { name: "reviewer", instructions: "you are a reviewer" };
  const baseTask = { id: "t1", title: "demo", stage: "review", instructions: "do things" };
  const baseExecution = {
    finalText: "I implemented the feature.",
    events: [],
    agentName: "coder",
    durationMs: 1500,
    numTurns: 3,
  };

  it("contains role / pinned KB / skill index / memory / journal / task block / work output / directive in order", () => {
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
    const execIdx = p.indexOf("## Work output");
    const directiveIdx = p.indexOf("Return a structured Worklab result as JSON");
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(kbIdx).toBeGreaterThan(roleIdx);
    expect(skillIdx).toBeGreaterThan(kbIdx);
    expect(memIdx).toBeGreaterThan(skillIdx);
    expect(journalIdx).toBeGreaterThan(memIdx);
    expect(taskIdx).toBeGreaterThan(journalIdx);
    expect(execIdx).toBeGreaterThan(taskIdx);
    expect(directiveIdx).toBeGreaterThan(execIdx);
  });

  it("contains the owner finalText verbatim", () => {
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

  it("work output header reflects agentName, numTurns, durationMs", () => {
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
    expect(p).toContain("## Work output (by coder, 4 turns, 250ms)");
  });

  it("includes the reviewed run id and run_log_read guidance", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { ...baseExecution, runId: "run-exec" },
    });

    expect(p).toContain("Run id: `run-exec`");
    expect(p).toContain("## Available run logs");
    expect(p).toContain('run_id: "run-exec"');
    expect(p).toContain("`run_log_read`");
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
      expect(p).toContain("_The owner produced no final text._");
    }
  });

  it("ends with the structured review directive", () => {
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
    const directive = `Review the owner's work against the task instructions.

If repository or project instructions required granular commits, verify that the owner committed the relevant work separately and did not bundle unrelated changes. Reject the work when required commits are missing, unrelated changes are mixed together, or the final output hides a dirty worktree.

Return a structured Worklab result as JSON when you finish:

{
  "schema": "worklab.v2",
  "stage": "review",
  "decision": "approve",
  "summary": "Short outcome.",
  "details": "Optional review notes.",
  "final_text": "Human-facing review comment.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": []
}

Use decision "approve" when the work satisfies the task and "reject" when changes are required. For compatibility, include a first-line verdict inside details when helpful, but the JSON decision is authoritative.`;
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

  it("malformed execution (missing agentName, numTurns) does not render undefined literal string", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { finalText: "Some output", durationMs: 500 },
    });
    expect(p).not.toContain("undefined");
    expect(p).toContain("(by unknown, 0 turns, 500ms)");
  });

  it("execution: null does not throw; fallback header and body rendered", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: null,
    });
    expect(p).toContain("## Work output");
    expect(p).toContain("(by unknown, 0 turns, 0ms)");
    expect(p).toContain("_The owner produced no final text._");
  });

  it("negative durationMs is rendered as 0ms", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { ...baseExecution, durationMs: -500 },
    });
    expect(p).toContain("0ms");
    expect(p).not.toContain("-500");
    expect(p).not.toContain("-500ms");
  });

  it("durationMs NaN or bogus values render as 0ms", () => {
    for (const bad of [NaN, "bogus", {}, []]) {
      const p = buildReviewSystemPrompt({
        agent: baseAgent,
        task: baseTask,
        skills: [],
        memory: "",
        journalTail: "",
        comments: [],
        pinnedKb: [],
        execution: { ...baseExecution, durationMs: bad },
      });
      expect(p).toContain("0ms");
      expect(p).not.toContain("undefined");
      expect(p).not.toContain("NaN");
    }
  });
});

describe("buildConsolidationSystemPrompt", () => {
  it("contains only the agent role, current memory, full journal, and consolidation directive", () => {
    const p = buildConsolidationSystemPrompt({
      agent: { name: "alice", instructions: "Keep operational memory concise." },
      memory: "# Procedures\n- old",
      journal: "## run\n- new fact",
    });
    expect(p).toContain("Keep operational memory concise.");
    expect(p).toContain("# Procedures\n- old");
    expect(p).toContain("## run\n- new fact");
    expect(p).toContain("Return only the complete new MEMORY.md content.");
    expect(p).not.toContain("journal_append");
    expect(p).not.toContain("VERDICT:");
  });
});
