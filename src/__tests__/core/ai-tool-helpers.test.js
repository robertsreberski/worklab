import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { globToolImpl, grepToolImpl } from "../../core/ai-tool-helpers.js";

const tempDirs = [];
let previousWorkspace = process.env.WORKLAB_WORKSPACE;

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "worklab-ai-tools-"));
  tempDirs.push(dir);
  process.env.WORKLAB_WORKSPACE = dir;
  return dir;
}

function writeFile(path, content = "") {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  process.env.WORKLAB_WORKSPACE = previousWorkspace;
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("ai tool helpers", () => {
  it("glob excludes generated and vendor paths by default", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "app.ts"), "source");
    writeFile(join(root, "node_modules", "pkg", "index.js"), "vendor");
    writeFile(join(root, "dist", "assets", "app.js"), "bundle");
    writeFile(join(root, "src", "app.ts.map"), "sourcemap");

    const result = await globToolImpl({ path: root, pattern: "**/*" });

    expect(result).toContain("src/app.ts");
    expect(result).not.toContain("/node_modules/");
    expect(result).not.toContain("dist/assets");
    expect(result).not.toContain("app.ts.map");
    expect(result).toContain("Excluded directories:");
  });

  it("glob caps broad result previews", async () => {
    const root = tempWorkspace();
    for (let index = 0; index < 5; index += 1) {
      writeFile(join(root, "src", `file-${index}.ts`), "source");
    }

    const result = await globToolImpl({ path: root, pattern: "**/*", max_matches: 2 });

    expect((result.match(/src\/file-/g) || [])).toHaveLength(2);
    expect(result).toContain("[truncated Glob result: showing 2 of 5 lines");
  });

  it("grep excludes generated and vendor paths and caps output", async () => {
    const root = tempWorkspace();
    writeFile(join(root, "src", "one.ts"), "needle one");
    writeFile(join(root, "src", "two.ts"), "needle two");
    writeFile(join(root, "node_modules", "pkg", "index.js"), "needle vendor");
    writeFile(join(root, "dist", "bundle.js"), "needle bundle");
    writeFile(join(root, "src", "bundle.js.map"), "needle map");

    const result = await grepToolImpl({ path: root, pattern: "needle", max_matches: 1 });

    expect(result).toMatch(/src\/(one|two)\.ts/);
    expect(result).not.toContain("/node_modules/");
    expect(result).not.toContain("dist/bundle");
    expect(result).not.toContain("bundle.js.map");
    expect(result).toContain("[truncated Grep result: showing 1 of 2 lines");
  });
});
