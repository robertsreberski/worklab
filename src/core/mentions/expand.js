// Replaces mention tokens in stored text with a readable form before
// the text is handed to an LLM. Format: `Display Name (type, @type/id)`.
// The canonical token is preserved in parens so models that quote text
// back into a reply still produce something the renderer can re-link.
//
// Unknown / deleted tokens are left intact so the dangling reference
// is still visible to the model.

import { parseMentions } from "./tokens.js";
import { resolveMentions } from "./resolver.js";

function expandedReplacement(resolved) {
  if (!resolved || !resolved.exists) return null;
  return `${resolved.label} (${resolved.type}, ${resolved.token})`;
}

export function expandMentionsForLlm(db, text, { dataDir = null } = {}) {
  if (typeof text !== "string" || text.length === 0) return text;
  const matches = parseMentions(text);
  if (matches.length === 0) return text;
  const resolvedMap = resolveMentions(db, matches.map((m) => m.token), { dataDir });
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start);
    const replacement = expandedReplacement(resolvedMap.get(m.token));
    out += replacement ?? m.token;
    cursor = m.end;
  }
  out += text.slice(cursor);
  return out;
}

export function expandMentionsInRecord(db, record, fields, { dataDir = null } = {}) {
  if (!record || typeof record !== "object") return record;
  const next = { ...record };
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) {
      next[field] = expandMentionsForLlm(db, value, { dataDir });
    }
  }
  return next;
}
