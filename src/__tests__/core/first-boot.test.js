import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDataFromTemplate } from "../../core/first-boot.js";

describe("seedDataFromTemplate", () => {
  const created = [];
  afterEach(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  function mkDir(name) {
    const p = mkdtempSync(join(tmpdir(), `worklab-fb-${name}-`));
    created.push(p);
    return p;
  }

  it("copies template files when data dir is missing", () => {
    const template = mkDir("tpl");
    const data = join(mkDir("parent"), "data");
    mkdirSync(join(template, "knowledge"), { recursive: true });
    writeFileSync(join(template, "knowledge", "welcome.md"), "hello");
    seedDataFromTemplate({ templateDir: template, dataDir: data });
    expect(existsSync(join(data, "knowledge", "welcome.md"))).toBe(true);
    expect(readFileSync(join(data, "knowledge", "welcome.md"), "utf8")).toBe("hello");
  });

  it("is a no-op when data dir already exists and is non-empty", () => {
    const template = mkDir("tpl2");
    const data = mkDir("data2");
    mkdirSync(join(template, "knowledge"), { recursive: true });
    writeFileSync(join(template, "knowledge", "welcome.md"), "template");
    writeFileSync(join(data, "existing.txt"), "mine");
    seedDataFromTemplate({ templateDir: template, dataDir: data });
    expect(existsSync(join(data, "knowledge", "welcome.md"))).toBe(false);
    expect(readFileSync(join(data, "existing.txt"), "utf8")).toBe("mine");
  });
});
