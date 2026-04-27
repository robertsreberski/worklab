import { buildSkillIndex } from "./skills.js";

const CADENCE = `Journal as you work — call \`journal_append\` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call \`journal_summary\` if anything rolls up.`;

const PLAN_DIRECTIVE = `Plan this task. Clarify the work, identify risks, and decide whether to proceed directly or delegate bounded subtasks. Do not do implementation work during planning.

Return a structured Worklab result as JSON when you finish:

{
  "schema": "worklab.v2",
  "stage": "plan",
  "decision": "advance",
  "summary": "Short outcome.",
  "details": "Optional planning notes.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": []
}

Use decision "advance" when the plan is ready and the task should move to work, "delegate" when bounded subtasks should be created, "pause" when explicit human input is required, and "block" when you cannot continue.`;

const WORK_DIRECTIVE = `Do the task work requested by the instructions.

Return a structured Worklab result as JSON when you finish:

{
  "schema": "worklab.v2",
  "stage": "execute",
  "decision": "advance",
  "summary": "Short outcome.",
  "details": "Optional implementation notes.",
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
  const { finalText, agentName, numTurns, durationMs } = execution || {};
  const safeAgentName = agentName ?? "unknown";
  const safeNumTurns = numTurns ?? 0;
  const safeDurationMs = durationMs ?? 0;
  const header = `## Work output (by ${safeAgentName}, ${safeNumTurns} turns, ${formatDuration(safeDurationMs)})`;
  const body = finalText && String(finalText).trim()
    ? String(finalText).trim()
    : "_The owner produced no final text._";
  return `${header}\n\n${body}\n`;
}

function section(title, body) {
  if (!body || !body.trim()) return "";
  return `## ${title}\n\n${body.trim()}\n`;
}

function formatComments(comments) {
  if (!comments?.length) return "";
  return comments
    .map((c, index) => {
      const who = c.author_id ? `${c.author_type} ${c.author_id}` : c.author_type;
      return `### Comment ${index + 1} (${who})\n\n${String(c.body || "").trim()}`;
    })
    .join("\n\n");
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

function formatPriorRuns(priorRuns) {
  if (!priorRuns?.length) return "";
  return priorRuns
    .map((run, index) => {
      const lines = [
        `### Run ${index + 1} - ${run.mode} by ${run.agentName} (${run.status})`,
        run.startedAt ? `- Started: ${formatTimestamp(run.startedAt)}` : "",
        run.endedAt ? `- Ended: ${formatTimestamp(run.endedAt)}` : "",
        run.durationMs ? `- Duration: ${formatDuration(run.durationMs)}` : "",
        run.numTurns ? `- Turns: ${run.numTurns}` : "",
        run.errorText ? `- Error: ${run.errorText}` : "",
      ].filter(Boolean);

      const finalText = clipText(run.finalText);
      if (finalText) {
        lines.push("", "**Final output:**", finalText);
      }

      return lines.join("\n");
    })
    .join("\n\n");
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

function buildBasePrompt({ agent, task, skills, memory, journalTail, comments, pinnedKb, priorRuns }) {
  const parts = [];
  parts.push(section("Role", agent.instructions || ""));
  parts.push(section("Pinned knowledge", formatPinnedKb(pinnedKb)));
  parts.push(renderSkills(skills));
  parts.push(section("Memory", memory || ""));
  parts.push(section("Recent journal", journalTail || ""));
  parts.push(section("Task", buildTaskBody(task, comments)));
  parts.push(section("Prior run history", formatPriorRuns(priorRuns)));
  parts.push(CADENCE);
  return parts;
}

export function buildPlanSystemPrompt(input) {
  const parts = buildBasePrompt(input);
  parts.push(PLAN_DIRECTIVE);
  return parts.filter(Boolean).join("\n");
}

export function buildExecuteSystemPrompt(input) {
  const parts = buildBasePrompt(input);
  parts.push(WORK_DIRECTIVE);
  return parts.filter(Boolean).join("\n");
}

// NOTE: the first 6 sections MUST match buildExecuteSystemPrompt byte-for-byte
// (T13 e2e verifies pinned KB + skills appear identically in both modes).
export function buildReviewSystemPrompt({ agent, task, skills, memory, journalTail, comments, pinnedKb, execution }) {
  const parts = [];
  parts.push(section("Role", agent.instructions || ""));
  parts.push(section("Pinned knowledge", formatPinnedKb(pinnedKb)));
  parts.push(renderSkills(skills));
  parts.push(section("Memory", memory || ""));
  parts.push(section("Recent journal", journalTail || ""));
  parts.push(section("Task", buildTaskBody(task, comments)));
  parts.push(formatWorkOutput(execution || {}));
  parts.push(REVIEW_DIRECTIVE);
  return parts.filter(Boolean).join("\n");
}

export function buildConsolidationSystemPrompt({ agent, memory, journal }) {
  const parts = [];
  parts.push(section("Role", agent.instructions || ""));
  parts.push(section("Current memory", memory || "_No existing memory._"));
  parts.push(section("Full journal", journal || "_No journal entries._"));
  parts.push(CONSOLIDATION_DIRECTIVE);
  return parts.filter(Boolean).join("\n");
}

export function buildAutomationSystemPrompt({ agent, automation, skills, memory, journalTail, pinnedKb }) {
  const parts = [];
  parts.push(section("Role", agent.instructions || ""));
  parts.push(section("Pinned knowledge", formatPinnedKb(pinnedKb)));
  parts.push(renderSkills(skills));
  parts.push(section("Memory", memory || ""));
  parts.push(section("Recent journal", journalTail || ""));
  parts.push(section("Automation", buildAutomationBody(automation)));
  parts.push(CADENCE);
  parts.push(AUTOMATION_DIRECTIVE);
  return parts.filter(Boolean).join("\n");
}
