// Attaches a resolved-mentions sidecar to API responses that carry
// text-bearing fields. The renderer in the UI uses this to swap
// mention tokens for badges in a single render pass — no extra
// round-trip required.
//
// Usage:
//   const payload = withMentions({ db, dataDir }, { task }, [
//     task.title,
//     task.instructions,
//   ]);
//
// `payload.mentions` is an object keyed by token; values include the
// display label, sublabel, hash href, and an `exists` flag for
// dangling references.

import {
  parseMentions,
  resolveMentions,
  resolvedMentionsToObject,
} from "../../core/index.js";

export function withMentions({ db, dataDir }, payload, textSources) {
  const tokens = collectTokens(textSources);
  if (tokens.length === 0) {
    return { ...payload, mentions: {} };
  }
  const resolved = resolveMentions(db, tokens, { dataDir });
  return { ...payload, mentions: resolvedMentionsToObject(resolved) };
}

function collectTokens(sources) {
  const tokens = new Set();
  walk(sources, tokens);
  return Array.from(tokens);
}

function walk(value, tokens) {
  if (value == null) return;
  if (typeof value === "string") {
    if (!value.includes("@")) return;
    for (const m of parseMentions(value)) tokens.add(m.token);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) walk(child, tokens);
    return;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) walk(child, tokens);
  }
}
