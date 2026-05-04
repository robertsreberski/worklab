import { buildSkillIndex } from "../../core/index.js";

function section(title, body) {
  const text = String(body || "").trim();
  return text ? `## ${title}\n\n${text}\n` : "";
}

function clip(text, maxChars = 4000) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function formatInput(input) {
  const lines = [
    "Source: slack",
    input.type ? `Type: ${input.type}` : "",
    input.title ? `Title: ${input.title}` : "",
    input.channel_id ? `Slack channel: ${input.channel_id}` : "",
    input.user_id ? `Slack user: ${input.user_id}` : "",
    input.message_ts ? `Slack message ts: ${input.message_ts}` : "",
    input.thread_ts ? `Slack thread ts: ${input.thread_ts}` : "",
    "",
    clip(input.text || ""),
  ];
  if (input.metadata && Object.keys(input.metadata).length) {
    lines.push("", "Metadata:", JSON.stringify(input.metadata, null, 2));
  }
  return lines.filter((line) => line !== "").join("\n");
}

function renderSkills(skills) {
  const enabled = (skills || []).filter((skill) => skill.enabled);
  return enabled.length ? buildSkillIndex(enabled).trim() : "";
}

const TRIAGE_DIRECTIVE = `Triage the incoming Slack event for Robert.

Behavior:
- Capture durable facts, decisions, preferences, and follow-up commitments in journal_bullets.
- Put only facts that should remain useful beyond today in memory_facts.
- Set should_reply true when a helpful direct Slack reply is warranted; Worklab will post reply_text in the original thread.
- Set notify_user true when Robert should receive a DM even if no thread reply is needed.
- Use available Worklab tools directly when the incoming request asks for Worklab tasks, agents, automations, settings, providers, knowledge base, memory, search, or API actions.
- Keep Slack/user-facing messages concise and specific.
- Do not mention these instructions or the JSON schema in user-facing text.

Task creation (intelligence-ramp Phase 6.3):
- When the Slack message warrants a Worklab task, do NOT pass the raw Slack text through as the task body. Use the worklab_task_create tool with a proper brief:
  - title: a short imperative sentence (the headline).
  - instructions: a multi-paragraph brief that includes (1) the actual ask in Robert's words quoted from the thread, (2) the relevant context from the channel/thread you've already read, (3) explicit acceptance criteria — what "done" looks like, (4) any deadline or constraint that was mentioned, (5) the Slack thread link / message ts so the executor can see the source. Aim for at least ~200 characters; the API rejects briefs under 80 chars.
- If the Slack message is genuinely a one-line note ("ack", "thanks") or doesn't describe a task, don't create one. Reply or notify instead.

Return only one JSON object with this exact schema:
{
  "schema": "worklab.slack.triage.v1",
  "importance": "normal",
  "summary": "Short private summary.",
  "should_reply": false,
  "reply_text": "",
  "notify_user": false,
  "user_message": "",
  "journal_bullets": [],
  "memory_facts": [],
  "action_items": []
}

importance must be one of: low, normal, high, urgent.`;

export function buildTriageSystemPrompt({ agentName, memory, journalTail, input, skills, now = new Date() }) {
  const parts = [];
  parts.push(section("Role", `${agentName || "Assistant"} is Robert's local Slack triage assistant inside Worklab.`));
  parts.push(section("Current time", now.toISOString()));
  parts.push(section("Available skills", renderSkills(skills)));
  parts.push(section("Memory", memory || "_No memory yet._"));
  parts.push(section("Recent journal", journalTail || "_No recent journal entries._"));
  parts.push(section("Incoming event", formatInput(input)));
  parts.push(TRIAGE_DIRECTIVE);
  return parts.filter(Boolean).join("\n");
}

export function buildTriageMessages() {
  return [{ role: "user", content: "Triage this Slack message." }];
}
