const VERDICT_RE = /^VERDICT:\s*(APPROVE|REJECT)\b/;

function formatWorklabResult(result) {
  const value = result?.worklab_result || result;
  if (!value || value.schema !== "worklab.v2") return "";
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  const details = typeof value.details === "string" ? value.details.trim() : "";
  if (summary && details && summary !== details) return `${summary}\n\n${details}`;
  return details || summary;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonObjectStrings(text) {
  const raw = String(text || "");
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function parseWorklabJson(text) {
  const direct = formatWorklabResult(parseJson(text));
  if (direct) return direct;
  const candidates = extractJsonObjectStrings(text);
  let remainder = String(text || "").trim();
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const formatted = formatWorklabResult(parseJson(candidates[i]));
    if (formatted) {
      for (const candidate of candidates) remainder = remainder.replace(candidate, "");
      return remainder.trim() ? "" : formatted;
    }
  }
  return "";
}

function formatErrorJson(body) {
  const match = /^ERROR:\s*({[\s\S]*})\s*$/.exec(String(body || "").trim());
  if (!match) return body;
  const parsed = parseJson(match[1]);
  const error = parsed?.error || parsed;
  const code = error?.code;
  const message = error?.message;
  const param = error?.param;
  if (code === "invalid_json_schema" || /Invalid schema/i.test(message || "")) {
    return `ERROR: Invalid response schema${param ? ` (${param})` : ""}: ${message || "schema rejected"}`;
  }
  return body;
}

export function collapseDuplicateParagraphs(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const paragraphs = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return raw;
  const seen = new Set();
  return paragraphs.filter((paragraph) => {
    const key = paragraph.replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n\n");
}

export function stripWorklabJson(body) {
  const raw = String(body || "").trim();
  if (!raw) return "";
  const fencedOnly = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fencedOnly) {
    const fenced = parseWorklabJson(fencedOnly[1]);
    if (fenced) return fenced;
  }
  const whole = parseWorklabJson(raw);
  if (whole) return whole;
  return raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (match, json) => {
    return parseWorklabJson(json) ? "" : match;
  }).trim();
}

export function parseVerdictComment(body, authorType) {
  if ((authorType || "").toLowerCase() !== "system") return { verdict: null, body };
  const match = VERDICT_RE.exec(body || "");
  if (!match) return { verdict: null, body };
  const verdict = match[1];
  const rest = body.slice(match[0].length).trimStart();
  return { verdict, body: rest };
}

export function normalizeCommentBody(body) {
  return collapseDuplicateParagraphs(stripWorklabJson(formatErrorJson(body)))
    .replace(/([a-z0-9])\.([A-Z])/g, "$1. $2");
}

export function normalizeCommentText(body) {
  const text = collapseDuplicateParagraphs(String(body || "").trim());
  if (!text) return "";
  if (/^ERROR:\s*{[\s\S]*}\s*$/.test(text)) {
    return text;
  }
  const stripped = collapseDuplicateParagraphs(stripWorklabJson(text));
  if (stripped !== text) {
    return stripped.replace(/([a-z0-9])\.([A-Z])/g, "$1. $2");
  }
  if (parseJson(text) || /```(?:json)?\s*[\s\S]*?```/i.test(text)) return text;
  return stripped.replace(/([a-z0-9])\.([A-Z])/g, "$1. $2");
}

export function shouldHideComment(comment) {
  const authorType = comment?.author_type || comment?.authorType;
  if ((authorType || "").toLowerCase() !== "system") return false;
  return /^VERDICT:\s*APPROVE\b/.test(String(comment?.body || ""));
}
