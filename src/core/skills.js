import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import JSZip from "jszip";
import { isValidSlug, slugify } from "./slugs.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const MAX_IMPORT_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_FILES = 500;
const MAX_TREE_ENTRIES = 1000;

export class SkillImportError extends Error {
  constructor(message, { code = "validation", status = 400 } = {}) {
    super(message);
    this.name = "SkillImportError";
    this.code = code;
    this.status = status;
  }
}

function coerce(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
  return value;
}

export function parseSkillFrontmatter(content) {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  const [, yaml, body] = m;
  const meta = {};
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    meta[key] = coerce(raw);
  }
  if (!("enabled" in meta)) meta.enabled = true;
  return { meta, body };
}

export function stripFrontmatter(content) {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return content;
  return m[2];
}

export function loadSkills(skillsDir) {
  const root = resolve(skillsDir);
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
    if (!parsed) continue;
    out.push({
      name: parsed.meta.name || entry,
      display_name: parsed.meta.display_name || parsed.meta.title || "",
      trigger: parsed.meta.trigger || "",
      enabled: parsed.meta.enabled !== false,
      priority: parsed.meta.priority,
      body: parsed.body,
      assetsPath: resolve(dir),
    });
  }
  return out;
}

function skillDir(skill) {
  if (!skill?.assetsPath || typeof skill.assetsPath !== "string") return "";
  return resolve(skill.assetsPath);
}

export function inferSkillsRoot(skills = []) {
  const roots = [...new Set(skills.map(skillDir).filter(Boolean).map(dirname))];
  return roots.length === 1 ? roots[0] : "";
}

export function getSkillAccessDirs(skills = []) {
  const root = inferSkillsRoot(skills);
  if (root) return [root];
  return [...new Set(skills.map(skillDir).filter(Boolean))];
}

const SKILL_PATH_RULE = "Path rule: Files referenced by SKILL.md are bundled with the skill. Resolve `scripts/...`, `references/...`, and `assets/...` relative to that skill's directory; resolve `<skill-directory-name>/...` relative to the Worklab skills root.";

export function buildSkillPathNote({ assetsPath, skillsRoot } = {}) {
  const lines = [];
  if (skillsRoot) lines.push(`Worklab skills root: ${resolve(skillsRoot)}`);
  if (assetsPath) lines.push(`Skill directory: ${resolve(assetsPath)}`);
  lines.push(SKILL_PATH_RULE);
  return lines.join("\n");
}

export function formatSkillBodyWithPathNote({ body, assetsPath, skillsRoot, maxChars = 12000 } = {}) {
  const text = [
    buildSkillPathNote({ assetsPath, skillsRoot }),
    String(body || "").trim(),
  ].filter(Boolean).join("\n\n");
  return maxChars ? text.slice(0, maxChars) : text;
}

function safeArchivePath(name) {
  const raw = String(name || "");
  if (!raw || raw.includes("\0")) {
    throw new SkillImportError("zip contains an invalid path");
  }
  const normalizedSlash = raw.replace(/\\/g, "/");
  if (normalizedSlash.startsWith("/") || /^[A-Za-z]:/.test(normalizedSlash)) {
    throw new SkillImportError("zip contains an absolute path");
  }
  const parts = normalizedSlash.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new SkillImportError("zip contains a path outside the skill folder");
  }
  return parts.join("/");
}

function isIgnoredArchivePath(path) {
  return path === ".DS_Store" || path.endsWith("/.DS_Store") || path === "__MACOSX" || path.startsWith("__MACOSX/");
}

function isZipSymlink(entry) {
  return typeof entry.unixPermissions === "number" && (entry.unixPermissions & 0o170000) === 0o120000;
}

function collectArchiveEntries(zip) {
  const entries = [];
  for (const entry of Object.values(zip.files)) {
    if (isZipSymlink(entry)) {
      throw new SkillImportError("zip contains symlinks, which are not supported");
    }
    const path = safeArchivePath(entry.unsafeOriginalName || entry.name);
    if (!path || isIgnoredArchivePath(path)) continue;
    entries.push({ path, dir: entry.dir || entry.name.endsWith("/"), entry });
  }
  if (entries.length === 0) {
    throw new SkillImportError("zip does not contain a skill");
  }
  return entries;
}

function detectSkillRoot(entries) {
  const rootSkill = entries.find((item) => item.path === "SKILL.md" && !item.dir);
  if (rootSkill) return { prefix: "", skillPath: "SKILL.md", topFolder: "" };

  const topFolders = new Set(entries.map((item) => item.path.split("/")[0]).filter(Boolean));
  if (topFolders.size !== 1) {
    throw new SkillImportError("zip must contain SKILL.md at the root or inside one top-level folder");
  }
  const [topFolder] = [...topFolders];
  const skillPath = `${topFolder}/SKILL.md`;
  const skillEntry = entries.find((item) => item.path === skillPath && !item.dir);
  if (!skillEntry) {
    throw new SkillImportError("zip does not contain SKILL.md");
  }
  return { prefix: `${topFolder}/`, skillPath, topFolder };
}

function resolveImportName({ meta, topFolder, filename }) {
  if (meta.name) {
    if (!isValidSlug(meta.name)) {
      throw new SkillImportError("SKILL.md name must be a lowercase slug");
    }
    return meta.name;
  }
  const filenameStem = basename(String(filename || "")).replace(/\.zip$/i, "");
  return slugify(topFolder || filenameStem, "skill");
}

function assertInside(parent, child) {
  const root = resolve(parent);
  const target = resolve(child);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SkillImportError("zip contains a path outside the skill folder");
  }
}

export function buildSkillFileTree(skillDir, { maxEntries = MAX_TREE_ENTRIES } = {}) {
  if (!existsSync(skillDir)) return [];
  let count = 0;
  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const nodes = [];
    for (const entry of entries) {
      count += 1;
      if (count > maxEntries) break;
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, type: "folder", children: walk(join(dir, entry.name)) });
      } else if (entry.isSymbolicLink()) {
        nodes.push({ name: entry.name, type: "symlink" });
      } else {
        nodes.push({ name: entry.name, type: "file" });
      }
    }
    return nodes;
  }
  return walk(skillDir);
}

export async function importSkillZip({ skillsDir, zipBuffer, filename = "" }) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length === 0) {
    throw new SkillImportError("zip file is required");
  }
  if (zipBuffer.length > MAX_IMPORT_ZIP_BYTES) {
    throw new SkillImportError("zip file is too large", { code: "too_large", status: 413 });
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    throw new SkillImportError("invalid zip file");
  }

  const entries = collectArchiveEntries(zip);
  const root = detectSkillRoot(entries);
  const skillEntry = entries.find((item) => item.path === root.skillPath);
  const content = await skillEntry.entry.async("string");
  const parsed = parseSkillFrontmatter(content);
  if (!parsed) {
    throw new SkillImportError("SKILL.md must use YAML frontmatter");
  }

  const name = resolveImportName({ meta: parsed.meta || {}, topFolder: root.topFolder, filename });
  const finalDir = join(skillsDir, name);
  if (existsSync(finalDir)) {
    throw new SkillImportError("skill already exists", { code: "conflict", status: 409 });
  }

  mkdirSync(skillsDir, { recursive: true });
  const tmpDir = join(skillsDir, `.import-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  let fileCount = 0;
  let unpackedBytes = 0;

  try {
    for (const item of entries) {
      if (root.prefix && !item.path.startsWith(root.prefix)) continue;
      const relativePath = root.prefix ? item.path.slice(root.prefix.length) : item.path;
      if (!relativePath) continue;
      const dest = join(tmpDir, relativePath);
      assertInside(tmpDir, dest);
      if (item.dir) {
        mkdirSync(dest, { recursive: true });
        continue;
      }
      fileCount += 1;
      if (fileCount > MAX_IMPORT_FILES) {
        throw new SkillImportError(`skill zip may contain at most ${MAX_IMPORT_FILES} files`);
      }
      const data = await item.entry.async("nodebuffer");
      unpackedBytes += data.length;
      if (unpackedBytes > MAX_IMPORT_UNPACKED_BYTES) {
        throw new SkillImportError("unpacked skill is too large", { code: "too_large", status: 413 });
      }
      mkdirSync(join(dest, ".."), { recursive: true });
      writeFileSync(dest, data);
    }
    renameSync(tmpDir, finalDir);
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  return {
    name,
    meta: parsed.meta || {},
    body: parsed.body || "",
    files: buildSkillFileTree(finalDir),
  };
}

export function buildSkillIndex(skills) {
  const enabled = skills.filter(s => s.enabled);
  const lines = ["## Available skills", ""];
  const skillsRoot = inferSkillsRoot(enabled);
  if (skillsRoot) {
    lines.push(buildSkillPathNote({ skillsRoot }), "");
  }
  for (const s of enabled) {
    const assetsPath = skillDir(s);
    if (s.priority === "always" && s.body) {
      lines.push(
        `### ${s.name}`,
        "",
        assetsPath ? buildSkillPathNote({ assetsPath }) : SKILL_PATH_RULE,
        "",
        s.body.trim(),
        "",
      );
    } else {
      const pathText = assetsPath ? ` (directory: ${assetsPath})` : "";
      lines.push(`- ${s.name}: ${s.trigger}${pathText}`);
    }
  }
  return lines.join("\n");
}
