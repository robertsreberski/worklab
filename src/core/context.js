import { buildSkillIndex } from "./skills.js";

const CADENCE = `Journal as you work — call \`journal_append\` for facts you discover, decisions you make, and corrections you learn. At the end of the task, optionally call \`journal_summary\` if anything rolls up.`;

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

export function buildExecuteSystemPrompt({ agent, task, skills, memory, journalTail, comments, pinnedKb }) {
  const parts = [];
  parts.push(section("Role", agent.instructions || ""));
  parts.push(section("Pinned knowledge", formatPinnedKb(pinnedKb)));
  parts.push(renderSkills(skills));
  parts.push(section("Memory", memory || ""));
  parts.push(section("Recent journal", journalTail || ""));
  const taskBody = [
    `**Title:** ${task.title}`,
    task.description ? `\n**Description:**\n${task.description}` : "",
    task.instructions ? `\n**Instructions:**\n${task.instructions}` : "",
    comments?.length ? `\n**Comments:**\n${formatComments(comments)}` : "",
  ].filter(Boolean).join("\n");
  parts.push(section("Task", taskBody));
  parts.push(CADENCE);
  return parts.filter(Boolean).join("\n");
}
