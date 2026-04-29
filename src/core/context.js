import { createHash } from "node:crypto";
import { buildSkillIndex } from "./skills.js";
import { stripWorklabResultJson } from "./worklab-result.js";
import { renderToolSurfaceMarkdown } from "../mcp/worklab-tools.js";

const CADENCE = `Journal as you work — call \`journal_append\` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call \`journal_summary\` if anything rolls up.`;

const DELIVERABLE_PERSISTENCE = `Preserve durable deliverables in Knowledge:
- If the run produces a substantial user-facing deliverable such as a research report, guide, runbook, decision record, implementation notes, or reusable analysis, save the complete deliverable with \`kb_create\` or \`kb_update\` before your final result when Worklab KB tools are available.
- Use a readable slug and title, Markdown body, useful tags, and an appropriate category such as \`run-results\`, \`research\`, \`runbook\`, or \`decision\`.
- Mention the Knowledge slug or link in \`final_text\` so the task comment points to the full deliverable.
- Keep \`final_text\` concise; do not squeeze long deliverables into \`final_text\`. If KB tools are unavailable or saving fails, still include enough final prose for Worklab to preserve it as a fallback.`;

const RESULT_FIELD_RULES = `Structured result rules:
- Worklab needs one final \`worklab.v2\` JSON object when the task is complete. Treat \`worklab.v2\` as final-result data, not progress output.
- Do not preface the final JSON with process narration such as "now I will output the result"; put user-facing text in \`final_text\`.
- During the run, use normal prose or journal entries for progress. If a structured progress object appears before completion, keep going; the final valid result supersedes earlier structured progress.
- Put the human-facing final comment in \`final_text\`. Keep it concise; for structured-only runtimes, this is the text Worklab will post as the final comment.
- Keep \`summary\` and \`details\` as structured metadata for Worklab, not as the main user-visible answer.
- For plan-stage runs, put the complete implementation plan in \`details\` / the plan body and use \`final_text\` only for a short status comment.
- Put execution steps and completed-work notes in \`details\`, not in \`pending_actions\`.
- Use \`pending_actions\` only with decision "pause", for exact actions the human must take before the task can continue.
- Use \`subtasks\` only with decision "delegate", for child Worklab tasks that should be created.
- For "advance", "approve", and "reject", keep both \`pending_actions\` and \`subtasks\` empty.`;

const PLAN_DIRECTIVE = `Plan this task. Clarify the work, identify risks, and decide whether to proceed directly or delegate bounded subtasks. Do not do implementation work during planning.

Return a structured Worklab result as JSON when you finish:

{
  "schema": "worklab.v2",
  "stage": "plan",
  "decision": "advance",
  "summary": "Short outcome.",
  "details": "Complete implementation plan.",
  "final_text": "Short human-facing plan status.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": []
}

Use decision "advance" when the plan is ready and the task should move to work, "delegate" when bounded subtasks should be created, "pause" when explicit human input is required, and "block" when you cannot continue.`;

const WORK_DIRECTIVE = `Do the task work requested by the instructions.

Keep local shell work bounded: avoid whole-home or whole-disk scans unless the user explicitly asked for that scope, prefer targeted paths, use commands that cap output, and summarize large results instead of dumping full command output.

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
  "subtasks": []
}

Use decision "advance" when the work is complete, "delegate" when bounded subtasks should be created, "pause" when explicit human input is required, and "block" when you cannot continue.`;

const REVIEW_DIRECTIVE = `Review the owner's work against the task instructions.

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

function formatAvailableRunLogs(priorRuns) {
  const runs = (priorRuns || []).filter((run) => run?.id);
  if (!runs.length) return "";
  const entries = runs.map((run) => `- \`${run.id}\` (${run.mode} by ${run.agentName}, ${run.status})`).join("\n");
  return [
    "Prior run history above is an abbreviated preview.",
    "When you need exact tool calls, raw model events, or full prior output, call `run_log_read` with a `run_id`.",
    "",
    entries,
  ].join("\n");
}

function formatReviewRunLogs(execution) {
  if (!execution?.runId) return "";
  return [
    "The work output above is an abbreviated preview of the owner run.",
    `For the full raw owner-run log, call \`run_log_read\` with \`run_id: "${execution.runId}"\`.`,
  ].join("\n");
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

function buildAutomationBody(automation) {
  return [
    `**Title:** ${automation.title}`,
    automation.instructions ? `\n**Instructions:**\n${automation.instructions}` : "",
  ].filter(Boolean).join("\n");
}

// Render the agent's runtime capability surface as a tight markdown block.
// CLI providers consume this via the prompt; SDK providers also see it
// because some adapters do not expose static tool docs to the model.
function renderCapabilitiesBlock({ allowedTools = [], disallowedTools = [], mcpServers = {}, worklabToolAllowlist = null } = {}) {
  const lines = [];
  const builtin = (allowedTools || []).filter((tool) => !disallowedTools?.includes(tool));
  if (builtin.length) {
    lines.push(`Built-in tools available: ${builtin.join(", ")}.`);
  } else if (Array.isArray(allowedTools) && allowedTools.length === 0 && Array.isArray(disallowedTools) && disallowedTools.length > 0) {
    lines.push("Built-in tools: disabled for this run.");
  }
  const serverNames = Object.keys(mcpServers || {});
  if (serverNames.includes("worklab")) {
    const surface = renderToolSurfaceMarkdown(worklabToolAllowlist);
    if (surface) {
      lines.push("");
      lines.push("Worklab MCP tools:");
      lines.push(surface);
    }
  }
  const otherServers = serverNames.filter((name) => name !== "worklab");
  if (otherServers.length) {
    lines.push("");
    lines.push(`Other MCP servers connected: ${otherServers.join(", ")}.`);
  }
  return lines.join("\n");
}

const BASE_SECTION_NAMES = [
  "Role",
  "Pinned knowledge",
  "Skills",
  "Memory",
  "Recent journal",
  "Capabilities",
  "Current Run Guidance",
];

// Compose the invariant prefix shared by plan, execute, review and automation.
// Returned as an array of [name, body] pairs so callers can hash a stable
// representation for prompt-cache diagnostics without resorting to
// substring comparisons on the rendered prompt.
function buildBaseSections(input) {
  const {
    agent, skills, memory, journalTail, currentRunComments,
    allowedTools, disallowedTools, mcpServers, pinnedKb,
  } = input;
  return [
    ["Role", agent.instructions || ""],
    ["Pinned knowledge", formatPinnedKb(pinnedKb)],
    ["Skills", renderSkills(skills).trim()],
    ["Memory", memory || ""],
    ["Recent journal", journalTail || ""],
    ["Capabilities", renderCapabilitiesBlock({ allowedTools, disallowedTools, mcpServers })],
    ["Current Run Guidance", formatCurrentRunGuidance(currentRunComments)],
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

function modeDirective(mode) {
  if (mode === "plan") return PLAN_DIRECTIVE;
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
    parts.push(section("Task", buildTaskBody(input.task, input.comments)));
    sectionNames.push("Task");
  }

  if (mode === "review") {
    parts.push(formatWorkOutput(input.execution || {}));
    parts.push(section("Available run logs", formatReviewRunLogs(input.execution)));
    sectionNames.push("Work output", "Available run logs");
  } else if (mode === "plan" || mode === "execute") {
    parts.push(section("Prior run history", formatPriorRuns(input.priorRuns)));
    parts.push(section("Available run logs", formatAvailableRunLogs(input.priorRuns)));
    sectionNames.push("Prior run history", "Available run logs");
  }

  if (mode !== "review") {
    parts.push(CADENCE);
    sectionNames.push("CADENCE");
  }
  if (mode === "execute" || mode === "automation") {
    parts.push(DELIVERABLE_PERSISTENCE);
    sectionNames.push("DELIVERABLE_PERSISTENCE");
  }
  parts.push(RESULT_FIELD_RULES);
  parts.push(modeDirective(mode));
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
