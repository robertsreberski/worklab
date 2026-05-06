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

  it("renders the balanced polished planning harness by default", () => {
    const p = buildPlanSystemPrompt({ agent: baseAgent, task: { ...baseTask, stage: "plan" }, skills: [], memory: "", journalTail: "", comments: [], pinnedKb: [] });
    expect(p).toContain("## Planning harness");
    expect(p).toContain("Harness: balanced polished");
    expect(p).toContain("Summary");
    expect(p).toContain("Key Changes");
    expect(p).toContain("Test Plan");
    expect(p).toContain("Assumptions");
    expect(p).toContain("Plan this task.");
    expect(p).toContain("Do not implement it.");
  });

  it("renders deep ExecPlan guidance when selected", () => {
    const p = buildPlanSystemPrompt({
      agent: baseAgent,
      task: { ...baseTask, stage: "plan" },
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      settings: { planning_harness: "execplan_deep", planning_tool_policy: "read_only_no_shell" },
    });
    expect(p).toContain("Harness: ExecPlan deep");
    expect(p).toContain("self-contained ExecPlan");
    expect(p).toContain("Forbidden during planning: Write, Edit, and Bash");
  });

  it("injects the saved plan artifact into execute prompts", () => {
    const p = buildExecuteSystemPrompt({
      agent: baseAgent,
      task: {
        ...baseTask,
        plan_body: "## Summary\n\nImplement the settings selector.\n\n## Test Plan\n\nRun focused tests.",
        plan_updated_by: "planner",
        plan_source_run_id: "run-plan",
      },
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
    });
    expect(p).toContain("## Plan artifact");
    expect(p).toContain("Treat this saved plan as the current implementation contract.");
    expect(p).toContain("Source run: `run-plan`");
    expect(p).toContain("Implement the settings selector.");
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
    expect(p).toContain("keep a short run-local checklist with `todo_write`");
    expect(p).toContain("`kb_` = Knowledge Base, not kilobytes");
    expect(p).toContain("preserve the complete body via `kb_create` or `kb_update`");
    expect(p).toContain("Do not create Knowledge entries for routine run results");
    expect(p).toContain("reference the slug in `final_text`");
    expect(p).toContain("End each completed run with one `worklab.v2` JSON object");
    expect(p).toContain("Put the human-facing comment in `final_text`");
    expect(p).toContain("For plan-stage runs, put the complete implementation plan");
    expect(p).toContain("plan-stage pauses needing human input");
    expect(p).toContain('`pending_actions` requires decision "pause"');
    expect(p).toContain('`subtasks` requires decision "delegate"');
    expect(p).toContain('"final_text": "Concise human-facing final comment."');
    expect(p).toContain('Keep all three empty for "advance", "approve", "reject".');
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

  it("omits Delegation policy when delegation is unavailable at this depth", () => {
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
        canDelegate: false,
        depth: 1,
        maxDepth: 1,
        maxChildrenPerRound: 5,
        maxParallelChildren: 3,
        autoRunChildren: true,
        availableAgents: [],
        childTasks: [],
        disabledReason: "max depth reached",
      },
    });
    expect(p).not.toContain("## Delegation policy");
    expect(p).not.toContain("Delegation is disabled");
    expect(p).not.toContain("max depth reached");
  });

  it("omits Delegation policy when delegation is disabled for the workspace", () => {
    const p = buildExecuteSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      delegation: {
        enabled: false,
        canDelegate: false,
        depth: 0,
        maxDepth: 1,
        maxChildrenPerRound: 5,
        maxParallelChildren: 3,
        autoRunChildren: true,
        availableAgents: [],
        childTasks: [],
        disabledReason: "delegation off",
      },
    });
    expect(p).not.toContain("## Delegation policy");
  });

  it("keeps the minimal-input prompt under 8000 characters", () => {
    const p = buildExecuteSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
    });
    expect(p.length).toBeLessThan(8000);
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
          { name: "researcher", display_name: "Researcher", description: "Parallel research.", sdk: "pi", model: "pi:openai-codex:gpt-5.5", effort: "xhigh" },
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
  it("injects plan-mode Worklab base guardrails regardless of agent skills", () => {
    const p = buildPlanSystemPrompt({
      agent: { name: "planner", instructions: "plan carefully" },
      task: { id: "t1", title: "demo", stage: "plan", instructions: "do things" },
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
        availableAgents: [],
        childTasks: [],
      },
    });

    expect(p).toContain("## Worklab base guardrails");
    expect(p).toContain("### worklab-delegating");
    expect(p).toContain("Never return more than the configured max children per round");
    expect(p).toContain("merge adjacent subtasks owned by the same agent or touching the same files");
    expect(p).toContain("### worklab-final-result");
    expect(p).toContain("Do not include XML, invoke tags, or tool-call syntax inside JSON string fields");
    expect(p).toContain("### worklab-run-recovery");
    expect(p).toContain("Inspect prior runs with targeted `run_log_read`");
    expect(p).toContain("### worklab-tool-hygiene");
  });

  it("keeps execute and review base guardrails mode-specific", () => {
    const execute = buildExecuteSystemPrompt({
      agent: { name: "coder", instructions: "code carefully" },
      task: { id: "t1", title: "demo", stage: "execute", instructions: "do things" },
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
    });
    const review = buildReviewSystemPrompt({
      agent: { name: "reviewer", instructions: "review carefully" },
      task: { id: "t1", title: "demo", stage: "review", instructions: "review things" },
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: { finalText: "done", agentName: "coder", numTurns: 1, durationMs: 100, runId: "run-1" },
    });

    expect(execute).toContain("### worklab-final-result");
    expect(execute).toContain("### worklab-run-recovery");
    expect(execute).toContain("### worklab-tool-hygiene");
    expect(execute).not.toContain("### worklab-delegating");
    expect(review).toContain("### worklab-final-result");
    expect(review).toContain("### worklab-run-recovery");
    expect(review).not.toContain("### worklab-delegating");
    expect(review).not.toContain("### worklab-tool-hygiene");
  });

  it("clarifies provider read safety reminders are conditional", () => {
    const execute = buildExecuteSystemPrompt({
      agent: { name: "coder", instructions: "code carefully" },
      task: { id: "t1", title: "demo", stage: "execute", instructions: "edit benign application code" },
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
    });

    expect(execute).toContain("### worklab-read-safety");
    expect(execute).toContain("generic malware safety reminder after file reads");
    expect(execute).toContain("not as a blanket prohibition on editing ordinary project source");
    expect(execute).toContain("Refuse only when the file is actually malware");
  });

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
    const directiveIdx = p.indexOf("Final result shape:");
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
    expect(p).toContain("Review the owner's work against the task instructions.");
    expect(p).toContain("verify the owner made granular commits");
    expect(p).toContain("`mcp__playwright__browser_snapshot`");
    expect(p).toContain('"stage": "review"');
    expect(p).toContain('"decision": "approve"');
    expect(p.trim().endsWith('Use decision "approve" when the work satisfies the task and "reject" when changes are required.')).toBe(true);
  });

  it("tells direct-workspace reviewers to judge task-owned changes instead of full shared branch history", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: baseExecution,
      effectiveWorkdir: "/repo",
      repositoryGitRoot: "/repo",
      workspaceMode: "direct",
    });

    expect(p).toContain("Workspace mode: `direct`");
    expect(p).toContain("Direct workspace mode uses the shared project checkout, not an isolated per-task branch.");
    expect(p).toContain("judge commit hygiene by task-owned changes");
    expect(p).toContain("Do not reject only because unrelated commits already exist in shared branch history");
    expect(p).toContain("Reject if the owner introduced unrelated changes");
  });

  it("keeps worktree-mode reviewers strict about the isolated AI branch", () => {
    const p = buildReviewSystemPrompt({
      agent: baseAgent,
      task: baseTask,
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      execution: baseExecution,
      effectiveWorkdir: "/worktree",
      repositoryGitRoot: "/source",
      workspaceMode: "worktree",
      sourceWorkdir: "/source",
      worktree: {
        branch: "worklab/run/run-1",
        runtime_workdir: "/worktree",
      },
    });

    expect(p).toContain("Workspace mode: `worktree`");
    expect(p).toContain("AI worktree branch: `worklab/run/run-1`");
    expect(p).toContain("For worktree-mode runs, keep the isolated AI branch strict");
    expect(p).toContain("reject if the worktree branch includes unrelated work");
  });

  it("tells direct-workspace executors to preserve unrelated shared-checkout history", () => {
    const p = buildExecuteSystemPrompt({
      agent: { name: "coder", instructions: "you are a coder" },
      task: { id: "t1", title: "demo", stage: "execute", instructions: "do things" },
      skills: [],
      memory: "",
      journalTail: "",
      comments: [],
      pinnedKb: [],
      effectiveWorkdir: "/repo",
      repositoryGitRoot: "/repo",
      workspaceMode: "direct",
    });

    expect(p).toContain("Direct workspace mode uses the shared project checkout, not an isolated per-task branch.");
    expect(p).toContain("In direct workspace mode, preserve unrelated shared-checkout history");
    expect(p).toContain("report task-specific commits and any remaining task-owned dirty state");
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
