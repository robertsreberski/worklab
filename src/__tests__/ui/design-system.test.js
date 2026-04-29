import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesPath = resolve(import.meta.dirname, "../../ui/src/styles.css");

describe("design system stylesheet", () => {
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
