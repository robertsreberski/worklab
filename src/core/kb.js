import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Stable order for frontmatter keys.
const FRONTMATTER_ORDER = [
  "title",
  "slug",
  "tags",
  "category",
  "subcategory",
  "project_id",
  "source_task_id",
  "source_task_key",
  "source_run_id",
  "source_agent",
  "related_slugs",
  "supersedes_slugs",
  "canonical_slug",
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

// Detect a double-quoted string (with our escape set) and return the decoded
// string. Returns null if `raw` is not a double-quoted literal. This must
// bypass other coercion rules — a quoted `"true"` is the string "true", not a
// boolean. Kept symmetric with `needsQuoting` + `quoteString` in the
// renderer.
function tryUnquoteDouble(raw) {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return null;
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === "\\" || next === '"') {
        out += next;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function coerceScalar(raw) {
  // Double-quoted literal always yields a string — short-circuits other rules.
  const unquoted = tryUnquoteDouble(raw);
  if (unquoted !== null) return unquoted;
  if (raw === "" || raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseFlowArray(raw) {
  // raw is like "[a, b, c]" or '[a, "b,c", d]' or '[a, "he said \"x\"", d]'.
  // Split at top-level commas while honouring double-quoted literals with
  // `\"` / `\\` escapes (mirrors `quoteString`), and bare single quotes.
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote === '"') {
      cur += ch;
      if (ch === "\\" && i + 1 < inner.length) {
        // Preserve the escape sequence verbatim; tryUnquoteDouble decodes it.
        cur += inner[i + 1];
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      cur += ch;
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
  // Each part goes through the same scalar coercion as a block-array item,
  // so a quoted `"true"` stays a string while bare `true` becomes a boolean.
  return parts.map((p) => coerceScalar(p));
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

// A string needs quoting whenever the raw form would be re-parsed as a
// non-string value (null/true/false/number/flow-array) or is structurally
// ambiguous (leading/trailing whitespace, `: ` inside). Kept in lockstep
// with `coerceScalar` so that render→parse is lossless.
function needsQuoting(s) {
  if (s === "") return true;
  if (s === "true" || s === "false" || s === "null" || s === "~") return true;
  if (/^-?\d+$/.test(s)) return true;
  if (s.startsWith("[") || s.endsWith("]")) return true;
  if (s.includes(": ")) return true;
  if (s.includes(",")) return true;
  if (/^\s/.test(s) || /\s$/.test(s)) return true;
  // Anything that would open a quoted form must also be quoted so it round
  // trips verbatim — otherwise a raw `"x"` would decode as the string `x`.
  if (s.startsWith('"') || s.startsWith("'")) return true;
  return false;
}

function quoteString(s) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderString(s) {
  return needsQuoting(s) ? quoteString(s) : s;
}

function renderArrayItem(v) {
  if (typeof v === "string") return renderString(v);
  return renderValue(v);
}

function renderValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((v) => renderArrayItem(v)).join(", ")}]`;
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return renderString(value);
  return String(value);
}

function renderFrontmatter(meta) {
  const lines = ["---"];
  for (const key of FRONTMATTER_ORDER) {
    if (!(key in meta)) continue;
    const v = meta[key];
    if (v === null || v === undefined) continue; // omit when null
    if ((key === "related_slugs" || key === "supersedes_slugs") && Array.isArray(v) && v.length === 0) continue;
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

// Durable atomic write. Sequence (crash-safe against power loss):
//   1. open(tmp, O_WRONLY|O_CREAT|O_TRUNC) — fresh temp file
//   2. write(tmp, content)
//   3. fsync(tmp)        — force page cache → disk for the data blocks
//   4. close(tmp)
//   5. rename(tmp, path) — atomic swap of directory entries
//   6. open(dir, O_RDONLY) + fsync(dir) + close(dir) — force the rename's
//      directory metadata to disk so the new name is observable after a
//      crash (without this the entry can be lost even though the data block
//      survived).
// Kept inline here (not imported from any utils) so this module stays
// self-contained and the safety invariant is visible at the call site.
function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Fsync the parent directory so the rename itself is durable.
  const dir = dirname(path);
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function ensureKnowledgeDir(dataDir) {
  const kd = knowledgeDir(dataDir);
  if (!existsSync(kd)) mkdirSync(kd, { recursive: true });
  return kd;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => String(tag || "").trim()).filter(Boolean))];
}

function normalizeSlugList(slugs) {
  if (!Array.isArray(slugs)) return [];
  return [...new Set(slugs
    .map((slug) => String(slug || "").trim())
    .filter((slug) => slug && SLUG_RE.test(slug)))];
}

function normalizeNullableString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

// --- List entry normalization ----------------------------------------------

function normalizeMetaForList(meta) {
  return {
    slug: meta.slug ?? null,
    title: meta.title ?? null,
    tags: normalizeTags(meta.tags),
    category: meta.category ?? null,
    subcategory: meta.subcategory ?? null,
    project_id: meta.project_id ?? null,
    source_task_id: meta.source_task_id ?? null,
    source_task_key: meta.source_task_key ?? null,
    source_run_id: meta.source_run_id ?? null,
    source_agent: meta.source_agent ?? null,
    related_slugs: normalizeSlugList(meta.related_slugs),
    supersedes_slugs: normalizeSlugList(meta.supersedes_slugs),
    canonical_slug: meta.canonical_slug ?? null,
    pinned: meta.pinned === true,
    author: meta.author ?? null,
    created_at: meta.created_at ?? null,
    updated_at: meta.updated_at ?? null,
  };
}

// Read only the frontmatter block — avoids loading potentially huge bodies.
// Strict about the terminator: only `\n---\n`, `\n---\r\n`, or `\n---` at
// EOF closes the block. A mid-body `\n---important` or `\n----` does not.
// Mirrors the shape of `FRONTMATTER_RE` at the top of this file.
const FM_TERMINATOR_RE = /\n---(?:\r?\n|$)/;

function readFrontmatterOnly(filePath) {
  const raw = readFileSync(filePath, "utf8");
  // Opening fence must start the file and be followed by a newline.
  const openMatch = /^---\r?\n/.exec(raw);
  if (!openMatch) throw new Error("missing opening frontmatter fence");
  const rest = raw.slice(openMatch[0].length);
  const endMatch = FM_TERMINATOR_RE.exec(rest);
  if (!endMatch) throw new Error("missing closing frontmatter fence");
  const yamlBlock = rest.slice(0, endMatch.index);
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
    tags: normalizeTags(meta.tags),
    category: meta.category ?? null,
    subcategory: meta.subcategory ?? null,
    project_id: meta.project_id ?? null,
    source_task_id: meta.source_task_id ?? null,
    source_task_key: meta.source_task_key ?? null,
    source_run_id: meta.source_run_id ?? null,
    source_agent: meta.source_agent ?? null,
    related_slugs: normalizeSlugList(meta.related_slugs),
    supersedes_slugs: normalizeSlugList(meta.supersedes_slugs),
    canonical_slug: meta.canonical_slug ?? null,
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
  subcategory = null,
  project_id = null,
  source_task_id = null,
  source_task_key = null,
  source_run_id = null,
  source_agent = null,
  related_slugs = [],
  supersedes_slugs = [],
  canonical_slug = null,
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
    tags: normalizeTags(tags),
    category: normalizeNullableString(category),
    subcategory: normalizeNullableString(subcategory),
    project_id: normalizeNullableString(project_id),
    source_task_id: normalizeNullableString(source_task_id),
    source_task_key: normalizeNullableString(source_task_key),
    source_run_id: normalizeNullableString(source_run_id),
    source_agent: normalizeNullableString(source_agent),
    related_slugs: normalizeSlugList(related_slugs),
    supersedes_slugs: normalizeSlugList(supersedes_slugs),
    canonical_slug: normalizeNullableString(canonical_slug),
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
  merged.tags = normalizeTags(merged.tags);
  merged.category = normalizeNullableString(merged.category);
  merged.subcategory = normalizeNullableString(merged.subcategory);
  merged.project_id = normalizeNullableString(merged.project_id);
  merged.source_task_id = normalizeNullableString(merged.source_task_id);
  merged.source_task_key = normalizeNullableString(merged.source_task_key);
  merged.source_run_id = normalizeNullableString(merged.source_run_id);
  merged.source_agent = normalizeNullableString(merged.source_agent);
  merged.related_slugs = normalizeSlugList(merged.related_slugs);
  merged.supersedes_slugs = normalizeSlugList(merged.supersedes_slugs);
  merged.canonical_slug = normalizeNullableString(merged.canonical_slug);
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

export function kbListPinned({ dataDir, limit = 10 } = {}) {
  try {
    const metas = kbList({ dataDir, pinned: true });
    const limited = metas.slice(0, limit);
    const out = [];
    for (const meta of limited) {
      try {
        const entry = kbRead({ dataDir, slug: meta.slug });
        if (!entry) continue;
        out.push({
          slug: entry.meta.slug ?? meta.slug,
          title: entry.meta.title ?? null,
          body: entry.body,
          category: entry.meta.category ?? null,
          subcategory: entry.meta.subcategory ?? null,
          project_id: entry.meta.project_id ?? null,
          tags: Array.isArray(entry.meta.tags) ? entry.meta.tags : [],
          pinned: entry.meta.pinned === true,
          author: entry.meta.author ?? null,
          created_at: entry.meta.created_at ?? null,
          updated_at: entry.meta.updated_at ?? null,
        });
      } catch (err) {
        console.warn("[kb] skipping unreadable pinned entry", {
          slug: meta.slug,
          err: err.message,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Mention-picker typeahead. Mirrors `kbList` but filters by case-insensitive
// substring against title and slug, then ranks exact-slug > slug-prefix >
// title-prefix > substring. Reuses the same on-disk scan so newly-created
// entries show up without an index rebuild.
export function kbListByTitlePrefix({ dataDir, query, limit = 8 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const all = kbList({ dataDir });
  const ranked = [];
  for (const meta of all) {
    const slug = String(meta.slug || "").toLowerCase();
    const title = String(meta.title || "").toLowerCase();
    let rank = -1;
    if (slug === lower) rank = 0;
    else if (slug.startsWith(lower)) rank = 1;
    else if (title.startsWith(lower)) rank = 2;
    else if (slug.includes(lower) || title.includes(lower)) rank = 3;
    if (rank >= 0) ranked.push({ rank, meta });
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const at = a.meta.updated_at || "";
    const bt = b.meta.updated_at || "";
    return at < bt ? 1 : at > bt ? -1 : 0;
  });
  return ranked.slice(0, limit).map((x) => x.meta);
}

export function kbReadMeta({ dataDir, slug }) {
  const entry = kbRead({ dataDir, slug });
  return entry ? entry.meta : null;
}

export function kbList({ dataDir, tag, category, subcategory, project_id, pinned } = {}) {
  const dir = knowledgeDir(dataDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const slug = entry.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    let parsed;
    const filePath = join(dir, entry);
    try {
      parsed = readFrontmatterOnly(filePath);
    } catch (err) {
      // Keep the list route resilient: malformed entries are skipped rather
      // than aborting the whole listing, but we log so they're diagnosable.
      console.warn("[kb] skipping unreadable entry", {
        file: filePath,
        err: err.message,
      });
      continue;
    }
    const meta = normalizeMetaForList({ ...parsed.meta, slug: parsed.meta.slug ?? slug });
    // Filters.
    if (tag !== undefined && !meta.tags.includes(tag)) continue;
    if (category !== undefined && meta.category !== category) continue;
    if (subcategory !== undefined && meta.subcategory !== subcategory) continue;
    if (project_id !== undefined && meta.project_id !== project_id) continue;
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

function safeDecode(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function autoPromotedRunResultInfo(entry = {}) {
  const meta = entry.meta && typeof entry.meta === "object" ? entry.meta : entry;
  const body = String(entry.body || "");
  const tags = normalizeTags(meta.tags);
  const runMatch = /Source run:\s*\[[^\]]*]\(\/api\/runs\/([^)]+?)\/raw-log\)/i.exec(body);
  const taskMatch = /Source task:\s*\[[^\]]*]\(#\/tasks\/([^)]+)\)/i.exec(body);
  const stageMatch = /^Stage:\s*(.+)$/im.exec(body);
  const agentMatch = /^Agent:\s*(.+)$/im.exec(body);
  const sourceRunId = safeDecode(meta.source_run_id || runMatch?.[1]);
  const sourceTaskRef = safeDecode(meta.source_task_key || meta.source_task_id || taskMatch?.[1]);
  const sourceAgent = normalizeNullableString(meta.source_agent || agentMatch?.[1]);
  const slug = String(meta.slug || "").trim();
  const generatedShape = SLUG_RE.test(slug)
    && slug.startsWith("run-")
    && meta.category === "run-results"
    && tags.includes("run-result")
    && !!sourceRunId
    && !!sourceTaskRef
    && /\n---\r?\n/.test(body);
  return {
    auto_promoted: generatedShape,
    source_run_id: sourceRunId,
    source_task_ref: sourceTaskRef,
    source_agent: sourceAgent,
    stage: normalizeNullableString(stageMatch?.[1]),
  };
}
