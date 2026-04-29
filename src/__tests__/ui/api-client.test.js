import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../ui/src/lib/api.js";

function uiSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...uiSourceFiles(path));
    } else if (/\.[cm]?[jt]sx?$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

describe("ui API client", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches run cost summary through a named helper", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        today: { total_usd: 0.01, run_count: 1 },
        week: { total_usd: 0.01, run_count: 1 },
        today_by_agent: [],
      }),
    }));

    const result = await api.getRunCostSummary();

    expect(result.today.total_usd).toBe(0.01);
    expect(global.fetch).toHaveBeenCalledWith("/api/runs/cost-summary", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
  });
});

describe("ui API call sites", () => {
  it("use named API helpers instead of generic verb helpers", () => {
    const uiRoot = resolve(import.meta.dirname, "../../ui/src");
    const genericCalls = [];
    for (const file of uiSourceFiles(uiRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bapi\.(get|post|put|patch|delete)\s*\(/g)) {
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        genericCalls.push(`${relative(uiRoot, file)}:${line}: ${match[0]}`);
      }
    }

    expect(genericCalls).toEqual([]);
  });
});
