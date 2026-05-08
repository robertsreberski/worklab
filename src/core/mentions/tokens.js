// Cross-entity @-mention tokens. Stored verbatim in user prose
// (e.g. `@agent/triager`, `@task/T-42`, `@project/p-mobile`,
// `@team/t-7`, `@kb/auth-flow`); the renderer swaps each token
// for a clickable badge and the LLM-expansion path replaces it
// with a readable, round-trippable form before the text is sent
// to a model. See src/core/mentions/{resolver,expand}.js.
//
// Pure module: no DB, no I/O.

export const MENTION_TYPES = ["agent", "task", "project", "team", "kb"];

// Lookbehind blocks matches inside emails or paths (`foo@agent/x`)
// and prevents `@@` from being parsed. The id charset covers slugs,
// task keys (`T-42`), uuids, and the lowercase + hyphen format used
// by agents.
export const MENTION_TOKEN_RE = /(?<![\w@])@(agent|task|project|team|kb)\/([A-Za-z0-9_-]+)/g;

const MENTION_TOKEN_FULL_RE = /^@(agent|task|project|team|kb)\/([A-Za-z0-9_-]+)$/;

export function parseMentions(text) {
  const out = [];
  if (typeof text !== "string" || text.length === 0) return out;
  // Construct a fresh regex per-call so `lastIndex` mutations from
  // concurrent users of `MENTION_TOKEN_RE` cannot interfere.
  const re = new RegExp(MENTION_TOKEN_RE.source, "g");
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push({
      token: match[0],
      type: match[1],
      id: match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

export function uniqueMentionTokens(text) {
  const seen = new Set();
  for (const m of parseMentions(text)) seen.add(m.token);
  return Array.from(seen);
}

export function serializeMention({ type, id }) {
  if (!MENTION_TYPES.includes(type)) {
    throw new Error(`unknown mention type: ${type}`);
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("mention id must be a non-empty string");
  }
  return `@${type}/${id}`;
}

export function parseMentionToken(token) {
  if (typeof token !== "string") return null;
  const match = MENTION_TOKEN_FULL_RE.exec(token);
  if (!match) return null;
  return { token, type: match[1], id: match[2] };
}
