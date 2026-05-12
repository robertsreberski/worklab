export const EMPTY_KB_FORM_ENTRY = {
  slug: "",
  title: "",
  category: "",
  subcategory: "",
  project_id: "",
  tags: [],
  source_task_id: "",
  source_task_key: "",
  source_run_id: "",
  source_agent: "",
  related_slugs: [],
  supersedes_slugs: [],
  canonical_slug: "",
  pinned: false,
  body: "",
};

function normalizeSlugList(value) {
  if (Array.isArray(value)) return value.map((slug) => String(slug || "").trim()).filter(Boolean);
  return String(value || "").split(",").map((slug) => slug.trim()).filter(Boolean);
}

function normalizeRelationEntry(value) {
  if (!value || typeof value !== "object") return null;
  const slug = String(value.slug || "").trim();
  if (!slug) return null;
  const title = String(value.title || "").trim() || "Unknown Knowledge";
  return value.missing ? { slug, title, missing: true } : { slug, title };
}

function normalizeRelationEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeRelationEntry).filter(Boolean);
}

export function normalizeKbEntry(entry) {
  const source = entry?.meta && typeof entry.meta === "object"
    ? { ...entry.meta, body: entry.body, project: entry.project || null }
    : (entry || {});

  const tags = Array.isArray(source.tags)
    ? source.tags
    : String(source.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);

  return {
    slug: source.slug || "",
    title: source.title || "",
    category: source.category || "",
    subcategory: source.subcategory || "",
    project_id: source.project_id || "",
    project: source.project || null,
    tags,
    pinned: !!source.pinned,
    source_task_id: source.source_task_id || "",
    source_task_key: source.source_task_key || "",
    source_run_id: source.source_run_id || "",
    source_agent: source.source_agent || "",
    related_slugs: normalizeSlugList(source.related_slugs),
    supersedes_slugs: normalizeSlugList(source.supersedes_slugs),
    canonical_slug: source.canonical_slug || "",
    canonical_entry: normalizeRelationEntry(source.canonical_entry),
    related_entries: normalizeRelationEntries(source.related_entries),
    supersedes_entries: normalizeRelationEntries(source.supersedes_entries),
    body: source.body || "",
    author: source.author || "",
    created_at: source.created_at || null,
    updated_at: source.updated_at || null,
  };
}

export function normalizeKbFormEntry(entry) {
  const normalized = normalizeKbEntry(entry);

  return {
    ...EMPTY_KB_FORM_ENTRY,
    slug: normalized.slug,
    title: normalized.title,
    category: normalized.category,
    subcategory: normalized.subcategory,
    project_id: normalized.project_id,
    pinned: normalized.pinned,
    source_task_id: normalized.source_task_id,
    source_task_key: normalized.source_task_key,
    source_run_id: normalized.source_run_id,
    source_agent: normalized.source_agent,
    related_slugs: normalized.related_slugs,
    supersedes_slugs: normalized.supersedes_slugs,
    canonical_slug: normalized.canonical_slug,
    body: normalized.body,
    tags: normalized.tags,
  };
}

export function kbFormEntryFromQuery(query = {}) {
  const entry = {
    ...EMPTY_KB_FORM_ENTRY,
    title: query.title || "",
    category: query.category || "",
    subcategory: query.subcategory || "",
    project_id: query.project_id || "",
    source_task_id: query.source_task_id || "",
    source_task_key: query.source_task_key || "",
    source_run_id: query.source_run_id || "",
    source_agent: query.source_agent || "",
    related_slugs: normalizeSlugList(query.related_slugs),
    supersedes_slugs: normalizeSlugList(query.supersedes_slugs),
    canonical_slug: query.canonical_slug || "",
    tags: normalizeSlugList(query.tags),
    body: query.body || "",
  };
  return entry;
}
