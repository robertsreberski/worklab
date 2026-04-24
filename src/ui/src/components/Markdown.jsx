// §4.17 Markdown — GFM-lite, sanitized, clamps by rendered height (not char count).
// Full Markdown always renders; long bodies clamp to 320px with "Show more".

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export function renderMarkdown(md) {
  if (!md) return "";

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
      out.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && /^\|?\s*[-:]+/.test(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i += 1;
      }
      out.push(renderTable(tableLines));
      continue;
    }

    if (/^\s*[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        const stripped = lines[i].replace(/^\s*[-*]\s+/, "");
        items.push(`<li>${renderInline(stripped)}</li>`);
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
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`);
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
      out.push(`<p>${renderInline(paragraphLines.join("\n"))}</p>`);
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
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
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

function renderInline(text) {
  return escapeHtml(text)
    .replace(/\n/g, "<br/>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
}

function renderTable(lines) {
  const parseRow = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const headers = parseRow(lines[0]);
  const rows = lines.slice(2).map(parseRow);
  return [
    '<div class="doc-table-wrap"><table class="doc-table">',
    `<thead><tr>${headers.map((header) => `<th>${renderInline(header)}</th>`).join("")}</tr></thead>`,
    `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table></div>",
  ].join("");
}
