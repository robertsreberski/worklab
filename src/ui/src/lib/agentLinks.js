import { humanizeSlug } from "./display.js";

const AGENT_BOUNDARY = "[^A-Za-z0-9_-]";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownEscape(value) {
  return String(value).replace(/([\\[\]()])/g, "\\$1");
}

export function agentHref(name) {
  return `#/library/agents/${encodeURIComponent(String(name || ""))}`;
}

export function agentLabel(agent, fallbackName = "") {
  if (!agent && !fallbackName) return "";
  const name = agent?.name || fallbackName;
  return agent?.display_name || agent?.displayName || humanizeSlug(name) || name;
}

export function agentByName(agents = [], name) {
  if (!name) return null;
  return (agents || []).find((agent) => agent?.name === name) || null;
}

export function agentReferenceMentions(agents = []) {
  const mentions = {};
  for (const agent of agents || []) {
    if (!agent?.name) continue;
    const href = agentHref(agent.name);
    const label = agentLabel(agent, agent.name);
    const mention = {
      token: `@agent/${agent.name}`,
      type: "agent",
      id: agent.name,
      label,
      sublabel: "agent",
      href,
      exists: true,
    };
    mentions[mention.token] = mention;
    mentions[href] = mention;
  }
  return mentions;
}

export function mergeAgentReferenceMentions(mentions = null, agents = []) {
  const generated = agentReferenceMentions(agents);
  if (!mentions && Object.keys(generated).length === 0) return null;
  return {
    ...generated,
    ...(mentions || {}),
  };
}

function referenceEntries(agents = []) {
  const out = [];
  for (const agent of agents || []) {
    if (!agent?.name) continue;
    const entry = {
      type: "agent",
      name: agent.name,
      label: agentLabel(agent, agent.name),
      href: agentHref(agent.name),
    };
    for (const token of new Set([entry.name, entry.label].filter(Boolean))) {
      out.push({ ...entry, token });
    }
  }
  return out.sort((a, b) => b.token.length - a.token.length);
}

export function splitAgentReferences(text, agents = []) {
  const raw = String(text ?? "");
  const entries = referenceEntries(agents);
  if (!raw || entries.length === 0) return raw ? [raw] : [];
  const byToken = new Map(entries.map((entry) => [entry.token, entry]));
  const tokens = entries.map((entry) => escapeRegExp(entry.token)).join("|");
  const re = new RegExp(`(^|${AGENT_BOUNDARY})(${tokens})(?=$|${AGENT_BOUNDARY})`, "g");
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = re.exec(raw))) {
    const prefix = match[1] || "";
    const token = match[2];
    const start = match.index + prefix.length;
    if (start > lastIndex) parts.push(raw.slice(lastIndex, start));
    const { token: _token, ...entry } = byToken.get(token);
    parts.push(entry);
    lastIndex = start + token.length;
  }
  if (lastIndex < raw.length) parts.push(raw.slice(lastIndex));
  return parts.filter((part) => part !== "");
}

export function linkAgentReferencesInMarkdown(text, agents = []) {
  return splitAgentReferences(text, agents)
    .map((part) => {
      if (typeof part === "string") return part;
      return `[${markdownEscape(part.label)}](${part.href})`;
    })
    .join("");
}
