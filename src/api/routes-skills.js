import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadSkills, parseSkillFrontmatter } from "../core/skills.js";
import { isValidSlug, uniqueSlug } from "../core/slugs.js";

function serializeSkill(meta, body) {
  const yamlLines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string") {
      yamlLines.push(
        `${k}: ${v.includes(":") || v.includes("#") ? `"${v.replace(/"/g, '\\"')}"` : v}`
      );
    } else {
      yamlLines.push(`${k}: ${v}`);
    }
  }
  yamlLines.push("---");
  return yamlLines.join("\n") + "\n\n" + (body || "");
}

export function registerSkillRoutes(app, { dataDir, db }) {
  const skillsDir = () => join(dataDir, "skills");

  app.get("/api/skills", (_req, res) => {
    const skills = loadSkills(skillsDir()).map((s) => ({
      name: s.name,
      display_name: s.display_name,
      trigger: s.trigger,
      enabled: s.enabled,
      priority: s.priority,
    }));
    res.json({ skills });
  });

  app.get("/api/skills/:name", (req, res) => {
    const dir = join(skillsDir(), req.params.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      return res.status(404).json({ error: { code: "not_found", message: "skill not found" } });
    }
    const parsed = parseSkillFrontmatter(readFileSync(file, "utf8"));
    res.json({ skill: { name: req.params.name, meta: parsed?.meta || {}, body: parsed?.body || "" } });
  });

  app.post("/api/skills", (req, res) => {
    const { name, meta = {}, body = "" } = req.body || {};
    if (name && !isValidSlug(name)) {
      return res
        .status(400)
        .json({ error: { code: "validation", message: "invalid name (lowercase slug)" } });
    }
    if (!name && !meta.display_name) {
      return res
        .status(400)
        .json({ error: { code: "validation", message: "name or display_name is required" } });
    }
    const finalName = name || uniqueSlug(meta.display_name, (candidate) => existsSync(join(skillsDir(), candidate)), {
      fallback: "skill",
    });
    const dir = join(skillsDir(), finalName);
    if (existsSync(dir)) {
      return res.status(409).json({ error: { code: "conflict", message: "skill already exists" } });
    }
    mkdirSync(dir, { recursive: true });
    const finalMeta = { ...meta, name: finalName };
    writeFileSync(join(dir, "SKILL.md"), serializeSkill(finalMeta, body));
    res.status(201).json({ skill: { name: finalName, meta: finalMeta, body } });
  });

  app.patch("/api/skills/:name", (req, res) => {
    const dir = join(skillsDir(), req.params.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      return res.status(404).json({ error: { code: "not_found", message: "skill not found" } });
    }
    const current = parseSkillFrontmatter(readFileSync(file, "utf8"));
    const meta = { ...(current?.meta || {}), ...(req.body.meta || {}), name: req.params.name };
    const body = req.body.body !== undefined ? req.body.body : (current?.body || "");
    writeFileSync(file, serializeSkill(meta, body));
    res.json({ skill: { name: req.params.name, meta, body } });
  });

  app.delete("/api/skills/:name", (req, res) => {
    const dir = join(skillsDir(), req.params.name);
    if (!existsSync(dir)) {
      return res.status(404).json({ error: { code: "not_found", message: "skill not found" } });
    }
    rmSync(dir, { recursive: true, force: true });
    res.status(204).end();
  });

  // Reverse link: which agents have this skill in their allowlist.
  // An agent with an empty skills_allowlist has ALL enabled skills available,
  // so we surface both explicit allow-listers and the "available to every
  // open-allowlist agent" count separately.
  app.get("/api/skills/:name/usage", (req, res) => {
    const dir = join(skillsDir(), req.params.name);
    if (!existsSync(dir)) {
      return res.status(404).json({ error: { code: "not_found", message: "skill not found" } });
    }
    if (!db) return res.json({ explicit: [], openAllowlist: 0 });
    const explicit = [];
    let openAllowlist = 0;
    for (const row of db.prepare("SELECT name, display_name, skills_allowlist FROM agents").all()) {
      const allow = (() => { try { return JSON.parse(row.skills_allowlist || "[]"); } catch { return []; } })();
      if (allow.length === 0) { openAllowlist++; continue; }
      if (allow.includes(req.params.name)) {
        explicit.push({ name: row.name, display_name: row.display_name });
      }
    }
    res.json({ explicit, openAllowlist });
  });
}
