import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

function normalizeLimit(value) {
  const parsed = Number(value || 12);
  if (!Number.isInteger(parsed) || parsed < 1) return 12;
  return Math.min(parsed, 50);
}

function isUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || ""));
}

function pathContext(prefix, baseWorkdir) {
  const raw = String(prefix || "").trim();
  if (!raw || raw.includes("\0") || isUrl(raw)) return null;
  if (raw === "~" || raw.startsWith("~/")) {
    const withoutHome = raw === "~" ? "" : raw.slice(2);
    const dirPart = withoutHome.endsWith("/") ? withoutHome : dirname(withoutHome);
    const namePart = withoutHome.endsWith("/") ? "" : withoutHome.split("/").pop();
    return {
      dir: resolve(homedir(), dirPart === "." ? "" : dirPart),
      partial: namePart || "",
      prefixDir: raw.endsWith("/") ? raw : `~/${dirPart === "." ? "" : `${dirPart}/`}`,
      mode: "home",
    };
  }
  if (raw.startsWith("/")) {
    return {
      dir: raw.endsWith("/") ? resolve(raw) : dirname(resolve(raw)),
      partial: raw.endsWith("/") ? "" : raw.split("/").pop(),
      prefixDir: raw.endsWith("/") ? raw : `${dirname(raw) === "/" ? "" : dirname(raw)}/`,
      mode: "absolute",
    };
  }
  const root = resolve(baseWorkdir || process.cwd());
  const dirPart = raw.endsWith("/") ? raw : dirname(raw);
  const cleanDirPart = dirPart === "." ? "" : dirPart;
  const dir = resolve(root, cleanDirPart);
  const rel = relative(root, dir);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) return null;
  return {
    dir,
    partial: raw.endsWith("/") ? "" : raw.split("/").pop(),
    prefixDir: raw.endsWith("/") ? raw : (cleanDirPart ? `${cleanDirPart}/` : ""),
    mode: "relative",
  };
}

function insertionPath(ctx, name, isDirectory) {
  const suffix = isDirectory ? "/" : "";
  if (ctx.mode === "absolute") return `${ctx.prefixDir}${name}${suffix}`.replace(/\/+/g, "/");
  if (ctx.mode === "home") return `${ctx.prefixDir}${name}${suffix}`.replace(/^~\/+/, "~/").replace(/([^:])\/+/g, "$1/");
  return `${ctx.prefixDir}${name}${suffix}`.replace(/\/+/g, "/");
}

export function suggestLocalPaths({ prefix, baseWorkdir, limit } = {}) {
  const ctx = pathContext(prefix, baseWorkdir);
  if (!ctx || !existsSync(ctx.dir)) return [];
  const max = normalizeLimit(limit);
  let entries;
  try {
    entries = readdirSync(ctx.dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const includeHidden = ctx.partial.startsWith(".");
  return entries
    .filter((entry) => includeHidden || !entry.name.startsWith("."))
    .filter((entry) => entry.name.startsWith(ctx.partial))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, max)
    .map((entry) => {
      const isDirectory = entry.isDirectory();
      const path = insertionPath(ctx, entry.name, isDirectory);
      return {
        name: entry.name,
        kind: isDirectory ? "directory" : "file",
        path,
        absolute_path: join(ctx.dir, entry.name),
      };
    });
}
