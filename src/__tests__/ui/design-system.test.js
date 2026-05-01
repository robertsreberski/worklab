import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DESIGN_SYSTEM_COMPONENT_COVERAGE } from "../../ui/src/routes/DesignSystem.jsx";

const repoRoot = resolve(import.meta.dirname, "../../..");
const docsPath = resolve(repoRoot, "docs/ui-design-system.md");
const stylesPath = resolve(import.meta.dirname, "../../ui/src/styles.css");
const primitivesIndexPath = resolve(repoRoot, "src/ui/src/components/primitives/index.js");
const layoutIndexPath = resolve(repoRoot, "src/ui/src/components/layout/index.js");
const componentsDir = resolve(repoRoot, "src/ui/src/components");

function componentExportsFromBarrel(filePath) {
  const source = readFileSync(filePath, "utf8");
  return [...source.matchAll(/export \{([^}]+)\} from/g)]
    .flatMap((match) => match[1].split(","))
    .map((item) => item.trim().split(/\s+as\s+/)[0])
    .filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name));
}

function rootComponentExports() {
  return readdirSync(componentsDir)
    .filter((file) => file.endsWith(".jsx"))
    .flatMap((file) => {
      const source = readFileSync(resolve(componentsDir, file), "utf8");
      return [...source.matchAll(/export function ([A-Z][A-Za-z0-9]*)/g)]
        .map((match) => match[1]);
    })
    .sort();
}

function coverageNames(group) {
  return DESIGN_SYSTEM_COMPONENT_COVERAGE
    .filter((item) => item.group === group)
    .map((item) => item.name)
    .sort();
}

describe("design system catalog", () => {
  it("keeps the written design-system reference available", () => {
    expect(existsSync(docsPath)).toBe(true);
    const docs = readFileSync(docsPath, "utf8");
    expect(docs).toContain("# Worklab UI Design System");
    expect(docs).toContain("src/ui/src/routes/DesignSystem.jsx");
  });

  it("represents every primitive export in the live catalog coverage", () => {
    expect(coverageNames("primitive")).toEqual(componentExportsFromBarrel(primitivesIndexPath).sort());
  });

  it("represents every layout export in the live catalog coverage", () => {
    expect(coverageNames("layout")).toEqual(componentExportsFromBarrel(layoutIndexPath).sort());
  });

  it("represents every shared root component or marks it as shell-hosted", () => {
    expect(coverageNames("component")).toEqual(rootComponentExports());
    const invalidCoverage = DESIGN_SYSTEM_COMPONENT_COVERAGE
      .filter((item) => !["visible", "shell-hosted"].includes(item.coverage));
    expect(invalidCoverage).toEqual([]);
  });

  it("does not duplicate coverage entries", () => {
    const names = DESIGN_SYSTEM_COMPONENT_COVERAGE.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("design system stylesheet", () => {
  it("prevents status pills from shrinking in flex layouts", () => {
    const css = readFileSync(stylesPath, "utf8");
    const statusPillRule = css.match(/\.status-pill\s*\{[^}]*\}/)?.[0] || "";
    expect(statusPillRule).toMatch(/flex-shrink:\s*0\b/);
  });

  it("does not reference undefined static custom properties", () => {
    const css = readFileSync(stylesPath, "utf8");
    const declared = new Set([...css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((match) => match[1]));
    const referenced = new Set([...css.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)].map((match) => match[1]));
    const dynamic = new Set([
      "--agent-avatar-hue",
      "--agent-avatar-size",
      "--cols",
      "--dot-color",
      "--dot-size",
      "--indent",
      "--pill-color",
      "--pulse-color",
      "--select-menu-width",
      "--shimmer-h",
      "--status-color",
      "--swatch",
    ]);

    const missing = [...referenced].filter((name) => !declared.has(name) && !dynamic.has(name));
    expect(missing).toEqual([]);
  });

  it("keeps typography responsive through tokens instead of viewport scaling", () => {
    const css = readFileSync(stylesPath, "utf8");
    expect(css).not.toMatch(/font-size:\s*clamp\(/);
    expect(css).not.toMatch(/letter-spacing:\s*-/);
  });
});
