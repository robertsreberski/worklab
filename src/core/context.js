import { buildSkillIndex } from "./skills.js";

const CADENCE = `Journal as you work — call \`journal_append\` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call \`journal_summary\` if anything rolls up.`;

const REVIEW_DIRECTIVE = "Review the executor's work against the task instructions. Respond with a final message whose first line is either `VERDICT: APPROVE` or `VERDICT: REJECT`. If REJECT, follow with bullet-pointed notes the executor can act on.";

// Duration split: <1000 ms → "<N>ms"; >=1000 ms → "<N.N>s" (one decimal, e.g. 2350 → "2.4s").
function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function formatExecutorOutput(execution) {
  const { finalText, agentName, numTurns, durationMs } = execution || {};
  const header = `## Executor output (by ${agentName}, ${numTurns} turns, ${formatDuration(durationMs)})`;
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
    .map(c => {
      const who = c.author_id ? `${c.author_type} ${c.author_id}` : c.author_type;
      return `- [${who}] ${c.body}`;
    })
    .join("\n");
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

function buildTaskBody(task, comments) {
  return [
    `**Title:** ${task.title}`,
    task.description ? `\n**Description:**\n${task.description}` : "",
    task.instructions ? `\n**Instructions:**\n${task.instructions}` : "",
    comments?.length ? `\n**Comments:**\n${formatComments(comments)}` : "",
  ].filter(Boolean).join("\n");
}

export function buildExecuteSystemPrompt({ agent, task, skills, memory, journalTail, comments, pinnedKb }) {
  const parts = [];
  parts.push(section("Role", agent.instructions || ""));
  parts.push(section("Pinned knowledge", formatPinnedKb(pinnedKb)));
  parts.push(renderSkills(skills));
  parts.push(section("Memory", memory || ""));
  parts.push(section("Recent journal", journalTail || ""));
  parts.push(section("Task", buildTaskBody(task, comments)));
  parts.push(CADENCE);
  return parts.filter(Boolean).join("\n");
}

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
