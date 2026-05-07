export const DEFAULT_PLANNING_HARNESS = "balanced_polished";
export const DEFAULT_PLANNING_TOOL_POLICY = "read_only_shell_allowlist";

export const PLANNING_HARNESS_OPTIONS = [
  {
    value: "balanced_polished",
    label: "Balanced polished",
    description: "Research first, ask only blocking questions, and produce a compact decision-complete plan.",
  },
  {
    value: "fast_handoff",
    label: "Fast handoff",
    description: "Use a short implementation-ready plan for small or well-understood tasks.",
  },
  {
    value: "execplan_deep",
    label: "ExecPlan deep",
    description: "Write a self-contained plan with context, validation, recovery notes, and exact handoff detail.",
  },
  {
    value: "numbered_steps",
    label: "Numbered steps",
    description: "Use a numbered, completion-oriented plan with explicit acceptance checks.",
  },
  {
    value: "legacy",
    label: "Legacy",
    description: "Use the original Worklab planning directive with minimal extra harness guidance.",
  },
];

export const PLANNING_TOOL_POLICY_OPTIONS = [
  {
    value: "read_only_shell_allowlist",
    label: "Read-only shell",
    description: "Allow read/search/web tools and read-only shell inspection during plan-stage runs.",
  },
  {
    value: "read_only_no_shell",
    label: "No shell",
    description: "Allow read/search/web tools, but block write/edit and shell tools during planning.",
  },
  {
    value: "prompt_only",
    label: "Prompt only",
    description: "Keep the configured tool surface and rely on planning instructions for discipline.",
  },
];

const HARNESS_VALUES = new Set(PLANNING_HARNESS_OPTIONS.map((option) => option.value));
const TOOL_POLICY_VALUES = new Set(PLANNING_TOOL_POLICY_OPTIONS.map((option) => option.value));

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
const READ_ONLY_SHELL_TOOLS = [...READ_ONLY_TOOLS, "Bash"];

export function normalizePlanningHarness(value) {
  const text = String(value || "").trim();
  return HARNESS_VALUES.has(text) ? text : DEFAULT_PLANNING_HARNESS;
}

export function normalizePlanningToolPolicy(value) {
  const text = String(value || "").trim();
  return TOOL_POLICY_VALUES.has(text) ? text : DEFAULT_PLANNING_TOOL_POLICY;
}

export function validatePlanningHarnessSetting(key, value) {
  const text = String(value || "").trim();
  if (!HARNESS_VALUES.has(text)) {
    throw new Error(`${key} must be one of: ${PLANNING_HARNESS_OPTIONS.map((option) => option.value).join(", ")}`);
  }
  return text;
}

export function validatePlanningToolPolicySetting(key, value) {
  const text = String(value || "").trim();
  if (!TOOL_POLICY_VALUES.has(text)) {
    throw new Error(`${key} must be one of: ${PLANNING_TOOL_POLICY_OPTIONS.map((option) => option.value).join(", ")}`);
  }
  return text;
}

function harnessLabel(value) {
  return PLANNING_HARNESS_OPTIONS.find((option) => option.value === value)?.label || value;
}

function toolPolicyGuidance(policy) {
  if (policy === "read_only_no_shell") {
    return [
      "Forbidden during planning: Write, Edit, and Bash.",
      "Use Read, Glob, Grep, WebFetch, and WebSearch for evidence gathering.",
    ].join("\n");
  }
  if (policy === "prompt_only") {
    return [
      "Planning tool restrictions are prompt-only for this run.",
      "Do not edit files or perform implementation work during planning, even if write-capable tools are visible.",
    ].join("\n");
  }
  return [
    "Forbidden during planning: Write and Edit.",
    "Bash is limited to read-only inspection commands such as pwd, ls, find, rg, grep, sed, awk, cat, head, tail, wc, git status, git diff, git log, git show, git branch, git rev-parse, and git ls-files.",
  ].join("\n");
}

export function formatPlanningHarnessSection(settings = {}) {
  const harness = normalizePlanningHarness(settings.planning_harness);
  const policy = normalizePlanningToolPolicy(settings.planning_tool_policy);
  const displayLabel = harness === "execplan_deep" ? "ExecPlan deep" : harnessLabel(harness).toLowerCase();
  const lines = [
    `Harness: ${displayLabel}.`,
    toolPolicyGuidance(policy),
  ];

  if (harness === "fast_handoff") {
    lines.push(
      "Optimize for a short handoff: explain the goal, the direct edits, the tests, and the assumptions.",
      "Ask questions only when a wrong default would materially change the implementation.",
    );
  } else if (harness === "execplan_deep") {
    lines.push(
      "Write a self-contained ExecPlan that another agent can execute without re-deciding architecture.",
      "Include context, exact implementation approach, validation commands, recovery notes, and completion criteria.",
    );
  } else if (harness === "numbered_steps") {
    lines.push(
      "Use numbered steps with clear completion checks and explicit commit boundaries when repository workflow requires commits.",
      "Keep each step independently verifiable.",
    );
  } else if (harness === "legacy") {
    lines.push("Use the original Worklab planning shape with minimal extra structure.");
  } else {
    lines.push(
      "Research first, then produce a polished, decision-complete implementation plan.",
      "Use these sections: Summary, Key Changes, API/interfaces/types, Test Plan, and Assumptions.",
      "Prefer concise grouped behavior-level bullets over long file inventories.",
    );
  }

  return lines.join("\n");
}

function planJsonContract() {
  return `{
  "schema": "worklab.v2",
  "stage": "plan",
  "decision": "advance",
  "summary": "Short outcome.",
  "details": "Complete implementation plan.",
  "final_text": "Short human-facing plan status.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "questions": [],
  "subtasks": [],
  "parent_review_policy": null,
  "memory_candidates": [],
  "verification_evidence": []
}`;
}

function planDirectiveBody(harness) {
  if (harness === "fast_handoff") {
    return "Plan this task. Keep the plan compact and directly executable: what changes, what interfaces move, what tests prove it, and what assumptions are locked.";
  }
  if (harness === "execplan_deep") {
    return "Plan this task as a self-contained ExecPlan. Include enough context, sequencing, verification commands, and recovery notes that another agent can execute it without asking architectural questions.";
  }
  if (harness === "numbered_steps") {
    return "Plan this task as numbered steps. Each step must have a clear done condition, expected artifact, and verification note.";
  }
  if (harness === "legacy") {
    return "Plan this task. Clarify the work, identify risks, and decide whether to proceed directly or delegate bounded subtasks.";
  }
  return "Plan this task. Do not implement it. Clarify the work, identify risks, and write a polished plan that is decision-complete for the executor.";
}

export function buildPlanningDirective(settings = {}) {
  const harness = normalizePlanningHarness(settings.planning_harness);
  return `${planDirectiveBody(harness)} Do not do implementation work during planning.

When repository instructions require commits, include explicit granular commit expectations in the implementation plan and in any delegated subtask instructions. Keep delegated subtasks bounded so each child can commit its own coherent changes without bundling unrelated work.

Return a structured Worklab result as JSON when you finish:

${planJsonContract()}

Do not emit this JSON object for interim planning progress or status updates. Use normal progress text, journal notes, todos, or tool calls until the final result is ready.

Use decision "advance" when the plan is ready and the task should move to work, "delegate" when bounded subtasks should be created, "pause" when explicit human input is required, and "block" when you cannot continue.`;
}

function mergeDisallowed(disallowedTools, additions) {
  return [...new Set([...(disallowedTools || []), ...additions])];
}

function intersectAllowed(allowedTools, allowedNames) {
  if (!Array.isArray(allowedTools)) return allowedNames;
  return allowedTools.filter((tool) => allowedNames.includes(tool));
}

export function applyPlanningToolPolicy({ mode, settings = {}, allowedTools = [], disallowedTools = [] } = {}) {
  const harness = normalizePlanningHarness(settings.planning_harness);
  const policy = normalizePlanningToolPolicy(settings.planning_tool_policy);
  if (mode !== "plan" || policy === "prompt_only") {
    return {
      allowedTools,
      disallowedTools,
      toolPolicy: { planning: mode === "plan", harness, policy, bashReadOnly: false },
      diagnostics: { harness, tool_policy: policy, enforceable: false },
    };
  }

  if (policy === "read_only_no_shell") {
    return {
      allowedTools: intersectAllowed(allowedTools, READ_ONLY_TOOLS),
      disallowedTools: mergeDisallowed(disallowedTools, ["Write", "Edit", "Bash"]),
      toolPolicy: { planning: true, harness, policy, bashReadOnly: false },
      diagnostics: { harness, tool_policy: policy, enforceable: true },
    };
  }

  return {
    allowedTools: intersectAllowed(allowedTools, READ_ONLY_SHELL_TOOLS),
    disallowedTools: mergeDisallowed(disallowedTools, ["Write", "Edit"]),
    toolPolicy: { planning: true, harness, policy, bashReadOnly: true },
    diagnostics: { harness, tool_policy: policy, enforceable: true },
  };
}
