function tokenBounds(text, caret) {
  if (typeof text !== "string" || typeof caret !== "number") return null;
  if (caret < 0 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return { start, end, token: text.slice(start, caret) };
}

function isUrlToken(token) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(token);
}

function isPathToken(token) {
  if (!token || token.startsWith("@") || isUrlToken(token)) return false;
  return token.startsWith("/")
    || token.startsWith("~/")
    || token.startsWith("./")
    || token.startsWith("../")
    || token.includes("/");
}

export function findPathTrigger(text, caret) {
  const bounds = tokenBounds(text, caret);
  if (!bounds || !isPathToken(bounds.token)) return null;
  return {
    start: bounds.start,
    end: caret,
    prefix: bounds.token,
  };
}

export function insertPathSuggestion(text, trigger, suggestion, options = {}) {
  if (!trigger || !suggestion?.path) return { value: text, caret: trigger?.end ?? 0 };
  const insertion = options.preferAbsolute && suggestion.absolute_path
    ? suggestion.absolute_path
    : suggestion.path;
  const next = `${text.slice(0, trigger.start)}${insertion}${text.slice(trigger.end)}`;
  const caret = trigger.start + insertion.length;
  return { value: next, caret };
}
