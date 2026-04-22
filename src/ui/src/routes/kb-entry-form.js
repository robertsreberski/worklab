export const EMPTY_KB_FORM_ENTRY = {
  slug: "",
  title: "",
  category: "",
  tags: "",
  pinned: false,
  body: "",
};

export function normalizeKbFormEntry(entry) {
  const source = entry?.meta && typeof entry.meta === "object"
    ? { ...entry.meta, body: entry.body }
    : (entry || {});

  return {
    ...EMPTY_KB_FORM_ENTRY,
    slug: source.slug || "",
    title: source.title || "",
    category: source.category || "",
    tags: Array.isArray(source.tags) ? source.tags.join(", ") : (source.tags || ""),
    pinned: !!source.pinned,
    body: source.body || "",
  };
}
