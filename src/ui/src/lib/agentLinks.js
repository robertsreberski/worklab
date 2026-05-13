import { humanizeSlug } from "./display.js";
import { parseMentions } from "./mentions.js";

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

export function splitAgentReferences(text, agents = []) {
  const raw = String(text ?? "");
  if (!raw) return [];
  const byName = new Map((agents || [])
    .filter((agent) => agent?.name)
    .map((agent) => [agent.name, {
      type: "agent",
      name: agent.name,
      label: agentLabel(agent, agent.name),
      href: agentHref(agent.name),
    }]));
  if (byName.size === 0) return [raw];
  const parts = [];
  let lastIndex = 0;
  for (const match of parseMentions(raw)) {
    if (match.type !== "agent") continue;
    const entry = byName.get(match.id);
    if (!entry) continue;
    const start = match.start;
    if (start > lastIndex) parts.push(raw.slice(lastIndex, start));
    parts.push(entry);
    lastIndex = match.end;
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
