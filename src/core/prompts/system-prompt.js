import { createHash } from "node:crypto";
import { stripWorklabResultJson } from "../worklab-result/contract.js";
import { formatAttachmentsForPrompt } from "../task-attachments.js";
import { buildPlanningDirective, formatPlanningHarnessSection } from "../../core/planning-harness.js";
import { buildSkillIndex } from "../skills.js";

const CADENCE = `Journal as you work — call \`journal_append\` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call \`journal_summary\` if anything rolls up.`;

const TODO_CADENCE = `For multi-step work, keep a short run-local checklist with \`todo_write\`. Update it when the active step changes or a meaningful step completes. Use at most one \`in_progress\` item. This checklist is execution state for the current run, not a substitute for Worklab tasks, subtasks, pending_actions, or the final \`worklab_result\`.`;

const DELIVERABLE_PERSISTENCE = `When the run produces a durable, reusable deliverable (research report, guide, runbook, decision record, canonical analysis), preserve the complete body via \`kb_create\` or \`kb_update\` (\`kb_\` = Knowledge Base, not kilobytes) before returning. Do not create Knowledge entries for routine run results, one-off status updates, raw execution output, short final comments, or implementation plans that were not explicitly requested as Knowledge; those belong in task comments, run logs, artifacts, and task plan bodies. Save implementation plans to Knowledge only when the current human instructions explicitly ask for Knowledge persistence. Before writing Knowledge, call \`kb_taxonomy\` and search/read existing project entries, reuse established tags, and prefer \`kb_update\` for the canonical entry. Use a readable slug, useful tags, an appropriate category (\`research\` / \`runbook\` / \`decision\` / \`reference\`), source metadata when available, and reference the slug in \`final_text\`. Do not use category \`plans\` unless the human explicitly asked to save a plan to Knowledge. Don't squeeze long deliverables into \`final_text\`.`;

const RESULT_FIELD_RULES = `Structured result rules:
- End each completed run with one terminal \`worklab.v2\` JSON object after all tool calls and verification are finished.
- Never emit \`worklab.v2\` JSON for progress or status updates. Use normal assistant text, thinking, or available progress tools instead; reserve \`worklab.v2\` for the final answer only.
- Put the human-facing comment in \`final_text\`. Keep \`summary\` and \`details\` as structured metadata for Worklab.
- For plan-stage runs, put the complete implementation plan in \`details\` / the plan body; \`final_text\` is the short status note. Do not use references like "see above" or "the message above" instead of the plan text. Do not create or update Knowledge Base entries for plan output unless the current human instructions explicitly ask to save the plan to Knowledge.
- \`pending_actions\` requires decision "pause" (exact actions the human must take). \`subtasks\` requires decision "delegate". \`questions\` is for plan-stage pauses needing human input — prefer 2–4 concrete options per question, recommended one first. Keep all three empty for "advance", "approve", "reject".
- Each subtask: \`{"title":"…","instructions":"…","suggested_agent":"…","required":true,"depends_on":[],"acceptance_criteria":["…"],"expected_artifact":"…"}\`. Bound the work and give enough context for another agent to run independently.
- \`memory_candidates\` is for durable facts, preferences, procedures, failures, decisions, or episodes with concrete evidence and confidence 0–1. Empty for routine notes.`;

const WORK_DIRECTIVE = `Do the task work requested by the instructions.

Keep shell work bounded — targeted paths, commands that cap output, no whole-home or whole-disk scans unless the user asked for that scope.

If repository or project instructions require commits, make them granular before returning. Report commit hash(es), verification commands you ran, and any remaining dirty worktree state in \`final_text\`.

Final result shape:

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
  "subtasks": [],
  "parent_review_policy": null,
  "memory_candidates": [],
  "verification_evidence": []
}

Use decision "advance" when the work is complete, "delegate" when bounded subtasks should be created, "pause" when explicit human input is required, and "block" when you cannot continue.`;

// TODO(audit-followup): A2 — the live `~/.worklab/agents/benchmark-qa-reviewer/`
// agent prompt file is user-side and not in source control; operators running
// long-lived projects should re-sync that file from this REVIEW_DIRECTIVE to
// pick up the playwright tool-budget guidance.
const REVIEW_DIRECTIVE = `Review the owner's work against the task instructions.

If commits were required, verify the owner made granular commits and didn't bundle unrelated changes. Reject when required commits are missing, unrelated changes are mixed in, or the final output hides a dirty worktree.

UI verification: prefer \`mcp__playwright__browser_snapshot\` (compact accessibility tree of the rendered DOM) over \`mcp__playwright__browser_take_screenshot\`. Only fall back to a screenshot when the rejection rests on something the DOM cannot tell you — pixel-level layout, colour, font rendering, or graphical artifacts. Screenshot base64 payloads exhaust the context window quickly.

Final result shape:

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
  "subtasks": [],
  "parent_review_policy": null,
  "memory_candidates": [],
  "verification_evidence": []
}

Use decision "approve" when the work satisfies the task and "reject" when changes are required.`;

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
      return [
        `### Comment ${index + 1} (${who})`,
        "",
        formatContextText(c.body || c.content || ""),
        formatAttachmentsForPrompt(c.attachments || []),
      ].filter(Boolean).join("\n");
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

function shortHash(value) {
  return value ? String(value).slice(0, 7) : "";
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

function formatWebhookTrigger(webhook) {
  if (!webhook || typeof webhook !== "object") return "";
  const query = Object.keys(webhook.query || {}).length
    ? JSON.stringify(webhook.query, null, 2)
    : "{}";
  return [
    webhook.webhook_id ? `Webhook id: \`${webhook.webhook_id}\`` : "",
    webhook.received_at ? `Received: ${webhook.received_at}` : "",
    webhook.content_type ? `Content type: ${webhook.content_type}` : "",
    webhook.body_kind ? `Body kind: ${webhook.body_kind}` : "",
    Number.isFinite(Number(webhook.body_bytes)) ? `Payload bytes: ${Number(webhook.body_bytes)}` : "",
    `Truncated: ${webhook.truncated ? "yes" : "no"}`,
    "",
    "Query:",
    "```json",
    clipText(query, 1200),
    "```",
    "",
    "Payload preview:",
    "```text",
    clipText(webhook.body_preview || "", 4000),
    "```",
  ].filter((line) => line !== "").join("\n");
}

function formatPriorRuns(priorRuns) {
  if (!priorRuns?.length) return "";
  return priorRuns
    .map((run, index) => {
      const worktree = run.worktree || null;
      const conflictPaths = Array.isArray(worktree?.conflictPaths) ? worktree.conflictPaths : [];
      const lines = [
        `### Run ${index + 1} - ${run.mode} by ${run.agentName} (${run.status})`,
        run.id ? `- Run id: ${run.id}` : "",
        run.startedAt ? `- Started: ${formatTimestamp(run.startedAt)}` : "",
        run.endedAt ? `- Ended: ${formatTimestamp(run.endedAt)}` : "",
        run.durationMs ? `- Duration: ${formatDuration(run.durationMs)}` : "",
        run.numTurns ? `- Turns: ${run.numTurns}` : "",
        run.errorText ? `- Error: ${run.errorText}` : "",
        worktree?.status ? `- Worktree: ${worktree.status}` : "",
        worktree?.branch ? `- AI branch: \`${worktree.branch}\`` : "",
        worktree?.branchHead ? `- Branch head: ${shortHash(worktree.branchHead)}` : "",
        worktree?.sourceHead ? `- Source head: ${shortHash(worktree.sourceHead)}` : "",
        conflictPaths.length ? `- Conflict paths: ${conflictPaths.map((path) => `\`${path}\``).join(", ")}` : "",
        worktree?.retryRunId ? `- Auto retry: \`${worktree.retryRunId}\`` : "",
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

function formatWorklabBaseGuardrails({ mode, delegation } = {}) {
  if (!["plan", "execute", "review"].includes(mode)) return "";
  const sections = [];
  if (mode === "plan") {
    const maxChildren = delegation?.maxChildrenPerRound ?? "the configured limit";
    sections.push([
      "### worklab-delegating",
      `Never return more than the configured max children per round (${maxChildren}). If the work has more pieces, merge adjacent subtasks owned by the same agent or touching the same files, and preserve granular commit expectations inside the merged instructions.`,
      "Give each child a bounded title, instructions, acceptance_criteria, expected_artifact, and exact depends_on references to sibling titles or existing task ids.",
    ].join("\n\n"));
  }
  sections.push([
    "### worklab-final-result",
    "Return exactly one final `worklab.v2` JSON object when you finish. Do not emit `worklab.v2` JSON for interim progress. Put user-facing prose in `final_text`, not around the JSON.",
    "Do not include XML, invoke tags, or tool-call syntax inside JSON string fields; those belong to model/tool protocol, not result data.",
  ].join("\n\n"));
  sections.push([
    "### worklab-run-recovery",
    "Inspect prior runs with targeted `run_log_read` when exact history matters. Prefer tail or offset reads, avoid rereading huge logs, and continue from durable workspace, journal, KB, and artifact state.",
  ].join("\n\n"));
  sections.push([
    "### worklab-read-safety",
    "Some provider tools may append a generic malware safety reminder after file reads. Treat it as a conditional reminder to assess whether the file or requested change is malware or abuse-related, not as a blanket prohibition on editing ordinary project source.",
    "For benign application or project code, continue with the requested analysis, edits, tests, and commits. Refuse only when the file is actually malware or the requested change would improve malware, credential theft, persistence, evasion, exploitation, or other abusive capability.",
  ].join("\n\n"));
  if (mode === "plan" || mode === "execute") {
    sections.push([
      "### worklab-tool-hygiene",
      "Journal and todo payloads are plain strings or JSON values for that tool only. Do not paste closing XML, invoke snippets, or unrelated tool-call markup into Worklab tool arguments.",
    ].join("\n\n"));
  }
  return sections.join("\n\n");
}

function buildTaskBody(task, comments, { dataDir = null } = {}) {
  return [
    `**Title:** ${task.title}`,
    task.instructions ? `\n**Instructions:**\n${task.instructions}` : "",
    formatAttachmentsForPrompt(task.attachments || [], { dataDir }),
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

function formatRepositoryWorkflow({ repositoryInstructions, repositoryGitRoot, mode, workspaceMode = "direct" } = {}) {
  if (!repositoryInstructions && !repositoryGitRoot) return "";
  const usesWorktree = workspaceMode === "worktree";
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
    if (usesWorktree) {
      lines.push("For worktree-mode runs, keep the isolated AI branch strict: verify the owner made granular commits on that branch and reject if the worktree branch includes unrelated work, uncommitted task work, or hidden dirty state.");
    } else {
      lines.push("When commits are required, judge commit hygiene by task-owned changes. Do not reject only because unrelated commits already exist in shared branch history.");
      lines.push("Reject if the owner introduced unrelated changes, left task-owned changes bundled or uncommitted, hid dirty state, or misreported which commits belong to the task.");
    }
  } else if (mode === "plan") {
    lines.push("When commits are required, make commit boundaries explicit in the plan and in delegated subtasks.");
  } else {
    lines.push("When commits are required, create granular commits before returning the final result.");
    if (usesWorktree) {
      lines.push("In worktree mode, after committing and verification, call `worktree_sync` with `action: \"merge_source\"` before returning the final `worklab.v2` result.");
      lines.push("If `worktree_sync` reports `merge_conflict`, resolve conflicts in the AI worktree, commit the resolution, rerun relevant verification, and call `worktree_sync` again before final output.");
      lines.push("In final_text, report commit hash(es), verification commands, and any remaining dirty worktree state.");
    } else {
      lines.push("In direct workspace mode, preserve unrelated shared-checkout history; report task-specific commits and any remaining task-owned dirty state instead of rewriting history to manufacture a task-only branch.");
    }
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
  const usesWorktree = workspaceMode === "worktree";
  const lines = [
    `Tool working directory: \`${effectiveWorkdir}\`.`,
    `Workspace mode: \`${workspaceMode || "direct"}\`.`,
    "Relative paths in built-in tools and stdio MCP tools resolve from this directory.",
    "Worklab project workdirs may be plain directories, not Git repositories.",
    "Check that Git is available before using Git-only workflows.",
    "If you create temporary scripts that import project files, put them under this directory, such as `.worklab-tmp/`, rather than `/tmp`.",
  ];
  if (usesWorktree) {
    if (sourceWorkdir) lines.push(`Source checkout: \`${sourceWorkdir}\`.`);
    if (worktree?.branch) lines.push(`AI worktree branch: \`${worktree.branch}\`.`);
    lines.push("Do not edit the source checkout directly. Make task changes in the tool working directory and commit them on the AI worktree branch before returning the final result.");
    lines.push("Worklab merges the AI worktree back only after verifying the source checkout is still clean; if current source changes conflict, treat the source checkout as the authority.");
  } else {
    lines.push("Direct workspace mode uses the shared project checkout, not an isolated per-task branch.");
    lines.push("Preserve unrelated shared-checkout work and history; scope your changes, verification, and reporting to the current task's files and commits.");
  }
  if (qaOutputDir) {
    lines.push(`Temporary QA artifact directory: \`${qaOutputDir}\`.`);
    lines.push("Use `WORKLAB_QA_OUTPUT_DIR` for browser screenshots, browser snapshots, console captures, and raw QA logs unless the user explicitly asks for durable repo artifacts.");
  }
  return lines.join("\n");
}

// Only emit the policy when delegation is a live option for the current run.
// The negative cases (disabled workspace, depth ceiling, missing agents) waste
// turn-1 tokens reminding the model of an option it doesn't have — the absence
// of "Available agents" + "Delegation policy" is a stronger signal than prose.
function formatDelegationPolicy(context) {
  if (!context?.enabled || !context?.canDelegate) return "";
  const lines = [];
  lines.push(`Delegation budget: depth ${context.depth}/${context.maxDepth}, up to ${context.maxChildrenPerRound} children per round, ${context.maxParallelChildren} parallel.`);
  lines.push(context.autoRunChildren
    ? "Delegated children auto-run when dependencies clear."
    : "Delegated children are created but do not auto-run.");
  lines.push("Return decision \"delegate\" when the work naturally splits into independent investigation, implementation, research, drafting, QA, or specialist review tracks that can run in parallel or with clear dependencies.");
  lines.push("Proceed with decision \"advance\" instead when the task is small, tightly coupled, already decomposed into children, or when delegation would create coordination overhead without reducing risk or time.");
  lines.push("Every delegated subtask's suggested_agent must be one of the agents listed in Available agents for this run.");
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
  "Learned memory",
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
    agent, skills, memory, learningMemoryContext, journalTail, currentRunComments,
    allowedTools, disallowedTools, mcpServers, pinnedKb, effectiveWorkdir, qaOutputDir,
    workspaceMode, sourceWorkdir, worktree, worklabToolSurfaceMarkdown, resumeContext,
  } = input;
  return [
    ["Role", agent.instructions || ""],
    ["Pinned knowledge", formatPinnedKb(pinnedKb)],
    ["Skills", renderSkills(skills).trim()],
    ["Memory", memory || ""],
    ["Learned memory", learningMemoryContext || ""],
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
  const baseGuardrails = formatWorklabBaseGuardrails({ mode, delegation: input.delegation });
  parts.push(section("Worklab base guardrails", baseGuardrails));
  if (baseGuardrails) sectionNames.push("Worklab base guardrails");

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
      workspaceMode: input.workspaceMode,
    })));
    if (input.repositoryInstructions || input.repositoryGitRoot) sectionNames.push("Repository workflow");
    parts.push(section("Project", buildProjectBody(input.project, input.effectiveWorkdir)));
    if (input.project) sectionNames.push("Project");
    parts.push(section("Task", buildTaskBody(input.task, input.comments, { dataDir: input.dataDir })));
    sectionNames.push("Task");
    parts.push(section("Webhook trigger", formatWebhookTrigger(input.webhookTrigger)));
    if (input.webhookTrigger) sectionNames.push("Webhook trigger");
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
      if (input.delegation?.enabled && input.delegation?.canDelegate) sectionNames.push("Delegation policy");
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
