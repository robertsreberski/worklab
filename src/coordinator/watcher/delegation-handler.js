// Delegation helpers used by the watcher when an agent returns
// decision=delegate with subtasks. Pure functions: heuristics for whether
// a stage's final text looks like a plan body, an in-memory cycle check
// across the freshly-delegated batch, and a builder that appends the
// child's acceptance criteria + expected artifact onto its instructions.
//
// The watcher's main loop owns the actual task creation + edge insertion.
//
// TODO(audit-followup): R6 — plan-driven parent_review_policy. When the
// planner delegates and the children include a `*-qa-*` agent, the audit
// recommends auto-applying `skip_when_qa_child` so the parent's review pass
// becomes redundant. Adding this requires:
//   - tasks.parent_review_policy column (default | skip_when_qa_child |
//     always_skip).
//   - worklab.v2 envelope plumb-through for the planner-requested policy.
//   - state-machine consult of the policy on children_completed.
//   - auto-approve of QA-child meta-reviews when executor === reviewer and
//     the executor's decision was advance/approve.
// Deferred because it touches the state-machine dispatch + warrants its own
// fixture-driven end-to-end coverage.

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
