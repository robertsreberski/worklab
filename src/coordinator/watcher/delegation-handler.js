// Delegation helpers used by the watcher when an agent returns
// decision=delegate with subtasks. Pure functions: heuristics for whether
// a stage's final text looks like a plan body, an in-memory cycle check
// across the freshly-delegated batch, a builder that appends the child's
// acceptance criteria + expected artifact onto its instructions, the R6
// parent_review_policy resolution helpers, and the R9 per-project agent
// allowlist enforcement.
//
// The watcher's main loop owns the actual task creation + edge insertion.
//
// A3 — per-agent run-budget warnings — shipped: see src/core/agent-budgets.js
// (evaluateBudget + loadAgentBudget) wired through src/coordinator/spawn-worker.js
// (budget aggregator runs on every tool_result event; soft → runtime_warning
// + system comment, hard → cancel with cancel_initiator="budget" so
// classifyFailure maps to budget_exceeded). Per-agent thresholds live in
// data-template/agents/_defaults/budget.json (or a per-agent override
// under data-template/agents/<agent>/budget.json or
// <dataDir>/agents/<agent>/budget.json).

import { PARENT_REVIEW_POLICIES } from "../../core/state-machine.js";
import { agentNameAllowedByPatterns } from "../../core/projects.js";

const QA_AGENT_PATTERN = /qa|review/i;

// R6: a child counts as a QA/review-style agent when its name (or, lacking
// an agent assignment, its title/instructions) matches the QA pattern. This
// is intentionally permissive — `benchmark-qa-reviewer`, `mobile-qa`, and
// `code-reviewer` should all trip the skip-parent-review heuristic.
export function isQaChildAgent(agentName) {
  return QA_AGENT_PATTERN.test(String(agentName || ""));
}

// True when at least one of the freshly-delegated subtasks targets a QA
// agent. Falls back to scanning the subtask title when `suggested_agent`
// is missing — a planner that names "QA the result" without picking the
// agent still telegraphs intent.
export function delegationHasQaChild(subtasks) {
  if (!Array.isArray(subtasks)) return false;
  return subtasks.some((subtask) => {
    if (!subtask) return false;
    const agent = String(subtask.suggested_agent || "").trim();
    if (agent && isQaChildAgent(agent)) return true;
    const title = String(subtask.title || "").trim();
    return title.length > 0 && QA_AGENT_PATTERN.test(title);
  });
}

// Resolve the parent_review_policy for a freshly-delegated round. The
// planner's explicit choice wins (when it's a recognised value); otherwise
// the watcher derives `skip_when_qa_child` for any delegation that includes
// a QA-style child, or `default` when no QA child is present.
export function resolveParentReviewPolicy({ requested, subtasks } = {}) {
  const requestedValue = typeof requested === "string" ? requested.trim() : "";
  if (PARENT_REVIEW_POLICIES.includes(requestedValue)) return requestedValue;
  if (delegationHasQaChild(subtasks)) return "skip_when_qa_child";
  return "default";
}

// R9: enforce the per-project agent allowlist. The watcher resolves the
// project's allowlist + delegation_allow_unlisted flag before calling this;
// passing `null` (no project, or project lookup miss) means "no project
// scope, anything goes". An empty allowlist also falls through to "any
// agent" — that's the back-compat default for projects that haven't been
// configured yet. When unlisted agents are present and the override is off,
// returns `{ ok: false, failureKind: "delegation_agent_not_allowed", ... }`
// so the caller can fail-fast. With the override on (e.g. project with
// delegation_allow_unlisted=1 or the bundled _defaults.json), returns
// `{ ok: true, warnings: [...] }` so the caller records a non-fatal
// warning + continues.
export function enforceProjectAgentAllowlist({
  subtasks,
  parentOwnerAgent,
  projectAllowlist,
} = {}) {
  if (!projectAllowlist) return { ok: true, warnings: [] };
  const allowed = Array.isArray(projectAllowlist.allowed_agents)
    ? projectAllowlist.allowed_agents
    : [];
  if (allowed.length === 0) return { ok: true, warnings: [] };
  const items = Array.isArray(subtasks) ? subtasks : [];
  const offenders = [];
  const seen = new Set();
  for (const subtask of items) {
    const candidate = String(subtask?.suggested_agent || parentOwnerAgent || "").trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!agentNameAllowedByPatterns(candidate, allowed)) offenders.push(candidate);
  }
  if (offenders.length === 0) return { ok: true, warnings: [] };
  const allowList = allowed.map((pattern) => `"${pattern}"`).join(", ");
  const offenderList = offenders.map((name) => `"${name}"`).join(", ");
  const message = offenders.length === 1
    ? `agent ${offenderList} is not in the project allowlist [${allowList}]`
    : `agents ${offenderList} are not in the project allowlist [${allowList}]`;
  if (projectAllowlist.delegation_allow_unlisted) {
    return {
      ok: true,
      warnings: [{
        kind: "delegation_unlisted_agent",
        message: `Delegation outside project allowlist permitted (delegation_allow_unlisted=true): ${message}.`,
        offenders,
        allowed,
      }],
    };
  }
  return {
    ok: false,
    failureKind: "delegation_agent_not_allowed",
    error: `delegation outside project allowlist: ${message}`,
    offenders,
    allowed,
  };
}

export function looksLikePlanBody(text) {
  const body = String(text || "").trim();
  if (!body) return false;
  const sectionNames = "(?:Plan|Implementation Plan|Test Plan|Approach|Implementation|Risks?|Caveats?|Out of scope)";
  return new RegExp(`^#{1,3}\\s+${sectionNames}(?:\\s*[:\\-].*|\\s*)$`, "im").test(body)
    || new RegExp(`^\\*\\*${sectionNames}(?:\\*\\*|\\s*[:\\-])`, "im").test(body)
    || new RegExp(`^${sectionNames}\\s*:`, "im").test(body);
}

// In-memory cycle check across a freshly-delegated batch of subtasks. Each
// subtask references siblings by title (or by external task id, which we
// ignore for the within-batch cycle check). DFS with three-color marks.
export function detectSubtaskCycles(subtasks) {
  const titleToIndex = new Map();
  subtasks.forEach((subtask, index) => {
    const title = (subtask?.title || "").trim();
    if (title) titleToIndex.set(title, index);
  });
  const graph = subtasks.map((subtask) => {
    const deps = Array.isArray(subtask?.depends_on) ? subtask.depends_on : [];
    return deps
      .map((dep) => titleToIndex.get((dep || "").trim()))
      .filter((index) => typeof index === "number");
  });
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(subtasks.length).fill(WHITE);
  function visit(i) {
    if (color[i] === GRAY) return true;
    if (color[i] === BLACK) return false;
    color[i] = GRAY;
    for (const j of graph[i]) if (visit(j)) return true;
    color[i] = BLACK;
    return false;
  }
  for (let i = 0; i < subtasks.length; i += 1) {
    if (color[i] === WHITE && visit(i)) return true;
  }
  return false;
}

export function appendDelegationDoneCriteria(instructions, subtask) {
  const parts = [String(instructions || "").trim()].filter(Boolean);
  const acceptance = Array.isArray(subtask?.acceptance_criteria)
    ? subtask.acceptance_criteria.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (acceptance.length) {
    parts.push(`Acceptance criteria:\n- ${acceptance.join("\n- ")}`);
  }
  const artifact = String(subtask?.expected_artifact || "").trim();
  if (artifact) {
    parts.push(`Expected artifact: ${artifact}`);
  }
  return parts.join("\n\n");
}
