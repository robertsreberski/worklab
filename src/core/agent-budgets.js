// Per-agent run budgets (A3). Loads soft + hard thresholds for a single run
// from one of three sources, in order of precedence:
//   1. <dataDir>/agents/<agent>/budget.json   (operator-installed override)
//   2. <repoRoot>/data-template/agents/<agent>/budget.json (per-agent default
//      shipped with the repo, if any)
//   3. <repoRoot>/data-template/agents/_defaults/budget.json (catch-all
//      defaults baked in from the runtime audit; the source of truth for any
//      agent that doesn't have its own file)
//
// `evaluateBudget(thresholds, runStats)` is a pure helper: given the thresholds
// object returned by `loadAgentBudget()` and the live stats `{ cost_usd,
// duration_ms, num_turns }`, it returns `{ soft_warn, hard_pause, reason? }`.
//
// The runtime data dir mirrors the data-template layout (see
// `src/core/first-boot.js#seedDataFromTemplate`), so once an installation has
// run once the user-side path is the canonical location. The data-template
// fallback is what makes test fixtures and fresh installs work without
// requiring a populated data dir.
//
// Soft → spawn-worker emits a `runtime_warning` with `warning_kind:
// "budget_soft"` and the watcher posts a system comment. Hard → the run is
// cancelled with `cancel_initiator: "budget"` so failure-classifier maps the
// failure_kind to `budget_exceeded` (already in FAILURE_KINDS).
//
// Module boundary: src/core, may use src/agent and src/ai. No DB writes.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_FROM_SELF = resolve(SELF_DIR, "..", "..");

// Bundled defaults (Phase 8 / A3). Mirrored on disk as
// data-template/agents/_defaults/budget.json so operators can copy + edit a
// single file rather than reaching into source. Numbers come straight from the
// audit's implementation plan; do not invent new ones without updating the
// plan.
export const DEFAULT_AGENT_BUDGET = Object.freeze({
  soft: Object.freeze({ cost_usd: 5, duration_ms: 1_200_000, num_turns: 150 }),
  hard: Object.freeze({ cost_usd: 20, duration_ms: 3_600_000, num_turns: 300 }),
});

const TIER_KEYS = ["soft", "hard"];
const STAT_KEYS = ["cost_usd", "duration_ms", "num_turns"];

// We treat 0 (and any non-positive value) as "absent — fall back to the
// bundled default". A user-side budget.json that explicitly sets a cap to 0
// would otherwise silently disable the guardrail. The audit's whole point is
// to *prevent* runaway runs, so the conservative interpretation wins.
function isPositiveFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function readJsonFileSafe(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Coerce a raw object (from JSON or DEFAULT_AGENT_BUDGET) into a frozen
// thresholds shape with both tiers fully populated. Missing or non-numeric
// fields fall back to DEFAULT_AGENT_BUDGET so a partial override file doesn't
// silently disable other thresholds.
export function normalizeBudgetThresholds(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const tier of TIER_KEYS) {
    const tierSource = source[tier] && typeof source[tier] === "object" && !Array.isArray(source[tier])
      ? source[tier]
      : {};
    const tierOut = {};
    for (const key of STAT_KEYS) {
      const candidate = tierSource[key];
      tierOut[key] = isPositiveFinite(candidate) ? Number(candidate) : DEFAULT_AGENT_BUDGET[tier][key];
    }
    out[tier] = Object.freeze(tierOut);
  }
  return Object.freeze(out);
}

// Resolve the on-disk paths we will probe to find a budget file for `agent`.
// Exposed for tests (and the audit log) so we can assert ordering without
// reaching into private state. Order: dataDir override → per-agent template →
// repo-wide default.
export function resolveBudgetSearchPaths({ agent, dataDir, repoRoot } = {}) {
  const slug = String(agent || "").trim();
  const root = repoRoot ? resolve(repoRoot) : REPO_ROOT_FROM_SELF;
  const paths = [];
  if (slug && dataDir) {
    paths.push(join(resolve(dataDir), "agents", slug, "budget.json"));
  }
  if (slug) {
    paths.push(join(root, "data-template", "agents", slug, "budget.json"));
  }
  paths.push(join(root, "data-template", "agents", "_defaults", "budget.json"));
  return paths;
}

// loadAgentBudget walks the search paths and returns the first parseable
// budget JSON, normalised against DEFAULT_AGENT_BUDGET. Always returns a
// thresholds object (never null), so callers can use evaluateBudget without
// further null-checks. The `source` field in the return value is the path
// that resolved (or "default" for the baked-in fallback).
export function loadAgentBudget({ agent, dataDir, repoRoot } = {}) {
  const paths = resolveBudgetSearchPaths({ agent, dataDir, repoRoot });
  for (const path of paths) {
    const raw = readJsonFileSafe(path);
    if (raw) {
      return { thresholds: normalizeBudgetThresholds(raw), source: path };
    }
  }
  return { thresholds: normalizeBudgetThresholds(null), source: "default" };
}

function exceedsAny(stats, tier) {
  const reasons = [];
  for (const key of STAT_KEYS) {
    const stat = Number(stats?.[key]);
    const cap = Number(tier?.[key]);
    if (!Number.isFinite(cap) || cap <= 0) continue;
    if (Number.isFinite(stat) && stat >= cap) {
      reasons.push({ key, value: stat, cap });
    }
  }
  return reasons;
}

function formatReasonText(tierLabel, reasons) {
  if (!reasons.length) return null;
  const labels = reasons
    .map(({ key, value, cap }) => {
      if (key === "cost_usd") return `cost $${value.toFixed(2)} ≥ $${Number(cap).toFixed(2)}`;
      if (key === "duration_ms") return `duration ${Math.round(value / 1000)}s ≥ ${Math.round(Number(cap) / 1000)}s`;
      return `turns ${value} ≥ ${Number(cap)}`;
    })
    .join(", ");
  return `${tierLabel} budget exceeded: ${labels}`;
}

// evaluateBudget(thresholds, runStats) — pure. The watcher / spawn-worker calls
// it on every tool_result event; runStats is the live aggregate at that
// moment. soft_warn fires once when any soft threshold is hit; hard_pause is
// the stronger signal that triggers a cancel. When BOTH tiers are exceeded we
// return hard_pause=true (and soft_warn=true as well, so the call site can
// still emit the warning before cancelling — the watcher de-dupes by tracking
// whether it has already emitted a soft warning for this run).
export function evaluateBudget(thresholds, runStats) {
  const normalized = normalizeBudgetThresholds(thresholds);
  const stats = runStats && typeof runStats === "object" ? runStats : {};

  const hardReasons = exceedsAny(stats, normalized.hard);
  const softReasons = exceedsAny(stats, normalized.soft);

  const result = {
    soft_warn: softReasons.length > 0,
    hard_pause: hardReasons.length > 0,
  };
  const reasonText = hardReasons.length
    ? formatReasonText("hard", hardReasons)
    : softReasons.length
      ? formatReasonText("soft", softReasons)
      : null;
  if (reasonText) result.reason = reasonText;
  if (hardReasons.length) result.hard_reasons = hardReasons;
  if (softReasons.length) result.soft_reasons = softReasons;
  return result;
}
