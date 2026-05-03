export const EMPTY_KB_FORM_ENTRY = {
  slug: "",
  title: "",
  category: "",
  subcategory: "",
  project_id: "",
  tags: [],
  pinned: false,
  body: "",
};

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
    body: normalized.body,
    tags: normalized.tags,
  };
}
