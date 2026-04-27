import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  buildSkillFileTree,
  buildSkillIndex,
  importSkillZip,
  loadSkills,
  parseSkillFrontmatter,
  stripFrontmatter,
} from "../../core/skills.js";

async function zipBuffer(files) {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("parseSkillFrontmatter", () => {
  it("returns null when no frontmatter", () => {
    expect(parseSkillFrontmatter("# body only")).toBeNull();
  });

  it("parses scalar fields", () => {
    const r = parseSkillFrontmatter(`---
name: s
trigger: "when X"
enabled: true
---
body`);
    expect(r.meta).toEqual({ name: "s", trigger: "when X", enabled: true });
    expect(r.body.trim()).toBe("body");
  });

  it("parses priority as string", () => {
    const r = parseSkillFrontmatter(`---
name: s
trigger: t
priority: always
---
x`);
    expect(r.meta.priority).toBe("always");
  });

  it("defaults enabled to true when missing", () => {
    const r = parseSkillFrontmatter(`---
name: s
trigger: t
---
x`);
    expect(r.meta.enabled).toBe(true);
  });
});

describe("loadSkills + buildSkillIndex", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mk() { const d = mkdtempSync(join(tmpdir(), "worklab-skills-")); dirs.push(d); return d; }

  it("returns [] for empty dir", () => {
    expect(loadSkills(mk())).toEqual([]);
  });

  it("loads enabled skills", () => {
    const d = mk();
    mkdirSync(join(d, "a"));
    writeFileSync(join(d, "a", "SKILL.md"), `---
name: a
trigger: "do A"
enabled: true
---
body-a`);
    mkdirSync(join(d, "b"));
    writeFileSync(join(d, "b", "SKILL.md"), `---
name: b
trigger: "do B"
enabled: false
---
body-b`);
    const loaded = loadSkills(d);
    expect(loaded.map(s => s.name).sort()).toEqual(["a", "b"]);
    const enabled = loaded.filter(s => s.enabled);
    expect(enabled.length).toBe(1);
    expect(enabled[0].name).toBe("a");
  });

  it("buildSkillIndex renders name + trigger one-liners", () => {
    const skills = [
      { name: "a", trigger: "do A", enabled: true, priority: undefined },
      { name: "b", trigger: "do B", enabled: true, priority: undefined },
    ];
    const idx = buildSkillIndex(skills);
    expect(idx).toContain("- a: do A");
    expect(idx).toContain("- b: do B");
  });

  it("buildSkillIndex inlines priority:always skill bodies", () => {
    const skills = [
      { name: "pin", trigger: "always", enabled: true, priority: "always", body: "INLINED BODY" },
      { name: "ref", trigger: "on demand", enabled: true, priority: undefined, body: "deferred" },
    ];
    const idx = buildSkillIndex(skills);
    expect(idx).toContain("INLINED BODY");
    expect(idx).not.toContain("deferred");
  });
});

describe("importSkillZip", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mk() { const d = mkdtempSync(join(tmpdir(), "worklab-skills-")); dirs.push(d); return d; }

  it("imports root SKILL.md archives and returns a names-only file tree", async () => {
    const skillsDir = mk();
    const buffer = await zipBuffer({
      "SKILL.md": "---\nname: root-skill\ntrigger: when root\n---\nbody",
      "assets/prompt.txt": "hello",
    });

    const skill = await importSkillZip({ skillsDir, zipBuffer: buffer, filename: "fallback.zip" });

    expect(skill.name).toBe("root-skill");
    expect(existsSync(join(skillsDir, "root-skill", "assets", "prompt.txt"))).toBe(true);
    expect(skill.files).toEqual([
      { name: "assets", type: "folder", children: [{ name: "prompt.txt", type: "file" }] },
      { name: "SKILL.md", type: "file" },
    ]);
  });

  it("imports single-folder archives and falls back to a slug from the folder", async () => {
    const skillsDir = mk();
    const buffer = await zipBuffer({
      "Research Skill/SKILL.md": "---\ntrigger: when researching\n---\nbody",
    });

    const skill = await importSkillZip({ skillsDir, zipBuffer: buffer, filename: "ignored.zip" });

    expect(skill.name).toBe("research-skill");
    expect(loadSkills(skillsDir).map((s) => s.name)).toEqual(["research-skill"]);
  });

  it("rejects duplicate skill names", async () => {
    const skillsDir = mk();
    mkdirSync(join(skillsDir, "dup"), { recursive: true });
    const buffer = await zipBuffer({
      "SKILL.md": "---\nname: dup\ntrigger: when dup\n---\nbody",
    });

    await expect(importSkillZip({ skillsDir, zipBuffer: buffer, filename: "dup.zip" }))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("rejects archives with unsafe paths", async () => {
    const skillsDir = mk();
    const buffer = await zipBuffer({
      "SKILL.md": "---\nname: unsafe\ntrigger: x\n---\nbody",
      "../outside.txt": "bad",
    });

    await expect(importSkillZip({ skillsDir, zipBuffer: buffer, filename: "unsafe.zip" }))
      .rejects.toMatchObject({ code: "validation" });
  });
});

describe("buildSkillFileTree", () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function mk() { const d = mkdtempSync(join(tmpdir(), "worklab-skills-")); dirs.push(d); return d; }

  it("sorts folders before files", () => {
    const d = mk();
    mkdirSync(join(d, "assets"));
    writeFileSync(join(d, "SKILL.md"), "---\nname: t\n---\nbody");
    writeFileSync(join(d, "assets", "a.txt"), "a");

    expect(buildSkillFileTree(d)).toEqual([
      { name: "assets", type: "folder", children: [{ name: "a.txt", type: "file" }] },
      { name: "SKILL.md", type: "file" },
    ]);
  });
});

describe("stripFrontmatter", () => {
  it("strips YAML frontmatter, preserves body", () => {
    const out = stripFrontmatter(`---
a: 1
---
body content`);
    expect(out.trim()).toBe("body content");
  });

  it("passes through when no frontmatter", () => {
    expect(stripFrontmatter("just body")).toBe("just body");
  });
});
