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
  serializeMention,
} from "../../core/index.js";

export function withMentions({ db, dataDir }, payload, textSources) {
  const tokens = new Set();
  const entityLinks = new Map();
  walk(textSources, tokens, entityLinks);
  if (tokens.size === 0 && entityLinks.size === 0) {
    return { ...payload, mentions: {} };
  }
  const linkTokens = [...new Set([...entityLinks.values()].map((entry) => entry.token))];
  const resolved = resolveMentions(db, [...tokens, ...linkTokens], { dataDir });
  const mentions = resolvedMentionsToObject(resolved);
  for (const [href, entry] of entityLinks) {
    const meta = resolved.get(entry.token);
    if (!meta) continue;
    mentions[href] = { ...meta, href };
  }
  return { ...payload, mentions };
}

function walk(value, tokens, entityLinks) {
  if (value == null) return;
  if (typeof value === "string") {
    if (value.includes("@")) {
      for (const m of parseMentions(value)) tokens.add(m.token);
    }
    for (const link of parseEntityLinks(value)) {
      if (!entityLinks.has(link.href)) entityLinks.set(link.href, link);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) walk(child, tokens, entityLinks);
    return;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) walk(child, tokens, entityLinks);
  }
}

function parseEntityLinks(text) {
  const out = [];
  if (typeof text !== "string" || !text.includes("](")) return out;
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const link = entityLinkFromHref(match[1]);
    if (link) out.push(link);
  }
  return out;
}

function entityLinkFromHref(href) {
  const safe = normalizeHref(href);
  if (!safe) return null;
  const raw = safe.replace(/^#\/?/, "").replace(/&amp;/g, "&");
  const queryIndex = raw.indexOf("?");
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const queryString = queryIndex === -1 ? "" : raw.slice(queryIndex + 1);
  const segments = pathPart.split("/").filter(Boolean).map(safeDecode);
  const query = new URLSearchParams(queryString);

  if (segments[0] === "library" && segments[2]) {
    if (segments[1] === "agents") return linkRef(safe, "agent", segments[2]);
    if (segments[1] === "knowledge") return linkRef(safe, "kb", segments[2]);
    if (segments[1] === "skills") return linkRef(safe, "skill", segments[2]);
    if (segments[1] === "teams") return linkRef(safe, "team", segments[2]);
  }
  if (segments[0] === "projects" && segments[1]) return linkRef(safe, "project", segments[1]);
  if (segments[0] === "goals" && segments[1]) return linkRef(safe, "goal", segments[1]);
  if (segments[0] === "tasks" && segments[1]) {
    const runId = query.get("run");
    return runId ? linkRef(safe, "run", runId) : linkRef(safe, "task", segments[1]);
  }
  return null;
}

function normalizeHref(href) {
  const trimmed = String(href || "").trim();
  if (trimmed.startsWith("#/")) return trimmed;
  if (trimmed.startsWith("/#/")) return trimmed.slice(1);
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function linkRef(href, type, id) {
  return { href, token: serializeMention({ type, id }) };
}
