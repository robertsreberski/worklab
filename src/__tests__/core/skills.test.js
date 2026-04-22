import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFrontmatter, loadSkills, buildSkillIndex, stripFrontmatter } from "../../core/skills.js";

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
