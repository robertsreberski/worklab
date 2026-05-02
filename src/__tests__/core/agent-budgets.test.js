import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_AGENT_BUDGET,
  evaluateBudget,
  loadAgentBudget,
  normalizeBudgetThresholds,
  resolveBudgetSearchPaths,
} from "../../core/agent-budgets.js";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeTmpDataDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "worklab-budgets-"));
  cleanups.push(dir);
  return dir;
}

describe("evaluateBudget", () => {
  it("returns no warnings when stats are well under both tiers", () => {
    const result = evaluateBudget(DEFAULT_AGENT_BUDGET, {
      cost_usd: 1,
      duration_ms: 60_000,
      num_turns: 10,
    });
    expect(result.soft_warn).toBe(false);
    expect(result.hard_pause).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("flags soft_warn when any soft threshold is reached", () => {
    const result = evaluateBudget(DEFAULT_AGENT_BUDGET, {
      cost_usd: DEFAULT_AGENT_BUDGET.soft.cost_usd,
      duration_ms: 0,
      num_turns: 0,
    });
    expect(result.soft_warn).toBe(true);
    expect(result.hard_pause).toBe(false);
    expect(result.reason).toContain("soft budget exceeded");
    expect(result.reason).toContain("cost");
  });

  it("flags soft_warn for duration crossing the threshold even when cost is unknown", () => {
    const result = evaluateBudget(DEFAULT_AGENT_BUDGET, {
      duration_ms: DEFAULT_AGENT_BUDGET.soft.duration_ms + 1,
      num_turns: 5,
    });
    expect(result.soft_warn).toBe(true);
    expect(result.hard_pause).toBe(false);
    expect(result.reason).toContain("duration");
  });

  it("flags hard_pause AND soft_warn when a hard threshold is crossed", () => {
    const result = evaluateBudget(DEFAULT_AGENT_BUDGET, {
      cost_usd: 0,
      duration_ms: DEFAULT_AGENT_BUDGET.hard.duration_ms,
      num_turns: 0,
    });
    expect(result.soft_warn).toBe(true);
    expect(result.hard_pause).toBe(true);
    expect(result.reason).toContain("hard budget exceeded");
    expect(result.reason).toContain("duration");
  });

  it("flags hard_pause on num_turns crossing the hard threshold", () => {
    const result = evaluateBudget(DEFAULT_AGENT_BUDGET, {
      num_turns: DEFAULT_AGENT_BUDGET.hard.num_turns + 1,
    });
    expect(result.hard_pause).toBe(true);
    expect(result.hard_reasons?.[0]).toMatchObject({ key: "num_turns" });
  });

  it("treats explicit zero caps as 'use the bundled default' so partial overrides don't disable enforcement", () => {
    // A user-side budget.json with zeros would otherwise let an agent run
    // forever; normalizeBudgetThresholds backfills zeros with the audit's
    // numbers so the runaway run still gets caught.
    const result = evaluateBudget(
      { soft: { cost_usd: 0 }, hard: { cost_usd: 0 } },
      { cost_usd: DEFAULT_AGENT_BUDGET.hard.cost_usd + 1, duration_ms: 0, num_turns: 0 },
    );
    expect(result.hard_pause).toBe(true);
  });

  it("a negative cap (treated as missing) is also backfilled with the bundled default", () => {
    const result = evaluateBudget(
      { soft: { cost_usd: -1, duration_ms: -1, num_turns: -1 } },
      { cost_usd: DEFAULT_AGENT_BUDGET.soft.cost_usd },
    );
    expect(result.soft_warn).toBe(true);
  });

  it("treats missing stats as 0 (no false positives)", () => {
    const result = evaluateBudget(DEFAULT_AGENT_BUDGET, {});
    expect(result.soft_warn).toBe(false);
    expect(result.hard_pause).toBe(false);
  });
});

describe("normalizeBudgetThresholds", () => {
  it("backfills missing fields from DEFAULT_AGENT_BUDGET", () => {
    const out = normalizeBudgetThresholds({ soft: { cost_usd: 7 } });
    expect(out.soft.cost_usd).toBe(7);
    expect(out.soft.duration_ms).toBe(DEFAULT_AGENT_BUDGET.soft.duration_ms);
    expect(out.hard.duration_ms).toBe(DEFAULT_AGENT_BUDGET.hard.duration_ms);
  });

  it("falls back to defaults on garbage input", () => {
    expect(normalizeBudgetThresholds(null)).toEqual(DEFAULT_AGENT_BUDGET);
    expect(normalizeBudgetThresholds("oops")).toEqual(DEFAULT_AGENT_BUDGET);
    expect(normalizeBudgetThresholds([])).toEqual(DEFAULT_AGENT_BUDGET);
  });
});

describe("loadAgentBudget", () => {
  it("returns the bundled defaults when no override file exists", () => {
    const dataDir = makeTmpDataDir();
    const result = loadAgentBudget({ agent: "no-such-agent", dataDir });
    expect(result.thresholds).toEqual(DEFAULT_AGENT_BUDGET);
    // A real default-file path exists in the repo data-template, so source
    // should resolve to that file (not the in-memory "default" sentinel).
    expect(result.source).toMatch(/_defaults[\\/]budget\.json$/);
  });

  it("reads a per-agent override from the data dir", () => {
    const dataDir = makeTmpDataDir();
    const dir = join(dataDir, "agents", "tight-agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "budget.json"), JSON.stringify({
      soft: { cost_usd: 1, duration_ms: 60_000, num_turns: 5 },
      hard: { cost_usd: 2, duration_ms: 120_000, num_turns: 10 },
    }));
    const result = loadAgentBudget({ agent: "tight-agent", dataDir });
    expect(result.thresholds.soft.cost_usd).toBe(1);
    expect(result.thresholds.hard.num_turns).toBe(10);
    expect(result.source).toContain(join("agents", "tight-agent", "budget.json"));
  });

  it("prefers the data-dir override over any per-agent template default", () => {
    const dataDir = makeTmpDataDir();
    const dir = join(dataDir, "agents", "runtime-engineer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "budget.json"), JSON.stringify({
      soft: { cost_usd: 99, duration_ms: 99, num_turns: 99 },
      hard: { cost_usd: 999, duration_ms: 999, num_turns: 999 },
    }));
    const result = loadAgentBudget({ agent: "runtime-engineer", dataDir });
    expect(result.thresholds.soft.cost_usd).toBe(99);
    expect(result.source).toContain(join(dataDir, "agents", "runtime-engineer", "budget.json"));
  });
});

describe("resolveBudgetSearchPaths", () => {
  it("orders paths data-dir → per-agent template → defaults", () => {
    const paths = resolveBudgetSearchPaths({ agent: "x", dataDir: "/tmp/data", repoRoot: "/repo" });
    expect(paths[0]).toBe("/tmp/data/agents/x/budget.json");
    expect(paths[1]).toBe("/repo/data-template/agents/x/budget.json");
    expect(paths[2]).toBe("/repo/data-template/agents/_defaults/budget.json");
  });

  it("omits the data-dir entry when no dataDir is provided", () => {
    const paths = resolveBudgetSearchPaths({ agent: "x", repoRoot: "/repo" });
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe("/repo/data-template/agents/x/budget.json");
  });

  it("omits agent-scoped entries when no agent is given", () => {
    const paths = resolveBudgetSearchPaths({ dataDir: "/tmp/data", repoRoot: "/repo" });
    expect(paths).toEqual(["/repo/data-template/agents/_defaults/budget.json"]);
  });
});
