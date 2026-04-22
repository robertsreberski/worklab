import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Stable order for frontmatter keys.
const FRONTMATTER_ORDER = [
  "title",
  "slug",
  "tags",
  "category",
  "pinned",
  "author",
  "created_at",
  "updated_at",
];

function assertValidSlug(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
  }
}

function isoTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function knowledgeDir(dataDir) {
  return join(dataDir, "knowledge");
}

export function kbPath(dataDir, slug) {
  return join(knowledgeDir(dataDir), `${slug}.md`);
}

// --- Frontmatter parsing ----------------------------------------------------

function coerceScalar(raw) {
  if (raw === "" || raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseFlowArray(raw) {
  // raw is like "[a, b, c]" or "[a, \"b,c\", d]"
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  // Split on commas, respecting simple quoted strings.
  const parts = [];
  let cur = "";
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts.map((p) => {
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      return p.slice(1, -1);
    }
    return p;
  });
}

/**
 * Parse KB frontmatter. Supports:
 *   key: value
 *   key: [a, b, c]                (flow array)
 *   key:
 *     - a                         (block array; indented items)
 *     - b
 * Returns { meta, body }. If no frontmatter present, returns { meta: {}, body: content }.
 */
function parseFrontmatter(content) {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return { meta: {}, body: content };
  const [, yaml, body] = m;
  const meta = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      i++;
      continue;
    }
    // Only top-level keys (no leading whitespace). Indented lines are
    // consumed as block-array items below.
    if (/^\s/.test(line)) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();

    if (raw === "") {
      // Possible block-array or empty scalar. Look ahead.
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const peek = lines[j];
        const trimmed = peek.trim();
        if (trimmed === "" || trimmed.startsWith("#")) {
          j++;
          continue;
        }
        // Block-array item: must be indented and start with "- "
        if (/^\s+-\s+/.test(peek)) {
          const item = trimmed.replace(/^-\s+/, "");
          items.push(coerceScalar(item));
          j++;
          continue;
        }
        break;
      }
      if (items.length > 0) {
        meta[key] = items;
        i = j;
        continue;
      }
      // Otherwise treat as null scalar.
      meta[key] = null;
      i++;
      continue;
    }

    if (raw.startsWith("[") && raw.endsWith("]")) {
      meta[key] = parseFlowArray(raw);
      i++;
      continue;
    }

    meta[key] = coerceScalar(raw);
    i++;
  }
  return { meta, body };
}

// --- Frontmatter rendering --------------------------------------------------

function renderValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((v) => String(v)).join(", ")}]`;
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  // string
  return String(value);
}

function renderFrontmatter(meta) {
  const lines = ["---"];
  for (const key of FRONTMATTER_ORDER) {
    if (!(key in meta)) continue;
    const v = meta[key];
    if (v === null || v === undefined) continue; // omit when null
    lines.push(`${key}: ${renderValue(v)}`);
  }
  // Include any extra keys not in the canonical order (preserves unknown
  // keys on update round-trips).
  for (const [key, v] of Object.entries(meta)) {
    if (FRONTMATTER_ORDER.includes(key)) continue;
    if (v === null || v === undefined) continue;
    lines.push(`${key}: ${renderValue(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function composeFile(meta, body) {
  const fm = renderFrontmatter(meta);
  // Ensure exactly one blank line between frontmatter and body, and a
  // trailing newline.
  const trimmedBody = body.replace(/^\s*\n/, "");
  return `${fm}\n\n${trimmedBody.replace(/\n*$/, "\n")}`;
}

// --- Atomic write -----------------------------------------------------------

function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function ensureKnowledgeDir(dataDir) {
  const kd = knowledgeDir(dataDir);
  if (!existsSync(kd)) mkdirSync(kd, { recursive: true });
  return kd;
}

// --- List entry normalization ----------------------------------------------

function normalizeMetaForList(meta) {
  return {
    slug: meta.slug ?? null,
    title: meta.title ?? null,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    category: meta.category ?? null,
    pinned: meta.pinned === true,
    author: meta.author ?? null,
    created_at: meta.created_at ?? null,
    updated_at: meta.updated_at ?? null,
  };
}

// Read only the frontmatter block — avoids loading potentially huge bodies.
function readFrontmatterOnly(filePath) {
  const raw = readFileSync(filePath, "utf8");
  // Find first `---` line and the next `---` line.
  if (!raw.startsWith("---")) return { meta: {} };
  const firstNl = raw.indexOf("\n");
  if (firstNl < 0) return { meta: {} };
  const rest = raw.slice(firstNl + 1);
  const endIdx = rest.indexOf("\n---");
  if (endIdx < 0) return { meta: {} };
  const yamlBlock = rest.slice(0, endIdx);
  // Re-wrap with --- markers so parseFrontmatter can consume uniformly.
  const wrapped = `---\n${yamlBlock}\n---\n`;
  return parseFrontmatter(wrapped);
}

// --- Public API -------------------------------------------------------------

export function kbRead({ dataDir, slug }) {
  assertValidSlug(slug);
  const path = kbPath(dataDir, slug);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  const normalized = {
    ...meta,
    slug: meta.slug ?? slug,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    category: meta.category ?? null,
    pinned: meta.pinned === true,
  };
  return { meta: normalized, body };
}

export function kbCreate({
  dataDir,
  slug,
  title,
  body,
  tags = [],
  category = null,
  pinned = false,
  author,
  now = new Date(),
}) {
  assertValidSlug(slug);
  ensureKnowledgeDir(dataDir);
  const path = kbPath(dataDir, slug);
  if (existsSync(path)) {
    throw new Error(`kb entry already exists: ${slug}`);
  }
  const ts = isoTimestamp(now);
  const meta = {
    title,
    slug,
    tags: Array.isArray(tags) ? tags : [],
    category: category === undefined ? null : category,
    pinned: pinned === true,
    author: author ?? null,
    created_at: ts,
    updated_at: ts,
  };
  const content = composeFile(meta, body ?? "");
  writeAtomic(path, content);
  return { meta, body: body ?? "" };
}

export function kbUpdate({ dataDir, slug, patch = {}, now = new Date() }) {
  assertValidSlug(slug);
  const path = kbPath(dataDir, slug);
  if (!existsSync(path)) {
    throw new Error(`kb entry not_found: ${slug}`);
  }
  const raw = readFileSync(path, "utf8");
  const { meta: existing, body: existingBody } = parseFrontmatter(raw);

  const merged = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "body") continue;
    merged[k] = v;
  }
  // Preserve immutable-ish fields when not in patch.
  merged.slug = slug;
  merged.created_at = existing.created_at ?? isoTimestamp(now);
  merged.updated_at = isoTimestamp(now);
  // Normalize shapes.
  if (!Array.isArray(merged.tags)) merged.tags = [];
  if (merged.category === undefined) merged.category = null;
  merged.pinned = merged.pinned === true;

  const newBody = "body" in patch ? patch.body : existingBody;
  const content = composeFile(merged, newBody ?? "");
  writeAtomic(path, content);
  return { meta: merged, body: newBody ?? "" };
}

export function kbDelete({ dataDir, slug }) {
  assertValidSlug(slug);
  const path = kbPath(dataDir, slug);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function kbList({ dataDir, tag, category, pinned } = {}) {
  const dir = knowledgeDir(dataDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const slug = entry.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    let parsed;
    try {
      parsed = readFrontmatterOnly(join(dir, entry));
    } catch {
      continue;
    }
    const meta = normalizeMetaForList({ ...parsed.meta, slug: parsed.meta.slug ?? slug });
    // Filters.
    if (tag !== undefined && !meta.tags.includes(tag)) continue;
    if (category !== undefined && meta.category !== category) continue;
    if (pinned !== undefined && meta.pinned !== pinned) continue;
    out.push(meta);
  }
  // Sort: pinned first (true before false), then updated_at DESC.
  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const au = a.updated_at ?? "";
    const bu = b.updated_at ?? "";
    if (au === bu) return 0;
    return au < bu ? 1 : -1;
  });
  return out;
}
