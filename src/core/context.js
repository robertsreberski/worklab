import { buildSkillIndex } from "./skills.js";

const CADENCE = `Journal as you work — call \`journal_append\` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call \`journal_summary\` if anything rolls up.`;

const RESULT_DIRECTIVE = `Return a structured Worklab result as JSON when you finish:

{
  "schema": "worklab.v2",
  "decision": "advance",
  "summary": "Short outcome.",
  "details": "Optional implementation notes.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": []
}

Use decision "advance" when your stage work is complete, "block" when you cannot continue, "pause" when explicit human input is required, and "delegate" when bounded subtasks should be created.`;

const REVIEW_DIRECTIVE = `Review the executor's work against the task instructions. Return a Worklab JSON result with decision "approve" or "reject". For compatibility, include a first-line verdict inside details when helpful, but the JSON decision is authoritative.`;

const CONSOLIDATION_DIRECTIVE = "Rewrite `MEMORY.md` using the current journal and existing memory. Organize as Procedures / Facts / Gotchas. Deduplicate. Drop anything older than 90 days unless it's a durable fact. Return only the complete new MEMORY.md content.";

// Duration split: <1000 ms → "<N>ms"; >=1000 ms → "<N.N>s" (one decimal, e.g. 2350 → "2.4s").
// Defensively guards against negative, NaN, non-numeric, and other edge cases.
function formatDuration(ms) {
  const n = Math.max(0, Math.trunc(Number(ms) || 0));
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function formatExecutorOutput(execution) {
  const { finalText, agentName, numTurns, durationMs } = execution || {};
  const safeAgentName = agentName ?? "unknown";
  const safeNumTurns = numTurns ?? 0;
  const safeDurationMs = durationMs ?? 0;
  const header = `## Executor output (by ${safeAgentName}, ${safeNumTurns} turns, ${formatDuration(safeDurationMs)})`;
  const body = finalText && String(finalText).trim()
    ? String(finalText).trim()
    : "_The executor produced no final text._";
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

export function buildExecuteSystemPrompt({ agent, task, skills, memory, journalTail, comments, pinnedKb, priorRuns }) {
  const parts = [];
  parts.push(section("Role", agent.instructions || ""));
  parts.push(section("Pinned knowledge", formatPinnedKb(pinnedKb)));
  parts.push(renderSkills(skills));
  parts.push(section("Memory", memory || ""));
  parts.push(section("Recent journal", journalTail || ""));
  parts.push(section("Task", buildTaskBody(task, comments)));
  parts.push(section("Prior run history", formatPriorRuns(priorRuns)));
  parts.push(CADENCE);
  parts.push(RESULT_DIRECTIVE);
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
  parts.push(formatExecutorOutput(execution || {}));
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
