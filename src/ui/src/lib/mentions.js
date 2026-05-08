// Cross-entity @-mention helpers for the UI. Mirrors the token format
// defined by `src/core/mentions/tokens.js` so the renderer and picker
// stay in sync. The UI cannot reach into core, so the regex lives here
// as a small duplicate; if it ever drifts, the test in
// `src/__tests__/ui/mentions-token.test.js` will catch it.

export const MENTION_TYPES = ["agent", "task", "project", "team", "kb"];

export const MENTION_TOKEN_RE = /(?<![\w@])@(agent|task|project|team|kb)\/([A-Za-z0-9_-]+)/g;

const MENTION_TOKEN_FULL_RE = /^@(agent|task|project|team|kb)\/([A-Za-z0-9_-]+)$/;

export function parseMentionToken(token) {
  if (typeof token !== "string") return null;
  const match = MENTION_TOKEN_FULL_RE.exec(token);
  if (!match) return null;
  return { token, type: match[1], id: match[2] };
}

export function parseMentions(text) {
  const out = [];
  if (typeof text !== "string" || text.length === 0) return out;
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

// Detects an in-progress @-mention at the caret. Returns the trigger
// span that should drive the picker, or null when the caret is not
// inside a fresh `@type/...` token. The trigger has fields:
//
//   start: index of the leading `@`
//   end:   index of the caret (exclusive)
//   query: text typed after the `@` (may include the type prefix and `/`)
//
// Examples:
//   "hello @tri|"           → { start: 6, end: 10, query: "tri" }
//   "hello @agent/tri|ag"   → caret in middle: still returns trigger
//   "hello @agent/triager " → null (whitespace closes the trigger)
//   "foo@bar"               → null (preceded by a word char)
export function findMentionTrigger(text, caret) {
  if (typeof text !== "string" || typeof caret !== "number") return null;
  if (caret < 0 || caret > text.length) return null;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      const before = i > 0 ? text[i - 1] : "";
      if (before && /[\w@]/.test(before)) return null;
      const query = text.slice(i + 1, caret);
      return { start: i, end: caret, query };
    }
    if (/\s/.test(ch) || ch === "@") return null;
  }
  return null;
}
