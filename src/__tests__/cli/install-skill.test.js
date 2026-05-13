import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installSkill, normalizeInstallSkillTargets } from "../../cli/install-skill.js";

function makeSkillSource(root) {
  const sourceDir = join(root, "skills", "worklab");
  mkdirSync(join(sourceDir, "references"), { recursive: true });
  writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: worklab\n---\n# Worklab\n");
  writeFileSync(join(sourceDir, "references", "agent-task-recipes.md"), "# Recipes\n");
  return sourceDir;
}

describe("install-skill CLI helper", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });
  function tmp() {
    const dir = mkdtempSync(join(tmpdir(), "worklab-install-skill-"));
    dirs.push(dir);
    return dir;
  }

  it("normalizes supported target aliases", () => {
    expect(normalizeInstallSkillTargets("codex")).toEqual(["codex"]);
    expect(normalizeInstallSkillTargets("claude-code")).toEqual(["claude"]);
    expect(normalizeInstallSkillTargets("claude_code")).toEqual(["claude"]);
    expect(normalizeInstallSkillTargets("all")).toEqual(["codex", "claude"]);
    expect(() => normalizeInstallSkillTargets("vim")).toThrow(/invalid target/);
  });

  it("installs Codex target as a symlink by default", () => {
    const root = tmp();
    const sourceDir = makeSkillSource(root);
    const codexHome = join(root, "codex-home");

    const result = installSkill({
      target: "codex",
      sourceDir,
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    const destination = join(codexHome, "skills", "worklab");
    expect(result).toEqual([
      expect.objectContaining({ target: "codex", mode: "symlink", action: "installed", wrote: true }),
    ]);
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(resolve(join(destination, ".."), readlinkSync(destination))).toBe(resolve(sourceDir));
  });

  it("installs both targets when target is all", () => {
    const root = tmp();
    const sourceDir = makeSkillSource(root);
    const codexHome = join(root, "codex-home");
    const claudeHome = join(root, "claude-home");

    const result = installSkill({
      target: "all",
      sourceDir,
      env: { CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome, HOME: root },
    });

    expect(result.map((entry) => entry.target)).toEqual(["codex", "claude"]);
    expect(lstatSync(join(codexHome, "skills", "worklab")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(claudeHome, "skills", "worklab")).isSymbolicLink()).toBe(true);
  });

  it("can install a physical copy instead of a symlink", () => {
    const root = tmp();
    const sourceDir = makeSkillSource(root);
    const claudeHome = join(root, "claude-home");

    installSkill({
      target: "claude",
      sourceDir,
      mode: "copy",
      env: { CLAUDE_HOME: claudeHome, HOME: root },
    });

    const destination = join(claudeHome, "skills", "worklab");
    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(destination, "references", "agent-task-recipes.md"), "utf8")).toContain("Recipes");
  });

  it("treats an existing canonical symlink as up to date", () => {
    const root = tmp();
    const sourceDir = makeSkillSource(root);
    const codexHome = join(root, "codex-home");

    installSkill({ target: "codex", sourceDir, env: { CODEX_HOME: codexHome, HOME: root } });
    const result = installSkill({ target: "codex", sourceDir, env: { CODEX_HOME: codexHome, HOME: root } });

    expect(result).toEqual([
      expect.objectContaining({ action: "up_to_date", wrote: false }),
    ]);
  });

  it("refuses to replace an existing directory unless force is passed", () => {
    const root = tmp();
    const sourceDir = makeSkillSource(root);
    const codexHome = join(root, "codex-home");
    const destination = join(codexHome, "skills", "worklab");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "SKILL.md"), "---\nname: worklab\n---\n# Divergent\n");

    expect(() => installSkill({
      target: "codex",
      sourceDir,
      env: { CODEX_HOME: codexHome, HOME: root },
    })).toThrow(/already exists/);

    const result = installSkill({
      target: "codex",
      sourceDir,
      force: true,
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    expect(result).toEqual([
      expect.objectContaining({ action: "replaced", wrote: true }),
    ]);
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  });

  it("dry-runs without writing", () => {
    const root = tmp();
    const sourceDir = makeSkillSource(root);
    const codexHome = join(root, "codex-home");
    const destination = join(codexHome, "skills", "worklab");

    const result = installSkill({
      target: "codex",
      sourceDir,
      dryRun: true,
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    expect(result).toEqual([
      expect.objectContaining({ action: "install", wrote: false }),
    ]);
    expect(existsSync(destination)).toBe(false);
  });
});
