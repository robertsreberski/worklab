import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DESIGN_SYSTEM_COMPONENT_COVERAGE } from "../../ui/src/routes/DesignSystem.jsx";

const repoRoot = resolve(import.meta.dirname, "../../..");
const docsPath = resolve(repoRoot, "docs/ui-design-system.md");
const stylesPath = resolve(import.meta.dirname, "../../ui/src/styles.css");
const buttonPath = resolve(repoRoot, "src/ui/src/components/primitives/Button.jsx");
const confirmButtonPath = resolve(repoRoot, "src/ui/src/components/ConfirmButton.jsx");
const mobileConfigSheetPath = resolve(repoRoot, "src/ui/src/components/MobileConfigSheet.jsx");
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

function declarationsForSelector(css, selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(",").map((item) => item.trim()).includes(selector))
    .map((match) => match[2])
    .join("\n");
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

  it("clips chip and badge text through shared primitives", () => {
    const css = readFileSync(stylesPath, "utf8");
    for (const selector of [".chip", ".badge", ".kb-category-badge"]) {
      const rule = css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0] || "";
      expect(rule).toMatch(/max-width:\s*100%/);
      expect(rule).toMatch(/overflow:\s*hidden\b/);
      expect(rule).toMatch(/text-overflow:\s*ellipsis\b/);
      expect(rule).toMatch(/white-space:\s*nowrap\b/);
    }
  });

  it("wraps and clips button labels through the Button primitive", () => {
    const buttonSource = readFileSync(buttonPath, "utf8");
    const css = readFileSync(stylesPath, "utf8");
    const buttonRule = css.match(/\.button\s*\{[^}]*\}/)?.[0] || "";
    const labelRule = css.match(/\.button-label\s*\{[^}]*\}/)?.[0] || "";

    expect(buttonSource).toContain("button-label");
    expect(buttonRule).toMatch(/min-width:\s*0\b/);
    expect(buttonRule).toMatch(/max-width:\s*100%/);
    expect(labelRule).toMatch(/overflow:\s*hidden\b/);
    expect(labelRule).toMatch(/text-overflow:\s*ellipsis\b/);
    expect(labelRule).toMatch(/white-space:\s*nowrap\b/);
  });

  it("builds confirmation actions on the shared Button primitive", () => {
    const confirmButtonSource = readFileSync(confirmButtonPath, "utf8");
    expect(confirmButtonSource).toMatch(/import\s+\{\s*Button\s*\}/);
    expect(confirmButtonSource).not.toMatch(/<button\b/);
  });

  it("builds mobile config icon actions on the shared IconButton primitive", () => {
    const mobileConfigSource = readFileSync(mobileConfigSheetPath, "utf8");
    expect(mobileConfigSource).toMatch(/import\s+\{\s*IconButton\s*\}/);
    expect(mobileConfigSource).toMatch(/<IconButton[\s\S]*mobile-config-trigger/);
    expect(mobileConfigSource).toMatch(/<IconButton[\s\S]*mobile-config-sheet-close/);
    expect(mobileConfigSource).not.toMatch(/class=\{`icon-button/);
    expect(mobileConfigSource).not.toMatch(/<button[^>]+class="mobile-config-sheet-close"/);
  });

  it("bounds shared component text surfaces", () => {
    const css = readFileSync(stylesPath, "utf8");
    for (const selector of [
      ".card-title",
      ".modal-head h2",
      ".drawer-head h2",
      ".empty-state-title",
      ".empty-state-body",
      ".error-state-title",
      ".error-state-body",
      ".loading-state-caption",
    ]) {
      const declarations = declarationsForSelector(css, selector);
      expect(declarations).toMatch(/max-width:\s*100%/);
      expect(declarations).toMatch(/overflow-wrap:\s*anywhere\b/);
    }
  });

  it("bounds live output and run-log text surfaces", () => {
    const css = readFileSync(stylesPath, "utf8");
    for (const selector of [
      ".event-row-body-text",
      ".tool-call-pre",
      ".structured-plain",
      ".tool-call-missing-note",
      ".tool-call-truncated-note",
      ".file-edit-muted",
      ".agentlog-coll-body",
      ".agentlog-event-text",
      ".agentlog-event-live-input",
      ".run-card-events-loading",
      ".task-live-composer-error",
    ]) {
      const declarations = declarationsForSelector(css, selector);
      expect(declarations).toMatch(/max-width:\s*100%/);
      expect(declarations).toMatch(/overflow-wrap:\s*anywhere\b/);
    }
  });

  it("bounds nested task row surfaces", () => {
    const css = readFileSync(stylesPath, "utf8");
    for (const selector of [".task-subtask-link", ".task-subtask-meta", ".project-task-row"]) {
      const declarations = declarationsForSelector(css, selector);
      expect(declarations).toMatch(/min-width:\s*0\b/);
      expect(declarations).toMatch(/max-width:\s*100%/);
    }

    const projectMetaText = declarationsForSelector(css, ".project-task-row-meta > span:not(.status-pill)");
    expect(projectMetaText).toMatch(/overflow:\s*hidden\b/);
    expect(projectMetaText).toMatch(/text-overflow:\s*ellipsis\b/);
    expect(projectMetaText).toMatch(/white-space:\s*nowrap\b/);

    const attentionChip = declarationsForSelector(css, ".project-task-attention-chip");
    expect(attentionChip).toMatch(/overflow:\s*hidden\b/);
    expect(attentionChip).toMatch(/text-overflow:\s*ellipsis\b/);
    expect(attentionChip).toMatch(/white-space:\s*nowrap\b/);
  });

  it("uses a contained pulse animation for active stage-token dots", () => {
    const css = readFileSync(stylesPath, "utf8");
    const pulseRule = css.match(/\.stage-token-pulse\s+\.stage-token-glyph\s*\{[^}]*\}/)?.[0] || "";
    const pulseKeyframes = css.match(/@keyframes\s+wl-stage-token-pulse\s*\{[\s\S]*?\n\}/)?.[0] || "";
    const stageTokenRule = css.match(/\.stage-token\s*\{[^}]*\}/)?.[0] || "";
    expect(pulseRule).toMatch(/animation:\s*wl-stage-token-pulse\b/);
    expect(stageTokenRule).toMatch(/overflow:\s*hidden\b/);
    expect(pulseKeyframes).not.toMatch(/transform:\s*scale/);
    expect(css).not.toMatch(/\bpulse-dot\b/);
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

  it("declares the iOS PWA viewport and safe-area contract", () => {
    const css = readFileSync(stylesPath, "utf8");
    const rootRule = css.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] || "";
    for (const token of [
      "--app-height",
      "--shell-height",
      "--vv-height",
      "--vv-offset",
      "--worklab-keyboard-height",
      "--worklab-safe-area-top",
      "--worklab-safe-area-bottom",
      "--worklab-safe-area-left",
      "--worklab-safe-area-right",
    ]) {
      expect(rootRule).toContain(`${token}:`);
    }
    expect(css).not.toMatch(/100dvh/);
    expect(css).not.toMatch(/-webkit-overflow-scrolling/);
    expect(css).not.toMatch(/:has\(input:focus/);
  });

  it("keeps bottom safe area inside mobile chrome only", () => {
    const css = readFileSync(stylesPath, "utf8");
    const tabbarRule = css.match(/\.app-tabbar\s*\{[^}]*\}/)?.[0] || "";
    expect(tabbarRule).toMatch(/height:\s*calc\(56px \+ var\(--mobile-safe-bottom\)\)/);
    expect(tabbarRule).toMatch(/padding-bottom:\s*var\(--mobile-safe-bottom\)/);
    expect(css).toMatch(/--mobile-tabbar-height:\s*calc\(56px \+ var\(--mobile-safe-bottom\)\);/);
    expect(css).toMatch(/--mobile-action-dock-height:\s*calc\(44px \+ var\(--sp-3\) \+ max\(var\(--sp-3\), var\(--mobile-safe-bottom\)\) \+ 1px\);/);
  });

  it("keeps top safe area inside mobile route headers when present", () => {
    const css = readFileSync(stylesPath, "utf8");
    expect(css).toContain(".app.responsive:has(.pane-list-head) .app-body");
    expect(css).toContain(".app.responsive:has(.page-wrap > .ds-page-head:first-child) .app-body");
    expect(css).toMatch(/\.app\.responsive\s+\.pane-list-head\s*\{[^}]*padding-top:\s*calc\(var\(--sp-2\) \+ var\(--mobile-safe-top\)\)/);
    expect(css).toMatch(/\.app\.responsive\s+\.page-wrap\s*>\s*\.ds-page-head:first-child\s*\{[^}]*padding-top:\s*calc\(var\(--sp-4\) \+ var\(--mobile-safe-top\)\)/);
  });

  it("keeps focused mobile text-entry controls at iOS-safe font sizes", () => {
    const css = readFileSync(stylesPath, "utf8");
    const mobileBlock = css.match(/\/\* iOS Safari zooms[\s\S]*?\.search-field-input \{ font-size: 16px; \}/)?.[0] || "";
    expect(mobileBlock).toContain(".textarea");
    expect(mobileBlock).toMatch(/\.textarea\.mono\s*\{\s*font-size:\s*16px;\s*\}/);
    expect(mobileBlock).not.toMatch(/font-size:\s*(?:1[0-5](?:\.\d+)?px|var\(--text-(?:xs|sm|base|md)\))/);
  });

  it("keeps typography responsive through tokens instead of viewport scaling", () => {
    const css = readFileSync(stylesPath, "utf8");
    expect(css).not.toMatch(/font-size:\s*clamp\(/);
    expect(css).not.toMatch(/letter-spacing:\s*-/);
  });
});
