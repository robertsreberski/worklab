import { describe, expect, it } from "vitest";
import { searchStartupScanDelayMs } from "../../coordinator/search-indexer.js";

describe("search indexer startup scan", () => {
  it("delays the startup scan for an empty index so first boot can still build search", () => {
    expect(searchStartupScanDelayMs({ indexed: 0, env: {} })).toBe(60_000);
  });

  it("skips the startup scan by default when an index already exists", () => {
    expect(searchStartupScanDelayMs({ indexed: 42, env: {} })).toBeNull();
  });

  it("allows operators and tests to override the startup scan delay", () => {
    expect(searchStartupScanDelayMs({ indexed: 42, env: { WORKLAB_SEARCH_STARTUP_SCAN_DELAY_MS: "0" } })).toBe(0);
    expect(searchStartupScanDelayMs({ indexed: 42, env: { WORKLAB_SEARCH_STARTUP_SCAN_DELAY_MS: "2500" } })).toBe(2500);
  });
});
