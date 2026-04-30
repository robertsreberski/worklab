// Skill-rendering helpers used to inject skill bodies and metadata into
// agent system prompts. Lives in agent/prompt/ because the rendering shape
// is a kernel concern; data loading (loadSkills, parseSkillFrontmatter)
// stays in core/skills.js.

import { dirname, resolve } from "node:path";

const SKILL_PATH_RULE = "Path rule: Files referenced by SKILL.md are bundled with the skill. Resolve `scripts/...`, `references/...`, and `assets/...` relative to that skill's directory; resolve `<skill-directory-name>/...` relative to the Worklab skills root.";

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

export function buildSkillIndex(skills) {
  const enabled = skills.filter((s) => s.enabled);
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
