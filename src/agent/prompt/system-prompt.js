import { createHash } from "node:crypto";
import { buildSkillIndex } from "./skill-index.js";
import { stripWorklabResultJson } from "../../ai/result/contract.js";
import { buildPlanningDirective, formatPlanningHarnessSection } from "../../core/planning-harness.js";

const CADENCE = `Journal as you work — call \`journal_append\` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call \`journal_summary\` if anything rolls up.`;

const TODO_CADENCE = `For multi-step work, keep a short run-local checklist with \`todo_write\`. Update it when the active step changes or a meaningful step completes. Use at most one \`in_progress\` item. This checklist is execution state for the current run, not a substitute for Worklab tasks, subtasks, pending_actions, or the final \`worklab_result\`.`;

const DELIVERABLE_PERSISTENCE = `Preserve durable deliverables in the Worklab Knowledge Base:
- In Worklab tool names, the \`kb_\` prefix means Knowledge Base, not kilobytes.
- If the run produces a substantial user-facing deliverable such as a research report, guide, runbook, decision record, implementation notes, or reusable analysis, save the complete deliverable with \`kb_create\` or \`kb_update\` before your final result when Worklab Knowledge Base tools are available.
- Use a readable slug and title, Markdown body, useful tags, and an appropriate category such as \`run-results\`, \`research\`, \`runbook\`, or \`decision\`.
- Mention the Worklab Knowledge Base slug or link in \`final_text\` so the task comment points to the full deliverable.
- Keep \`final_text\` concise; do not squeeze long deliverables into \`final_text\`. If KB tools are unavailable or saving fails, still include enough final prose for Worklab to preserve it as a fallback.`;

const RESULT_FIELD_RULES = `Structured result rules:
- Worklab needs one final \`worklab.v2\` JSON object when the task is complete. Treat \`worklab.v2\` as final-result data, not progress output.
- Do not preface the final JSON with process narration such as "now I will output the result"; put user-facing text in \`final_text\`.
- During the run, use normal prose or journal entries for progress. If a structured progress object appears before completion, keep going; the final valid result supersedes earlier structured progress.
- Put the human-facing final comment in \`final_text\`. Keep it concise; for structured-only runtimes, this is the text Worklab will post as the final comment.
- JSON string fields must be valid JSON strings: escape double quotes inside \`summary\`, \`details\`, and \`final_text\` as \`\\"\`.
- Keep \`summary\` and \`details\` as structured metadata for Worklab, not as the main user-visible answer.
- For plan-stage runs, put the complete implementation plan in \`details\` / the plan body and use \`final_text\` only for a short status comment.
- Put execution steps and completed-work notes in \`details\`, not in \`pending_actions\`.
- Use \`pending_actions\` only with decision "pause", for exact actions the human must take before the task can continue.
- For plan-stage pauses, use \`questions\` for 1-3 critical decisions that the human must answer before a useful plan can be written. Prefer 2-4 concrete options per question, with the recommended option first.
- Use \`subtasks\` only with decision "delegate", for child Worklab tasks that should be created.
- When using \`subtasks\`, keep each child bounded, include enough instructions for another agent to run independently, set \`suggested_agent\` to an enabled agent name when a specific owner is appropriate, and use \`acceptance_criteria\` / \`expected_artifact\` for the child's done condition.
- Subtask \`acceptance_criteria\` and \`depends_on\` must be arrays of strings. Delegate subtask shape: \`{"title":"Child task","instructions":"Do the bounded work.","suggested_agent":"agent-name","required":true,"depends_on":[],"acceptance_criteria":["Done condition."],"expected_artifact":"Short artifact description."}\`.
- For "advance", "approve", and "reject", keep both \`pending_actions\` and \`subtasks\` empty.`;

const WORK_DIRECTIVE = `Do the task work requested by the instructions.

Keep local shell work bounded: avoid whole-home or whole-disk scans unless the user explicitly asked for that scope, prefer targeted paths, use commands that cap output, and summarize large results instead of dumping full command output.

If repository or project instructions require commits, create granular commits before returning the final result. Report the commit hash or hashes, the verification commands you ran, and any remaining dirty worktree state.

Return a structured Worklab result as JSON when you finish:

{
  "schema": "worklab.v2",
  "stage": "execute",
  "decision": "advance",
  "summary": "Short outcome.",
  "details": "Optional implementation notes.",
  "final_text": "Concise human-facing final comment.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "questions": [],
  "subtasks": []
}

Use decision "advance" when the work is complete, "delegate" when bounded subtasks should be created, "pause" when explicit human input is required, and "block" when you cannot continue.`;

// TODO(audit-followup): A2 — the live `~/.worklab/agents/benchmark-qa-reviewer/`
// agent prompt file is user-side and not in source control; operators running
// long-lived projects should re-sync that file from this REVIEW_DIRECTIVE to
// pick up the playwright tool-budget guidance.
const REVIEW_DIRECTIVE = `Review the owner's work against the task instructions.

If repository or project instructions required granular commits, verify that the owner committed the relevant work separately and did not bundle unrelated changes. Reject the work when required commits are missing, unrelated changes are mixed together, or the final output hides a dirty worktree.

Tool budget: when verifying UI work with the Playwright MCP, prefer \`mcp__playwright__browser_snapshot\` (a compact accessibility tree of the rendered DOM) over \`mcp__playwright__browser_take_screenshot\`. Only fall back to a screenshot when the rejection rests on something the DOM cannot tell you — pixel-level layout, colour, font rendering, or graphical artifacts. Screenshots return base64 payloads that quickly exhaust the context window.

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
  "questions": [],
  "subtasks": []
}

Escape double quotes inside review notes or final_text so the response remains valid JSON.
Use decision "approve" when the work satisfies the task and "reject" when changes are required. For compatibility, include a first-line verdict inside details when helpful, but the JSON decision is authoritative.

JSON-only output contract: the very last thing you emit must be a single \`worklab.v2\` JSON object — nothing before it, nothing after it, no markdown fences. Put your prose review in \`details\` and your one-line user-facing comment in \`final_text\`. Do not wrap the JSON in \`\`\`json fences, do not introduce it with phrases like "here is my review", and do not append a verdict line outside the JSON. The harness re-runs you with stricter prompting if it can't parse the result, but only twice — make the first attempt clean.`;

const CONSOLIDATION_DIRECTIVE = "Rewrite `MEMORY.md` using the current journal and existing memory. Organize as Procedures / Facts / Gotchas. Deduplicate. Drop anything older than 90 days unless it's a durable fact. Return only the complete new MEMORY.md content.";

const AUTOMATION_DIRECTIVE = `Run this automation action now. Complete the requested work directly and summarize the result clearly. If you cannot complete it, explain the blocker and what would be needed next.`;

// Duration split: <1000 ms → "<N>ms"; >=1000 ms → "<N.N>s" (one decimal, e.g. 2350 → "2.4s").
// Defensively guards against negative, NaN, non-numeric, and other edge cases.
function formatDuration(ms) {
  const n = Math.max(0, Math.trunc(Number(ms) || 0));
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function formatWorkOutput(execution) {
  const { finalText, agentName, numTurns, durationMs, runId } = execution || {};
  const safeAgentName = agentName ?? "unknown";
  const safeNumTurns = numTurns ?? 0;
  const safeDurationMs = durationMs ?? 0;
  const header = `## Work output (by ${safeAgentName}, ${safeNumTurns} turns, ${formatDuration(safeDurationMs)})`;
  const meta = runId ? `Run id: \`${runId}\`\n\n` : "";
  const formatted = formatContextText(finalText);
  const body = formatted
    ? formatted
    : "_The owner produced no final text._";
  return `${header}\n\n${meta}${body}\n`;
}

function section(title, body) {
  if (!body || !body.trim()) return "";
  return `## ${title}\n\n${body.trim()}\n`;
}

function formatComments(comments) {
  if (!comments?.length) return "";
  return comments
    .map((c, index) => {
      const authorType = c.author_type || c.author?.type || "system";
      const authorId = c.author_id || c.author?.id;
      const displayName = c.author?.display_name || c.author?.displayName || c.author_display_name;
      const who = authorType === "agent" && displayName
        ? displayName
        : (authorId ? `${authorType} ${authorId}` : authorType);
      return `### Comment ${index + 1} (${who})\n\n${formatContextText(c.body || c.content || "")}`;
    })
    .join("\n\n");
}

function formatCurrentRunGuidance(comments) {
  if (!comments?.length) return "";
  return [
    "Treat these human comments as the active instruction for this run.",
    "Apply them before older comments and prior run history. If they conflict with older instructions, the newest current-run comment wins.",
    "",
    formatComments(comments),
  ].join("\n");
}

function formatPinnedKb(pinnedKb) {
  if (!pinnedKb?.length) return "";
  return pinnedKb
    .map(e => `### ${e.title}\n\n${e.body}`)
    .join("\n\n");
}

function renderSkills(skills) {
  const enabled = (skills || []).filter(s => s.enabled);
  if (!enabled.length) return "";
  return buildSkillIndex(enabled).trim() + "\n";
}

function formatTimestamp(ts) {
  return ts ? new Date(ts).toISOString() : "";
}

function clipText(text, maxChars = 1200) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n...[truncated]`;
}

function collapseDuplicateParagraphs(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const paragraphs = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return raw;
  const seen = new Set();
  return paragraphs.filter((paragraph) => {
    const key = paragraph.replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n\n");
}

function formatContextText(text, maxChars = 1200) {
  return clipText(collapseDuplicateParagraphs(stripWorklabResultJson(text)), maxChars);
}

function formatPriorRuns(priorRuns) {
  if (!priorRuns?.length) return "";
  return priorRuns
    .map((run, index) => {
      const lines = [
        `### Run ${index + 1} - ${run.mode} by ${run.agentName} (${run.status})`,
        run.id ? `- Run id: ${run.id}` : "",
        run.startedAt ? `- Started: ${formatTimestamp(run.startedAt)}` : "",
        run.endedAt ? `- Ended: ${formatTimestamp(run.endedAt)}` : "",
        run.durationMs ? `- Duration: ${formatDuration(run.durationMs)}` : "",
        run.numTurns ? `- Turns: ${run.numTurns}` : "",
        run.errorText ? `- Error: ${run.errorText}` : "",
      ].filter(Boolean);

      const finalText = formatContextText(run.finalText);
      if (finalText) {
        lines.push("", "**Final output:**", finalText);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

function resolvedBlockerRunEntries(resolvedBlockers) {
  return (resolvedBlockers || [])
    .map((blocker) => {
      const run = blocker?.latest_execute_run;
      if (!run?.id) return null;
      const ref = blocker.task_key || blocker.id;
      const agentName = run.agentName || run.agent_name || "unknown";
      return {
        id: run.id,
        label: `${ref} blocker execute by ${agentName}`,
        status: run.status || run.process_status || "unknown",
      };
    })
    .filter(Boolean);
}

function formatArtifactSummary(summary = {}) {
  const files = Number(summary.files || 0);
  if (!files) return "";
  const added = Number(summary.added_lines || 0);
  const removed = Number(summary.removed_lines || 0);
  const runs = Number(summary.run_count || 0);
  const lineLabel = added || removed ? `, +${added} -${removed}` : "";
  const runLabel = runs ? ` across ${runs} run${runs === 1 ? "" : "s"}` : "";
  return `${files} file${files === 1 ? "" : "s"}${lineLabel}${runLabel}`;
}

function formatResolvedBlockers(resolvedBlockers) {
  const blockers = resolvedBlockers || [];
  if (!blockers.length) return "";
  return blockers.map((blocker) => {
    const ref = blocker.task_key || blocker.id;
    const latest = blocker.latest_execute_run;
    const artifactSummary = formatArtifactSummary(blocker.artifact_summary);
    const artifacts = (blocker.artifacts || []).slice(0, 8);
    const artifactPaths = artifacts
      .map((artifact) => artifact.display_path || artifact.path)
      .filter(Boolean);
    const lines = [
      `### ${ref}: ${blocker.title}`,
      `Stage: ${blocker.stage || "done"}.`,
    ];
    if (latest) {
      const agentName = latest.agentName || latest.agent_name || "unknown";
      const status = [latest.status, latest.process_status].filter(Boolean).join("/") || "unknown";
      lines.push(`Latest execute run: \`${latest.id}\` by ${agentName} (${status}${latest.decision ? `, decision ${latest.decision}` : ""}).`);
      const output = formatContextText(latest.finalText || latest.summary || latest.details || "", 900);
      if (output) lines.push("", "**Output:**", output);
    } else {
      lines.push("Latest execute run: none recorded.");
    }
    if (artifactSummary) lines.push(`Artifacts: ${artifactSummary}.`);
    if (artifactPaths.length) {
      lines.push(`Changed paths: ${artifactPaths.map((path) => `\`${path}\``).join(", ")}${(blocker.artifacts || []).length > artifactPaths.length ? ", ..." : ""}.`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

function formatAvailableRunLogs(priorRuns, resolvedBlockers = []) {
  const runs = (priorRuns || []).filter((run) => run?.id);
  const blockerRuns = resolvedBlockerRunEntries(resolvedBlockers);
  if (!runs.length && !blockerRuns.length) return "";
  const entries = [
    ...runs.map((run) => `- \`${run.id}\` (${run.mode} by ${run.agentName}, ${run.status})`),
    ...blockerRuns.map((run) => `- \`${run.id}\` (${run.label}, ${run.status})`),
  ].join("\n");
  return [
    blockerRuns.length
      ? "Prior run history and resolved blocker context above are abbreviated previews."
      : "Prior run history above is an abbreviated preview.",
    "When you need exact tool calls, raw model events, or full prior output, call `run_log_read` with a `run_id`.",
    "",
    entries,
  ].join("\n");
}

function formatReviewRunLogs(execution, resolvedBlockers = []) {
  const blockerRuns = resolvedBlockerRunEntries(resolvedBlockers);
  if (!execution?.runId && !blockerRuns.length) return "";
  const lines = [];
  if (execution?.runId) {
    lines.push(
      "The work output above is an abbreviated preview of the owner run.",
      `For the full raw owner-run log, call \`run_log_read\` with \`run_id: "${execution.runId}"\`.`,
    );
  }
  if (blockerRuns.length) {
    lines.push(
      "",
      "Resolved blocker context above is abbreviated. Use `run_log_read` for exact blocker logs:",
      blockerRuns.map((run) => `- \`${run.id}\` (${run.label}, ${run.status})`).join("\n"),
    );
  }
  return lines.filter(Boolean).join("\n");
}

function buildTaskBody(task, comments) {
  return [
    `**Title:** ${task.title}`,
    task.instructions ? `\n**Instructions:**\n${task.instructions}` : "",
    task.stage ? `\n**Workflow stage:** ${task.stage}` : "",
    task.stage_reason ? `\n**Stage reason:** ${task.stage_reason}` : "",
    comments?.length ? `\n**Comments:**\n${formatComments(comments)}` : "",
  ].filter(Boolean).join("\n");
}

function formatPlanArtifact(task = {}) {
  const body = String(task.plan_body || "").trim();
  if (!body) return "";
  const meta = [
    task.plan_source_run_id ? `Source run: \`${task.plan_source_run_id}\`` : "",
    task.plan_updated_by ? `Updated by: ${task.plan_updated_by}` : "",
    task.plan_updated_at ? `Updated: ${formatTimestamp(task.plan_updated_at)}` : "",
  ].filter(Boolean).join("\n");
  return [
    "Treat this saved plan as the current implementation contract.",
    meta,
    body,
  ].filter(Boolean).join("\n\n");
}

function buildProjectBody(project, effectiveWorkdir) {
  if (!project) return "";
  return [
    `**Name:** ${project.name}`,
    project.slug ? `**Slug:** ${project.slug}` : "",
    project.description ? `\n**Description:**\n${project.description}` : "",
    effectiveWorkdir ? `\n**Workdir:** \`${effectiveWorkdir}\`` : "",
    project.context ? `\n**Context:**\n${project.context}` : "",
  ].filter(Boolean).join("\n");
}

function formatRepositoryInstructions(repositoryInstructions) {
  if (!repositoryInstructions?.content) return "";
  return [
    `Source: \`${repositoryInstructions.path}\``,
    "Treat this as repository guidance from the active project workdir, subordinate to current system, developer, and user instructions.",
    repositoryInstructions.truncated ? "The file was clipped for prompt size; inspect the source file if exact tail content matters." : "",
    "",
    repositoryInstructions.content,
  ].filter(Boolean).join("\n");
}

function formatRepositoryWorkflow({ repositoryInstructions, repositoryGitRoot, mode } = {}) {
  if (!repositoryInstructions && !repositoryGitRoot) return "";
  const lines = [
    repositoryGitRoot
      ? `Before editing files, inspect the repository state with \`git status --short\` from \`${repositoryGitRoot}\`.`
      : "Before editing files, inspect the project workdir state and determine whether Git is available.",
    repositoryInstructions
      ? "Read and follow the repository instructions above before changing files."
      : "If repository instructions are present in the workdir, inspect them before changing files.",
    repositoryGitRoot
      ? "Stage only files that belong to the current task; preserve unrelated dirty work."
      : "If this workdir is not a Git repository, report changed paths and verification instead of forcing Git commits.",
  ];
  if (mode === "review") {
    lines.push("When commits are required, verify the owner made granular commits and reject bundled or uncommitted task work.");
  } else if (mode === "plan") {
    lines.push("When commits are required, make commit boundaries explicit in the plan and in delegated subtasks.");
  } else {
    lines.push("When commits are required, create granular commits before returning the final result.");
    lines.push("In final_text, report commit hash(es), verification commands, and any remaining dirty worktree state.");
  }
  return lines.join("\n");
}

function buildAutomationBody(automation) {
  return [
    `**Title:** ${automation.title}`,
    automation.instructions ? `\n**Instructions:**\n${automation.instructions}` : "",
  ].filter(Boolean).join("\n");
}

// Render the agent's runtime capability surface as a tight markdown block.
// CLI providers consume this via the prompt; SDK providers also see it
// because some adapters do not expose static tool docs to the model.
//
// `worklabToolSurfaceMarkdown` is pre-rendered by the caller (run-input,
// worker, assistant) — the kernel does not import the tool registry.
function renderCapabilitiesBlock({ allowedTools = [], disallowedTools = [], mcpServers = {}, worklabToolSurfaceMarkdown = "" } = {}) {
  const lines = [];
  const builtin = (allowedTools || []).filter((tool) => !disallowedTools?.includes(tool));
  if (builtin.length) {
    lines.push(`Built-in tools available: ${builtin.join(", ")}.`);
  } else if (Array.isArray(allowedTools) && allowedTools.length === 0 && Array.isArray(disallowedTools) && disallowedTools.length > 0) {
    lines.push("Built-in tools: disabled for this run.");
  }
  const serverNames = Object.keys(mcpServers || {});
  if (serverNames.includes("worklab") && worklabToolSurfaceMarkdown) {
    lines.push("");
    lines.push("Worklab MCP tools:");
    lines.push(worklabToolSurfaceMarkdown);
  }
  const otherServers = serverNames.filter((name) => name !== "worklab");
  if (otherServers.length) {
    lines.push("");
    lines.push(`Other MCP servers connected: ${otherServers.join(", ")}.`);
  }
  return lines.join("\n");
}

function formatWorkspaceGuidance(effectiveWorkdir, qaOutputDir, { workspaceMode = "direct", sourceWorkdir = null, worktree = null } = {}) {
  if (!effectiveWorkdir) return "";
  const lines = [
    `Tool working directory: \`${effectiveWorkdir}\`.`,
    `Workspace mode: \`${workspaceMode || "direct"}\`.`,
    "Relative paths in built-in tools and stdio MCP tools resolve from this directory.",
    "Worklab project workdirs may be plain directories, not Git repositories.",
    "Check that Git is available before using Git-only workflows.",
    "If you create temporary scripts that import project files, put them under this directory, such as `.worklab-tmp/`, rather than `/tmp`.",
  ];
  if (workspaceMode === "worktree") {
    if (sourceWorkdir) lines.push(`Source checkout: \`${sourceWorkdir}\`.`);
    if (worktree?.branch) lines.push(`AI worktree branch: \`${worktree.branch}\`.`);
    lines.push("Do not edit the source checkout directly. Make task changes in the tool working directory and commit them on the AI worktree branch before returning the final result.");
    lines.push("Worklab merges the AI worktree back only after verifying the source checkout is still clean; if current source changes conflict, treat the source checkout as the authority.");
  }
  if (qaOutputDir) {
    lines.push(`Temporary QA artifact directory: \`${qaOutputDir}\`.`);
    lines.push("Use `WORKLAB_QA_OUTPUT_DIR` for browser screenshots, browser snapshots, console captures, and raw QA logs unless the user explicitly asks for durable repo artifacts.");
  }
  return lines.join("\n");
}

function formatDelegationPolicy(context) {
  if (!context) return "";
  const lines = [];
  if (!context.enabled) {
    lines.push("Delegation is disabled for this workspace. Do not return decision \"delegate\".");
    if (context.disabledReason) lines.push(`Reason: ${context.disabledReason}.`);
    return lines.join("\n");
  }

  lines.push(`Delegation policy: ${context.canDelegate ? "available" : "unavailable"} for this task.`);
  lines.push(`Current depth: ${context.depth}/${context.maxDepth}. Max children per round: ${context.maxChildrenPerRound}. Max parallel child runs: ${context.maxParallelChildren}.`);
  lines.push(context.autoRunChildren
    ? "Delegated children auto-run when their dependencies are clear."
    : "Delegated children are created but do not auto-run.");
  if (!context.canDelegate) {
    lines.push(`Do not return decision "delegate": ${context.disabledReason || "delegation is unavailable"}.`);
    return lines.join("\n");
  }
  lines.push("Return decision \"delegate\" when the work naturally splits into independent investigation, implementation, research, drafting, QA, or specialist review tracks that can run in parallel or with clear dependencies.");
  lines.push("Proceed with decision \"advance\" instead when the task is small, tightly coupled, already decomposed into children, or when delegation would create coordination overhead without reducing risk or time.");
  lines.push("Use at most the configured child limit, prefer required children for work the parent must synthesize, and use optional children only for helpful extra validation.");
  return lines.join("\n");
}

function formatAvailableAgents(context) {
  const agents = context?.availableAgents || [];
  if (!context?.enabled || agents.length === 0) return "";
  return agents.map((agent) => {
    const label = agent.display_name && agent.display_name !== agent.name
      ? `\`${agent.name}\` (${agent.display_name})`
      : `\`${agent.name}\``;
    const runtime = [agent.sdk, agent.model, agent.effort].filter(Boolean).join(" / ");
    const description = agent.description ? ` - ${agent.description}` : "";
    return `- ${label}${runtime ? `: ${runtime}` : ""}${description}`;
  }).join("\n");
}

function formatChildTasks(context) {
  const children = context?.childTasks || [];
  if (!children.length) return "";
  return children.map((child) => {
    const ref = child.task_key || child.id;
    const owner = child.owner_agent ? `, owner ${child.owner_agent}` : "";
    const required = child.required ? "required" : "optional";
    const latest = child.latest_run;
    const runLine = latest
      ? `Last run: ${latest.status}/${latest.process_status}${latest.decision ? `, decision ${latest.decision}` : ""}${latest.failure_kind ? `, failure ${latest.failure_kind}` : ""}.`
      : "Last run: none.";
    const summary = latest?.summary || latest?.result?.summary || "";
    const artifactSummary = latest?.artifact_summary;
    const artifactText = artifactSummary && Object.keys(artifactSummary).length
      ? ` Artifacts: ${formatContextText(JSON.stringify(artifactSummary), 500)}`
      : "";
    return [
      `### ${ref}: ${child.title}`,
      `Stage: ${child.stage} (${required}${owner}).`,
      child.stage_reason ? `Reason: ${child.stage_reason}.` : "",
      runLine,
      summary ? `Summary: ${formatContextText(summary, 500)}` : "",
      artifactText.trim(),
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

const BASE_SECTION_NAMES = [
  "Role",
  "Pinned knowledge",
  "Skills",
  "Memory",
  "Recent journal",
  "Capabilities",
  "Workspace",
  "Current Run Guidance",
  "Resume context",
];

// Compose the invariant prefix shared by plan, execute, review and automation.
// Returned as an array of [name, body] pairs so callers can hash a stable
// representation for prompt-cache diagnostics without resorting to
// substring comparisons on the rendered prompt.
function buildBaseSections(input) {
  const {
    agent, skills, memory, journalTail, currentRunComments,
    allowedTools, disallowedTools, mcpServers, pinnedKb, effectiveWorkdir, qaOutputDir,
    workspaceMode, sourceWorkdir, worktree, worklabToolSurfaceMarkdown, resumeContext,
  } = input;
  return [
    ["Role", agent.instructions || ""],
    ["Pinned knowledge", formatPinnedKb(pinnedKb)],
    ["Skills", renderSkills(skills).trim()],
    ["Memory", memory || ""],
    ["Recent journal", journalTail || ""],
    ["Capabilities", renderCapabilitiesBlock({ allowedTools, disallowedTools, mcpServers, worklabToolSurfaceMarkdown })],
    ["Workspace", formatWorkspaceGuidance(effectiveWorkdir, qaOutputDir, { workspaceMode, sourceWorkdir, worktree })],
    ["Current Run Guidance", formatCurrentRunGuidance(currentRunComments)],
    ["Resume context", resumeContext || ""],
  ];
}

function renderSectionParts(sectionPairs) {
  return sectionPairs.map(([name, body]) => {
    if (!body || !String(body).trim()) return "";
    if (name === "Skills") return `${body}\n`;
    return section(name, body);
  });
}

function hashPrefix(sectionPairs) {
  const hash = createHash("sha256");
  for (const [name, body] of sectionPairs) {
    hash.update(`${name} ${body || ""} `);
  }
  return hash.digest("hex").slice(0, 16);
}

function modeDirective(mode, settings) {
  if (mode === "plan") return buildPlanningDirective(settings);
  if (mode === "review") return REVIEW_DIRECTIVE;
  if (mode === "automation") return AUTOMATION_DIRECTIVE;
  if (mode === "consolidate") return CONSOLIDATION_DIRECTIVE;
  return WORK_DIRECTIVE;
}

// Single source of truth for prompt assembly. Returns:
//   - text: the rendered system prompt
//   - prefixHash: a stable 16-char sha256 over the invariant prefix
//                 (Role…Current Run Guidance) used for diagnostics and
//                 to verify Claude SDK prompt-cache stability across modes
//   - sections: the list of section names actually emitted (for diagnostics)
export function buildSystemPrompt(input, mode) {
  if (mode === "consolidate") {
    const parts = [
      section("Role", input.agent.instructions || ""),
      section("Current memory", input.memory || "_No existing memory._"),
      section("Full journal", input.journal || "_No journal entries._"),
      CONSOLIDATION_DIRECTIVE,
    ];
    return {
      text: parts.filter(Boolean).join("\n"),
      prefixHash: null,
      sections: ["Role", "Current memory", "Full journal", "directive:consolidate"],
    };
  }

  const baseSections = buildBaseSections(input);
  const prefixHash = hashPrefix(baseSections);
  const parts = renderSectionParts(baseSections);
  const sectionNames = [...BASE_SECTION_NAMES];

  if (mode === "automation") {
    parts.push(section("Automation", buildAutomationBody(input.automation)));
    sectionNames.push("Automation");
  } else {
    if (mode === "plan") {
      parts.push(section("Planning harness", formatPlanningHarnessSection(input.settings)));
      sectionNames.push("Planning harness");
    }
    parts.push(section("Repository instructions", formatRepositoryInstructions(input.repositoryInstructions)));
    if (input.repositoryInstructions) sectionNames.push("Repository instructions");
    parts.push(section("Repository workflow", formatRepositoryWorkflow({
      repositoryInstructions: input.repositoryInstructions,
      repositoryGitRoot: input.repositoryGitRoot,
      mode,
    })));
    if (input.repositoryInstructions || input.repositoryGitRoot) sectionNames.push("Repository workflow");
    parts.push(section("Project", buildProjectBody(input.project, input.effectiveWorkdir)));
    if (input.project) sectionNames.push("Project");
    parts.push(section("Task", buildTaskBody(input.task, input.comments)));
    sectionNames.push("Task");
    if (mode === "execute" || mode === "review") {
      parts.push(section("Plan artifact", formatPlanArtifact(input.task)));
      if (input.task?.plan_body) sectionNames.push("Plan artifact");
    }
    parts.push(section("Resolved blocker context", formatResolvedBlockers(input.resolvedBlockers)));
    if (input.resolvedBlockers?.length) sectionNames.push("Resolved blocker context");
    if (mode === "plan" || mode === "execute") {
      parts.push(section("Child tasks", formatChildTasks(input.delegation)));
      if (input.delegation?.childTasks?.length) sectionNames.push("Child tasks");
      parts.push(section("Delegation policy", formatDelegationPolicy(input.delegation)));
      if (input.delegation) sectionNames.push("Delegation policy");
      parts.push(section("Available agents", formatAvailableAgents(input.delegation)));
      if (input.delegation?.enabled && input.delegation?.availableAgents?.length) sectionNames.push("Available agents");
    }
  }

  if (mode === "review") {
    parts.push(formatWorkOutput(input.execution || {}));
    parts.push(section("Task artifacts", input.taskArtifactsMarkdown || ""));
    parts.push(section("Available run logs", formatReviewRunLogs(input.execution, input.resolvedBlockers)));
    sectionNames.push("Work output", "Task artifacts", "Available run logs");
  } else if (mode === "plan" || mode === "execute") {
    parts.push(section("Prior run history", formatPriorRuns(input.priorRuns)));
    parts.push(section("Task artifacts", input.taskArtifactsMarkdown || ""));
    parts.push(section("Available run logs", formatAvailableRunLogs(input.priorRuns, input.resolvedBlockers)));
    sectionNames.push("Prior run history", "Task artifacts", "Available run logs");
  }

  if (mode !== "review") {
    parts.push(CADENCE);
    parts.push(TODO_CADENCE);
    sectionNames.push("CADENCE", "TODO_CADENCE");
  }
  if (mode === "execute" || mode === "automation") {
    parts.push(DELIVERABLE_PERSISTENCE);
    sectionNames.push("DELIVERABLE_PERSISTENCE");
  }
  parts.push(RESULT_FIELD_RULES);
  parts.push(modeDirective(mode, input.settings));
  sectionNames.push("RESULT_FIELD_RULES", `directive:${mode}`);

  return {
    text: parts.filter(Boolean).join("\n"),
    prefixHash,
    sections: sectionNames,
  };
}

// Backward-compatible wrappers — existing callers (worker.js, tests) keep
// working while new code uses buildSystemPrompt directly. Each wrapper
// returns the rendered text only; diagnostics callers use buildSystemPrompt.
export function buildPlanSystemPrompt(input) {
  return buildSystemPrompt(input, "plan").text;
}

export function buildExecuteSystemPrompt(input) {
  return buildSystemPrompt(input, "execute").text;
}

export function buildReviewSystemPrompt(input) {
  return buildSystemPrompt(input, "review").text;
}

export function buildConsolidationSystemPrompt(input) {
  return buildSystemPrompt(input, "consolidate").text;
}

export function buildAutomationSystemPrompt(input) {
  return buildSystemPrompt(input, "automation").text;
}
