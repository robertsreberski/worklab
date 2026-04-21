import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../core/config.js";

describe("loadConfig", () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("WORKLAB_")) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns defaults when no env set", () => {
    const c = loadConfig();
    expect(c.port).toBe(7878);
    expect(c.dataDir).toMatch(/\/data$/);
    expect(c.logLevel).toBe("info");
  });

  it("honors WORKLAB_PORT", () => {
    process.env.WORKLAB_PORT = "9000";
    expect(loadConfig().port).toBe(9000);
  });

  it("honors WORKLAB_DATA_DIR", () => {
    process.env.WORKLAB_DATA_DIR = "/tmp/custom";
    expect(loadConfig().dataDir).toBe("/tmp/custom");
  });

  it("resolves workspace default to ~/worklab-workspace", () => {
    const c = loadConfig();
    expect(c.workspace).toMatch(/worklab-workspace$/);
  });
});
