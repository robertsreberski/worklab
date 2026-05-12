// §4.17 Markdown — GFM-lite, sanitized, clamps by rendered height (not char count).
// Full Markdown always renders; long bodies clamp to 320px with "Show more".
//
// Cross-entity mentions: pass `{ mentions: { token: ResolvedMention } }` to
// renderMarkdown / MarkdownContent and `@agent/...`-style tokens swap for
// clickable badges via the same hash routes as the rest of the app. Markdown
// links to Worklab entity routes render with the same badge treatment.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { iconSvgMarkup } from "./Icon.jsx";
import { entityBadgeLabel, entityBadgeMeta, normalizeEntityBadgeKind } from "../lib/entityBadges.js";
import { MENTION_TOKEN_RE } from "../lib/mentions.js";

export function renderMarkdown(md, options = {}) {
  if (!md) return "";
  const ctx = { mentions: options.mentions || null };

  const codeBlocks = [];
  const text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, __, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(`<pre class="doc-code"><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODE${index}\x00`;
  });

  const lines = text.split("\n");
  const out = [];

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const codeMatch = line.match(/^\x00CODE(\d+)\x00$/);
    if (codeMatch) {
      out.push(codeBlocks[Number(codeMatch[1])]);
      i += 1;
      continue;
    }

    if (line.trim() === "") { i += 1; continue; }

    if (/^---+$/.test(line.trim())) {
      out.push("<hr/>");
      i += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${renderInline(headingMatch[2], ctx)}</h${level}>`);
      i += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quoteLines.join("\n"), ctx)}</blockquote>`);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && /^\|?\s*[-:]+/.test(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(tableLines, ctx));
      continue;
    }

    if (/^\s*[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        const stripped = lines[i].replace(/^\s*[-*]\s+/, "");
        items.push(`<li>${renderInline(stripped, ctx)}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item, ctx)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraphLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,3}\s|^\s*[-*]\s|^\s*\d+\.\s|^>|^---+$|^\x00CODE/.test(lines[i]) &&
      !lines[i].includes("|")
    ) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    if (paragraphLines.length === 0 && i < lines.length && lines[i].trim() !== "") {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    if (paragraphLines.length > 0) {
      out.push(`<p>${renderInline(paragraphLines.join("\n"), ctx)}</p>`);
    }
  }

  return out.join("");
}

// MarkdownContent: renders with a rendered-height clamp (320px) and a
// "Show more" expander. Replaces the character-length fallback entirely.
export function MarkdownContent({
  content = "",
  className = "markdown doc-content",
  maxHeight = 320,
  expandable = true,
  mentions = null,
}) {
  const ref = useRef(null);
  const [needsClamp, setNeedsClamp] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    if (!expandable) return;
    if (!ref.current) return;
    const el = ref.current;
    // measure natural height
    el.style.maxHeight = "none";
    const h = el.scrollHeight;
    setNeedsClamp(h > maxHeight);
  }, [content, expandable, maxHeight]);

  useEffect(() => {
    if (!ref.current) return;
    if (!expandable) return;
    ref.current.style.maxHeight = expanded || !needsClamp ? "none" : `${maxHeight}px`;
  }, [expanded, needsClamp, expandable, maxHeight]);

  return (
    <>
      <div
        ref={ref}
        class={`${className}${needsClamp && !expanded ? " markdown-expandable clamped" : ""}`}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content, { mentions }) }}
      />
      {expandable && needsClamp && (
        <button
          type="button"
          class="markdown-show-more"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHref(url) {
  const trimmed = String(url || "").trim();
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
  return "#";
}

function renderAnchor(href, label, ctx = {}) {
  const safe = safeHref(href);
  const entity = entityLinkFromHref(safe, ctx);
  if (entity) return renderEntityBadge(entity);
  const externalAttrs = /^(https?:|mailto:|tel:)/i.test(safe)
    ? ' target="_blank" rel="noopener noreferrer"'
    : "";
  return `<a href="${safe}"${externalAttrs}>${label}</a>`;
}

function entityLinkFromHref(href, ctx = {}) {
  const safe = String(href || "").trim();
  const routeHref = safe.startsWith("#/")
    ? safe
    : safe.startsWith("/#/")
      ? safe.slice(1)
      : null;
  if (!routeHref) return null;

  const raw = routeHref.replace(/^#\/?/, "").replace(/&amp;/g, "&");
  const queryIndex = raw.indexOf("?");
  const pathPart = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const queryString = queryIndex === -1 ? "" : raw.slice(queryIndex + 1);
  const segments = pathPart.split("/").filter(Boolean).map(safeDecode);
  const query = new URLSearchParams(queryString);
  const mentions = ctx?.mentions || null;

  if (segments[0] === "library" && segments[2]) {
    if (segments[1] === "agents") return entityLink("agent", segments[2], safe, mentions);
    if (segments[1] === "knowledge") return entityLink("kb", segments[2], safe, mentions);
    if (segments[1] === "skills") return entityLink("skill", segments[2], safe, mentions);
    if (segments[1] === "teams") return entityLink("team", segments[2], safe, mentions);
  }
  if (segments[0] === "projects" && segments[1]) return entityLink("project", segments[1], safe, mentions);
  if (segments[0] === "goals" && segments[1]) return entityLink("goal", segments[1], safe, mentions);
  if (segments[0] === "tasks" && segments[1]) {
    const runId = query.get("run");
    if (runId) return entityLink("run", runId, safe, mentions);
    return entityLink("task", segments[1], safe, mentions);
  }
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function entityLink(type, id, href, mentions) {
  const normalizedType = normalizeEntityBadgeKind(type);
  const meta = mentions?.[href] || mentions?.[href.replace(/&amp;/g, "&")] || null;
  const display = meta?.label || humanizeEntityId(id);
  return {
    type: normalizedType,
    id,
    href,
    labelHtml: escapeHtml(display),
    title: [entityBadgeMeta(normalizedType).label, id].filter(Boolean).join(": "),
  };
}

function humanizeEntityId(value) {
  return entityBadgeLabel({ id: String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) });
}

function renderInline(text, ctx = {}) {
  const placeholders = [];
  const stash = (html) => {
    const index = placeholders.length;
    placeholders.push(html);
    return `\x00INLINE${index}\x00`;
  };

  // Stash mentions BEFORE escapeHtml so the `@` and `/` survive
  // intact; the placeholder protects them from later passes.
  const withMentions = linkifyMentions(text, ctx?.mentions || null, stash);

  const rendered = linkifyBareUrls(
    escapeHtml(withMentions)
      .replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`))
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
        stash(renderAnchor(url, label, ctx))),
    stash,
  ).replace(/\n/g, "<br/>");

  return restoreInlinePlaceholders(rendered, placeholders);
}

function linkifyMentions(text, mentions, stash) {
  if (typeof text !== "string" || !text.length) return text;
  const re = new RegExp(MENTION_TOKEN_RE.source, "g");
  let last = 0;
  let out = "";
  let match;
  while ((match = re.exec(text)) !== null) {
    out += text.slice(last, match.index);
    out += stash(renderMentionBadge(match[0], match[1], match[2], mentions));
    last = match.index + match[0].length;
  }
  out += text.slice(last);
  return out;
}

function renderMentionBadge(token, type, id, mentions) {
  // When no resolved-mentions map is provided (legacy callers, optimistic
  // local rendering before an API response), render a best-effort badge
  // showing the bare id. When a map IS provided but this token is absent
  // or marked exists=false, the entity has been deleted — render muted.
  const hasMap = mentions != null;
  const meta = hasMap ? mentions[token] : null;
  const isMissing = hasMap && (!meta || meta.exists === false);
  const normalizedType = normalizeEntityBadgeKind(type);
  const label = entityBadgeLabel({ label: meta?.label, token: meta?.label ? null : token, type: normalizedType, id });
  const cls = `badge-token badge-token-sm entity-badge entity-badge--${normalizedType}${isMissing ? " entity-badge--missing" : ""}`;
  const body = renderEntityBadgeBody(normalizedType, escapeHtml(label));
  if (isMissing || !meta?.href) {
    const tooltip = isMissing ? "Mention target no longer exists" : token;
    return `<span class="${cls}" data-kind="${escapeHtml(normalizedType)}" title="${escapeHtml(tooltip)}">${body}</span>`;
  }
  const safe = safeHref(meta.href);
  return `<a class="${cls}" data-kind="${escapeHtml(normalizedType)}" href="${safe}" title="${escapeHtml(token)}">${body}</a>`;
}

function renderEntityBadge({ type, href, labelHtml, title }) {
  const normalizedType = normalizeEntityBadgeKind(type);
  const cls = `badge-token badge-token-sm entity-badge entity-badge--${normalizedType}`;
  const body = renderEntityBadgeBody(normalizedType, labelHtml);
  return `<a class="${cls}" data-kind="${escapeHtml(normalizedType)}" href="${href}" title="${escapeHtml(title || "")}">${body}</a>`;
}

function renderEntityBadgeBody(type, labelHtml) {
  const badgeMeta = entityBadgeMeta(type);
  const icon = badgeMeta.icon ? iconSvgMarkup(badgeMeta.icon, { size: 12, className: "badge-token-icon" }) : "";
  const leading = icon ? `<span class="badge-token-leading" aria-hidden="true">${icon}</span>` : "";
  const glyph = !leading && badgeMeta.glyph
    ? `<span class="badge-token-glyph" aria-hidden="true">${escapeHtml(badgeMeta.glyph)}</span>`
    : "";
  return `${leading || glyph}<span class="badge-token-label">${labelHtml}</span>`;
}

function restoreInlinePlaceholders(value, placeholders) {
  let rendered = value;
  for (let i = 0; i < placeholders.length; i += 1) {
    rendered = rendered.replace(/\x00INLINE(\d+)\x00/g, (_, index) => placeholders[Number(index)] || "");
  }
  return rendered;
}

function linkifyBareUrls(html, stash) {
  return html
    .split(/(<[^>]+>|\x00INLINE\d+\x00)/g)
    .map((part) => {
      if (!part || /^<[^>]+>$/.test(part) || /^\x00INLINE\d+\x00$/.test(part)) return part;
      return linkifyText(part, stash);
    })
    .join("");
}

function linkifyText(text, stash) {
  return text.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)/gi, (match, prefix, rawUrl) => {
    const { url, suffix } = splitTrailingUrlSuffix(rawUrl);
    if (!url) return match;
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    return `${prefix}${stash(renderAnchor(href, url))}${suffix}`;
  });
}

function splitTrailingUrlSuffix(rawUrl) {
  let url = rawUrl;
  let suffix = "";

  while (/[.,!?;:]$/.test(url)) {
    suffix = `${url.slice(-1)}${suffix}`;
    url = url.slice(0, -1);
  }

  while (url.endsWith(")") && countChar(url, ")") > countChar(url, "(")) {
    suffix = `)${suffix}`;
    url = url.slice(0, -1);
  }

  while (url.endsWith("]") && countChar(url, "]") > countChar(url, "[")) {
    suffix = `]${suffix}`;
    url = url.slice(0, -1);
  }

  return { url, suffix };
}

function countChar(value, char) {
  return [...value].filter((entry) => entry === char).length;
}

function renderTable(lines, ctx) {
  const parseRow = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const headers = parseRow(lines[0]);
  const rows = lines.slice(2).map(parseRow);
  return [
    '<div class="doc-table-wrap"><table class="doc-table">',
    `<thead><tr>${headers.map((header) => `<th>${renderInline(header, ctx)}</th>`).join("")}</tr></thead>`,
    `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, ctx)}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table></div>",
  ].join("");
}
