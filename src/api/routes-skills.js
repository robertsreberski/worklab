import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import {
  buildSkillFileTree,
  importSkillZip,
  loadSkills,
  parseSkillFrontmatter,
  SkillImportError,
} from "../core/skills.js";
import { isValidSlug, uniqueSlug } from "../core/slugs.js";
import { parseStoredAllowlist, storedAllowlistMode } from "../core/agent-allowlists.js";

function serializeSkill(meta, body) {
  const yamlLines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
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
  const parseZipBody = express.raw({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: "25mb" });

  function parseRawZip(req, res, next) {
    parseZipBody(req, res, (err) => {
      if (!err) return next();
      const status = err.type === "entity.too.large" ? 413 : 400;
      const code = status === 413 ? "too_large" : "validation";
      res.status(status).json({ error: { code, message: status === 413 ? "zip file is too large" : err.message } });
    });
  }

  function headerFilename(req) {
    const raw = req.get("x-skill-filename") || req.get("x-filename") || "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  app.get("/api/skills", (_req, res) => {
    const agents = db
      ? db.prepare("SELECT skills_allowlist, skills_allowlist_mode FROM agents").all().map((row) => ({
        list: parseStoredAllowlist(row.skills_allowlist),
        mode: storedAllowlistMode(row.skills_allowlist_mode),
      }))
      : [];
    const openAllowlistCount = agents.filter((agent) => agent.mode === "all").length;
    const skills = loadSkills(skillsDir()).map((s) => {
      const explicitCount = agents.filter((agent) => agent.mode === "custom" && agent.list.includes(s.name)).length;
      return {
        name: s.name,
        display_name: s.display_name,
        trigger: s.trigger,
        enabled: s.enabled,
        priority: s.priority,
        used_by_count: explicitCount + openAllowlistCount,
      };
    });
    res.json({ skills });
  });

  app.get("/api/skills/:name", (req, res) => {
    const dir = join(skillsDir(), req.params.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      return res.status(404).json({ error: { code: "not_found", message: "skill not found" } });
    }
    const parsed = parseSkillFrontmatter(readFileSync(file, "utf8"));
    res.json({ skill: { name: req.params.name, meta: parsed?.meta || {}, body: parsed?.body || "", files: buildSkillFileTree(dir) } });
  });

  app.post("/api/skills/import", parseRawZip, async (req, res, next) => {
    try {
      const skill = await importSkillZip({
        skillsDir: skillsDir(),
        zipBuffer: req.body,
        filename: headerFilename(req),
      });
      res.status(201).json({ skill });
    } catch (err) {
      if (err instanceof SkillImportError) {
        return res.status(err.status).json({ error: { code: err.code, message: err.message } });
      }
      next(err);
    }
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
    const patchMeta = req.body.meta || {};
    const meta = { ...(current?.meta || {}), ...patchMeta, name: req.params.name };
    if ("priority" in patchMeta && (patchMeta.priority === null || patchMeta.priority === "")) {
      delete meta.priority;
    }
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
  // An agent in all-mode has ALL enabled skills available,
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
    for (const row of db.prepare("SELECT name, display_name, skills_allowlist, skills_allowlist_mode FROM agents").all()) {
      const allow = parseStoredAllowlist(row.skills_allowlist);
      if (storedAllowlistMode(row.skills_allowlist_mode) === "all") { openAllowlist++; continue; }
      if (allow.includes(req.params.name)) {
        explicit.push({ name: row.name, display_name: row.display_name });
      }
    }
    res.json({ explicit, openAllowlist });
  });
}
