import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of readdirSync(skillsDir)) {
    const dir = join(skillsDir, entry);
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
      assetsPath: dir,
    });
  }
  return out;
}

export function buildSkillIndex(skills) {
  const enabled = skills.filter(s => s.enabled);
  const lines = ["## Available skills", ""];
  for (const s of enabled) {
    if (s.priority === "always" && s.body) {
      lines.push(`### ${s.name}`, "", s.body.trim(), "");
    } else {
      lines.push(`- ${s.name}: ${s.trigger}`);
    }
  }
  return lines.join("\n");
}
