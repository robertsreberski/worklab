import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, localClientHost, worklabBaseUrl } from "../../core/config.js";

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
    expect(c.host).toBe("127.0.0.1");
    expect(c.dataDir).toMatch(/\/\.worklab$/);
    expect(c.logLevel).toBe("info");
    expect(c.runTimeoutMs).toBe(30 * 60 * 1000);
    expect(c.runIdleWarningMs).toBe(120 * 1000);
    expect(c.logInlineLimit).toBe(12_000);
    expect(c.drainTimeoutMs).toBe(60_000);
  });

  it("honors WORKLAB_PORT", () => {
    process.env.WORKLAB_PORT = "9000";
    expect(loadConfig().port).toBe(9000);
  });

  it("rejects invalid WORKLAB_PORT", () => {
    process.env.WORKLAB_PORT = "abc";
    expect(() => loadConfig()).toThrow(/WORKLAB_PORT/);
  });

  it("honors WORKLAB_DATA_DIR", () => {
    process.env.WORKLAB_DATA_DIR = "/tmp/custom";
    expect(loadConfig().dataDir).toBe("/tmp/custom");
  });

  it("honors runtime logging guardrail overrides", () => {
    process.env.WORKLAB_RUN_TIMEOUT_MS = "1000";
    process.env.WORKLAB_RUN_IDLE_WARNING_MS = "2000";
    process.env.WORKLAB_LOG_INLINE_LIMIT = "3000";
    process.env.WORKLAB_DRAIN_TIMEOUT_MS = "4000";
    const c = loadConfig();
    expect(c.runTimeoutMs).toBe(1000);
    expect(c.runIdleWarningMs).toBe(2000);
    expect(c.logInlineLimit).toBe(3000);
    expect(c.drainTimeoutMs).toBe(4000);
  });

  it("resolves workspace default to ~/worklab-workspace", () => {
    const c = loadConfig();
    expect(c.workspace).toMatch(/worklab-workspace$/);
  });

  it("uses loopback for local client URLs when binding all interfaces", () => {
    expect(localClientHost("0.0.0.0")).toBe("127.0.0.1");
    expect(worklabBaseUrl({ host: "0.0.0.0", port: 9000 })).toBe("http://127.0.0.1:9000");
  });
});
