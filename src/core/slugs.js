const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(value, fallback = "item") {
  const base = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return base || fallback;
}

export function isValidSlug(value) {
  return SLUG_RE.test(String(value || ""));
}

export function uniqueSlug(value, exists, { fallback = "item", maxLength = 64 } = {}) {
  const base = slugify(value, fallback).slice(0, maxLength).replace(/-+$/g, "") || fallback;
  if (!exists(base)) return base;
  for (let i = 2; i < 10_000; i += 1) {
    const suffix = `-${i}`;
    const stem = base.slice(0, maxLength - suffix.length).replace(/-+$/g, "") || fallback.slice(0, maxLength - suffix.length);
    const candidate = `${stem}${suffix}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`unable to generate unique slug for ${JSON.stringify(value)}`);
}
