import { describe, expect, it } from "vitest";
import { restartHealthTimeoutMs } from "../../cli/start.js";

describe("restart health timeout", () => {
  it("waits long enough for launchd replacement plus coordinator drain", () => {
    expect(restartHealthTimeoutMs({ drainTimeoutMs: 60_000 })).toBe(90_000);
    expect(restartHealthTimeoutMs({ drainTimeoutMs: 10_000 })).toBe(40_000);
  });

  it("uses a replacement-only timeout when drain is disabled or invalid", () => {
    expect(restartHealthTimeoutMs({ drainTimeoutMs: 0 })).toBe(30_000);
    expect(restartHealthTimeoutMs({ drainTimeoutMs: "abc" })).toBe(30_000);
  });
});
