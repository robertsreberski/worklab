import { describe, expect, it } from "vitest";
import { applyConfigArgs } from "../../cli/args.js";

// R5 — the CLI exposes `--drain-timeout-ms` so operators can extend the
// coordinator-side drain window when long-running tool calls (playwright
// snapshots, codex SDK calls) need more than the 60s default to wrap up.
describe("CLI --drain-timeout-ms", () => {
  it("propagates --drain-timeout-ms via WORKLAB_DRAIN_TIMEOUT_MS", () => {
    const env = {};
    applyConfigArgs(["restart", "--drain-timeout-ms=10000"], env);
    expect(env.WORKLAB_DRAIN_TIMEOUT_MS).toBe("10000");
  });

  it("accepts the space-separated form", () => {
    const env = {};
    applyConfigArgs(["start", "--drain-timeout-ms", "30000"], env);
    expect(env.WORKLAB_DRAIN_TIMEOUT_MS).toBe("30000");
  });

  it("rejects values outside the supported range", () => {
    expect(() => applyConfigArgs(["--drain-timeout-ms=-1"], {})).toThrow(/--drain-timeout-ms/);
    expect(() => applyConfigArgs(["--drain-timeout-ms=700000"], {})).toThrow(/--drain-timeout-ms/);
    expect(() => applyConfigArgs(["--drain-timeout-ms=abc"], {})).toThrow(/--drain-timeout-ms/);
  });

  it("does not set the env var when the flag is absent", () => {
    const env = { WORKLAB_DRAIN_TIMEOUT_MS: "5000" };
    applyConfigArgs(["restart"], env);
    // existing values are preserved unmodified
    expect(env.WORKLAB_DRAIN_TIMEOUT_MS).toBe("5000");
  });
});
