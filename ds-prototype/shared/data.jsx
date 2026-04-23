// Shared mock data — agentic task manager.
// Tasks carry live events + activity (runs, human comments, AGENT comments, handoffs).
// Also exports agents (with full editor fields), skills, kb entries, schedules.

// ---------- AGENTS ----------
// Core pool used by Commander / Detail / Schedules.
const AGENTS = [
  { slug: 'atlas',   name: 'Atlas',   role: 'executor', color: '#9fb8ff', avatar: 'A', model: 'claude-sonnet-4.5', title: 'Senior engineer' },
  { slug: 'hazel',   name: 'Hazel',   role: 'executor', color: '#63d0c3', avatar: 'H', model: 'claude-haiku-4.5',  title: 'Quick fixer' },
  { slug: 'garnet',  name: 'Garnet',  role: 'reviewer', color: '#c6a6ff', avatar: 'G', model: 'gpt-5',             title: 'Code reviewer' },
  { slug: 'otis',    name: 'Otis',    role: 'executor', color: '#ff9cc1', avatar: 'O', model: 'o4-mini-high',      title: 'Architect' },
  { slug: 'quill',   name: 'Quill',   role: 'executor', color: '#e5c36b', avatar: 'Q', model: 'qwen-3-local',      title: 'Local scribe' },
  { slug: 'piper',   name: 'Piper',   role: 'reviewer', color: '#6ad69d', avatar: 'P', model: 'claude-haiku-4.5',  title: 'Peer reviewer' },
];
const agentBySlug = Object.fromEntries(AGENTS.map(a => [a.slug, a]));

// Extended agent rows for the Agents registry. Each references a core slug and
// adds: display_name, description, sdk, model_id (full), effort, instructions,
// skills_allowlist, mcp_allowlist, builtin_allowlist, enabled, last stats.
const AGENTS_EX = [
  {
    slug: 'atlas', display_name: 'Atlas',
    description: 'Senior engineer. Default executor for hard refactors and tricky debugging.',
    sdk: 'claude', model_id: 'claude:claude-sonnet-4-6', effort: 'high',
    instructions:
`You are a senior engineer on the Worklab platform team.
- Reproduce before you fix. Write a failing test first when possible.
- Keep diffs small and scoped. One concept per commit.
- When you hand off to a reviewer, post a concise summary: what changed, what was tested, what remains.`,
    skills_allowlist: ['repro-first', 'code-surgery', 'testcraft'],
    mcp_allowlist: ['github', 'linear'],
    builtin_allowlist: ['Read','Write','Edit','Grep','Bash'],
    enabled: true,
    lastRunAt: Date.now() - 60_000 * 2,
    runsLast30: 184, avgDurationMs: 640_000,
  },
  {
    slug: 'hazel', display_name: 'Hazel',
    description: 'Fast executor for small, well-scoped tasks. Good at docs and quick fixes.',
    sdk: 'claude', model_id: 'claude:claude-haiku-4-5', effort: 'medium',
    instructions:
`Be fast. Prefer small diffs. If the task is larger than ~10 min of engineering work, pause and ask to be reassigned to Atlas or Otis.`,
    skills_allowlist: [], // open -> inherits all enabled skills
    mcp_allowlist: ['github'],
    builtin_allowlist: ['Read','Write','Edit','Grep'],
    enabled: true,
    lastRunAt: Date.now() - 60_000 * 0.5,
    runsLast30: 412, avgDurationMs: 78_000,
  },
  {
    slug: 'garnet', display_name: 'Garnet',
    description: 'Reviewer. Reads diffs carefully; flags missing tests, unsafe casts, and hidden coupling.',
    sdk: 'openai', model_id: 'openai:gpt-5', effort: 'high',
    instructions:
`You are a reviewer. Do not write code. Output:
  1. One-line verdict (approve / request changes / block).
  2. Up to 5 prioritized comments with file:line anchors.
  3. A single follow-up task if the change suggests more work.`,
    skills_allowlist: ['review-diff', 'test-coverage-check'],
    mcp_allowlist: ['github'],
    builtin_allowlist: ['Read','Grep'],
    enabled: true,
    lastRunAt: Date.now() - 60_000 * 14,
    runsLast30: 96, avgDurationMs: 320_000,
  },
  {
    slug: 'otis', display_name: 'Otis',
    description: 'Architect. Use for cross-cutting refactors and service-boundary changes.',
    sdk: 'openai', model_id: 'openai:o4-mini-high', effort: 'xhigh',
    instructions:
`You are an architect. Before touching code, write a one-page plan:
  - Current state
  - Proposed state
  - Migration sequence
  - Rollback plan
Only start coding after a human approves the plan.`,
    skills_allowlist: ['design-doc', 'migration-plan'],
    mcp_allowlist: ['github', 'linear'],
    builtin_allowlist: ['Read','Grep','WebSearch','WebFetch'],
    enabled: true,
    lastRunAt: Date.now() - 60_000 * 60 * 3,
    runsLast30: 38, avgDurationMs: 1_810_000,
  },
  {
    slug: 'quill', display_name: 'Quill',
    description: 'Local-only scribe. Handles doc work and small type-tightening that should not leave the machine.',
    sdk: 'local', model_id: 'local:qwen-3-14b', effort: 'medium',
    instructions:
`You run locally. Do not call any network tools. Prefer small, documentation-shaped changes.`,
    skills_allowlist: ['docs-sweep'],
    mcp_allowlist: [],
    builtin_allowlist: ['Read','Edit','Grep'],
    enabled: true,
    lastRunAt: Date.now() - 60_000 * 60 * 22,
    runsLast30: 24, avgDurationMs: 140_000,
  },
  {
    slug: 'piper', display_name: 'Piper',
    description: 'Peer reviewer. Faster than Garnet for low-risk diffs; good for docs and type-only changes.',
    sdk: 'claude', model_id: 'claude:claude-haiku-4-5', effort: 'medium',
    instructions:
`You are a peer reviewer for low-risk changes. Be terse. If you see anything non-trivial, request Garnet.`,
    skills_allowlist: ['review-diff'],
    mcp_allowlist: ['github'],
    builtin_allowlist: ['Read','Grep'],
    enabled: false, // paused
    lastRunAt: Date.now() - 60_000 * 60 * 24 * 4,
    runsLast30: 11, avgDurationMs: 92_000,
  },
];
const agentExBySlug = Object.fromEntries(AGENTS_EX.map(a => [a.slug, a]));

// ---------- TASKS ----------
// No subtasks. Every task that has run will collect comments from the agents
// who ran it (posted automatically at run end) plus any human comments.
const TASKS = [
  {
    id: 'WRK-812', title: 'Fix flaky test in auth integration suite',
    description: 'Intermittent failure in refresh-token rotation test — timing race between mock clock and expiry check.',
    status: 'in_progress', executor: 'atlas', reviewer: 'garnet',
    retries: 2, errorText: null,
    runDurationMs: 214_000, tokensIn: 18_420, tokensOut: 3_140, costUsd: 0.21, turns: 11,
    updatedAt: Date.now() - 60_000 * 2,
    dependsOn: [],
    liveEvents: [
      { t: -28, kind: 'tool', name: 'read_file', arg: 'auth/refreshToken.ts' },
      { t: -22, kind: 'think', text: 'The mock clock advances before the debounce handler registers — there is a 5ms window.' },
      { t: -15, kind: 'tool', name: 'grep', arg: 'jest.useFakeTimers' },
      { t: -9,  kind: 'tool', name: 'edit', arg: 'auth.integration.spec.ts', detail: '+await flushMicrotasks()' },
      { t: -4,  kind: 'tool', name: 'run_tests', arg: 'auth.integration' },
      { t: -1,  kind: 'think', text: 'Running the suite 20× to confirm no flake...' },
    ],
    currentStep: 'Verifying fix across 20 iterations',
  },
  {
    id: 'WRK-809', title: 'Refactor auth module to use async iterators',
    description: 'Replace callback-based token stream with async generators; unblock SSE migration downstream.',
    status: 'in_review', executor: 'otis', reviewer: 'garnet',
    retries: 0, errorText: null,
    runDurationMs: 1_842_000, tokensIn: 94_210, tokensOut: 21_080, costUsd: 1.84, turns: 34,
    updatedAt: Date.now() - 60_000 * 14,
    dependsOn: [],
    liveEvents: [
      { t: -6, kind: 'handoff', text: 'Executor → Reviewer · diff 14 files' },
      { t: -4, kind: 'tool', name: 'review_diff', arg: '14 files' },
      { t: -2, kind: 'think', text: 'Checking backpressure semantics on the new generator...' },
    ],
    currentStep: 'Reviewer reading the diff',
  },
  {
    id: 'WRK-806', title: 'Add rate-limit headers to completions endpoint',
    description: 'Emit X-RateLimit-{Remaining,Reset,Limit}. Match Anthropic spec exactly.',
    status: 'in_progress', executor: 'hazel', reviewer: 'piper',
    retries: 0, errorText: null,
    runDurationMs: 42_000, tokensIn: 6_210, tokensOut: 980, costUsd: 0.04, turns: 4,
    updatedAt: Date.now() - 60_000 * 0.5,
    dependsOn: ['WRK-809'],
    liveEvents: [
      { t: -12, kind: 'tool', name: 'read_file', arg: 'middleware/ratelimit.ts' },
      { t: -5, kind: 'tool', name: 'edit', arg: 'middleware/ratelimit.ts', detail: '+res.setHeader(...)' },
      { t: -1, kind: 'think', text: 'Writing tests for reset timestamp format.' },
    ],
    currentStep: 'Writing tests',
  },
  {
    id: 'WRK-801', title: 'Migrate feature flags from LaunchDarkly to local config',
    description: 'Cost reduction; local config loads from S3 on boot, hot-reload every 60s.',
    status: 'error', executor: 'atlas', reviewer: 'garnet',
    retries: 3,
    errorText: 'Reviewer rejected 2× — missing rollout percentage field. Escalated.',
    runDurationMs: 3_410_000, tokensIn: 182_000, tokensOut: 44_200, costUsd: 3.92, turns: 61,
    updatedAt: Date.now() - 60_000 * 42,
    dependsOn: [],
    liveEvents: [],
    currentStep: 'Blocked · awaiting human',
  },
  {
    id: 'WRK-798', title: 'Extract billing router into standalone service',
    description: 'Part of the monolith-dissolution milestone. Keep interface stable; wrap in BFF.',
    status: 'todo', executor: 'otis', reviewer: 'garnet',
    retries: 0, errorText: null,
    runDurationMs: null, tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0,
    updatedAt: Date.now() - 60_000 * 60 * 3,
    dependsOn: ['WRK-812', 'WRK-809'],
    liveEvents: [],
    currentStep: 'Queued · waiting on 2 tasks',
  },
  {
    id: 'WRK-795', title: 'Document all public SDK types',
    description: 'TSDoc on every exported symbol. Produce API markdown via typedoc.',
    status: 'in_progress', executor: 'hazel', reviewer: null,
    retries: 0, errorText: null,
    runDurationMs: 614_000, tokensIn: 41_200, tokensOut: 18_900, costUsd: 0.41, turns: 22,
    updatedAt: Date.now() - 60_000 * 1,
    dependsOn: [],
    liveEvents: [
      { t: -8, kind: 'tool', name: 'read_file', arg: 'types/index.ts' },
      { t: -3, kind: 'tool', name: 'edit', arg: 'types/index.ts', detail: '+TSDoc for Run' },
      { t: -1, kind: 'think', text: 'Two more symbols to cover...' },
    ],
    currentStep: 'Annotating exports (74 of 96)',
  },
  {
    id: 'WRK-790', title: 'Dedupe run events in SSE stream',
    description: 'Clients see duplicate tool_start events on reconnect. Dedupe by event id.',
    status: 'done', executor: 'atlas', reviewer: 'garnet',
    retries: 1, errorText: null,
    runDurationMs: 392_000, tokensIn: 22_100, tokensOut: 4_600, costUsd: 0.28, turns: 12,
    updatedAt: Date.now() - 60_000 * 60 * 26,
    dependsOn: [],
    liveEvents: [],
    currentStep: 'Shipped',
  },
  {
    id: 'WRK-784', title: 'Investigate OOM on worker-08 during embedding backfill',
    description: 'Heap climbs to 14GB. Happens only on ~12k-token batches. Profile + fix.',
    status: 'todo', executor: null, reviewer: null,
    retries: 0, errorText: null,
    runDurationMs: null, tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0,
    updatedAt: Date.now() - 60_000 * 60 * 6,
    dependsOn: [],
    liveEvents: [],
    currentStep: 'Needs executor',
  },
  {
    id: 'WRK-780', title: 'Add JSON output mode to CLI runner',
    description: 'Machine-readable run summary for CI pipelines.',
    status: 'done', executor: 'quill', reviewer: 'piper',
    retries: 0, errorText: null,
    runDurationMs: 128_000, tokensIn: 8_100, tokensOut: 2_200, costUsd: 0.09, turns: 7,
    updatedAt: Date.now() - 60_000 * 60 * 72,
    dependsOn: [],
    liveEvents: [],
    currentStep: 'Shipped',
  },
  {
    id: 'WRK-776', title: 'Tighten types in knowledge-base indexer',
    description: 'Replace `any` with precise types. Should yield no runtime change.',
    status: 'in_review', executor: 'quill', reviewer: 'piper',
    retries: 0, errorText: null,
    runDurationMs: 94_000, tokensIn: 5_800, tokensOut: 1_100, costUsd: 0.06, turns: 5,
    updatedAt: Date.now() - 60_000 * 24,
    dependsOn: [],
    liveEvents: [
      { t: -3, kind: 'handoff', text: 'Executor → Reviewer · diff 3 files' },
      { t: -1, kind: 'tool', name: 'review_diff', arg: '3 files' },
    ],
    currentStep: 'Reviewer checking',
  },
];
const taskById = Object.fromEntries(TASKS.map(t => [t.id, t]));

// ---------- STATUSES ----------
const STATUSES = [
  { id: 'todo',        label: 'Todo',       color: 'var(--teal)',   icon: '○' },
  { id: 'in_progress', label: 'In progress',color: 'var(--yellow)', icon: '◐' },
  { id: 'in_review',   label: 'In review',  color: 'var(--accent)', icon: '◉' },
  { id: 'done',        label: 'Done',       color: 'var(--green)',  icon: '●' },
  { id: 'error',       label: 'Blocked',    color: 'var(--red)',    icon: '▲' },
];
const statusById = Object.fromEntries(STATUSES.map(s => [s.id, s]));

// ---------- ACTIVITY FEED ----------
// Top-level kinds: system, human (system-like event about a human action),
// comment (by a human OR an agent), run (collapsible, with steps), handoff.
// Comment shape: { kind:'comment', authorKind:'human'|'agent', author, text }
function buildActivity(task) {
  const now = task.updatedAt;
  const ex = task.executor || 'atlas';
  const rv = task.reviewer || 'garnet';
  return [
    { id: 's1', t: now - 60_000 * 60 * 6,   kind: 'system', text: 'Task created by @maria' },
    { id: 'h1', t: now - 60_000 * 60 * 5.8, kind: 'human',  author: 'maria', text: `Assigned executor · ${agentBySlug[ex]?.name}` },
    {
      id: 'r1', kind: 'run', t: now - 60_000 * 60 * 5,
      endedAt: now - 60_000 * 60 * 4.2,
      agent: ex, status: 'complete',
      durationMs: 780_000, turns: 18, tokensIn: 14_200, tokensOut: 2_800, costUsd: 0.11,
      summary: 'Reproduced the flake and narrowed the race window to 5ms.',
      steps: [
        { t: now - 60_000 * 60 * 5,       kind: 'tool_call', tool: 'read_file', arg: 'auth/refreshToken.ts' },
        { t: now - 60_000 * 60 * 4.95,    kind: 'agent_think', text: 'Scanning the test file and its dependencies to reproduce the flake locally.' },
        { t: now - 60_000 * 60 * 4.8,     kind: 'tool_call', tool: 'run_tests', arg: 'auth.integration --repeat 50', result: '3 failures in 50 runs' },
        { t: now - 60_000 * 60 * 4.6,     kind: 'agent_think', text: 'Mock clock advances before the debounce handler registers — there is a 5ms window where the token is considered expired before the refresh can fire.' },
        { t: now - 60_000 * 60 * 4.4,     kind: 'tool_call', tool: 'grep', arg: 'jest.useFakeTimers', result: '4 matches' },
        { t: now - 60_000 * 60 * 4.3,     kind: 'tool_call', tool: 'read_file', arg: 'auth/__tests__/refreshToken.spec.ts' },
        { t: now - 60_000 * 60 * 4.25,    kind: 'agent_think', text: 'Writing a deterministic reproducer before patching.' },
      ],
    },
    // Agent comment left at end of r1 — every completed run posts one.
    { id: 'ac1', t: now - 60_000 * 60 * 4.2, kind: 'comment', authorKind: 'agent', author: ex,
      text: `Reproduced in **3 / 50** runs. The race is a 5ms window between mock-clock advance and the debounce handler. I'm going to patch by awaiting \`flushMicrotasks()\` in the refresh callback and add a deterministic regression test. Back in ~15m.` },
    { id: 'c1', t: now - 60_000 * 60 * 4, kind: 'comment', authorKind: 'human', author: 'alex', text: 'Nice repro. Can we also add a regression test for the 5ms window specifically? Worth pinning it down.' },
    {
      id: 'r2', kind: 'run', t: now - 60_000 * 60 * 3.5,
      endedAt: now - 60_000 * 60 * 3,
      agent: ex, status: 'complete',
      durationMs: 1_020_000, turns: 24, tokensIn: 22_100, tokensOut: 4_200, costUsd: 0.24,
      summary: 'Patched with `await flushMicrotasks()` and added explicit 5ms race regression test.',
      steps: [
        { t: now - 60_000 * 60 * 3.5,  kind: 'agent_think', text: 'Good catch from @alex. Adding a deterministic test that injects a 5ms delay and asserts the refresh fires.' },
        { t: now - 60_000 * 60 * 3.4,  kind: 'tool_call', tool: 'edit', arg: 'auth.integration.spec.ts', result: '+await flushMicrotasks()' },
        { t: now - 60_000 * 60 * 3.3,  kind: 'tool_call', tool: 'edit', arg: 'auth.integration.spec.ts', result: '+it("handles 5ms race")' },
        { t: now - 60_000 * 60 * 3.15, kind: 'tool_call', tool: 'run_tests', arg: 'auth.integration --repeat 20', result: '20/20 passed' },
        { t: now - 60_000 * 60 * 3.05, kind: 'agent_think', text: 'All 20 runs passing. Submitting for review.' },
      ],
    },
    { id: 'ac2', t: now - 60_000 * 60 * 3, kind: 'comment', authorKind: 'agent', author: ex,
      text: `Patched. 20/20 runs passed locally. Diff is 2 files, +34 / -6. Handing to **${agentBySlug[rv]?.name}** for review — please check the \`flushMicrotasks\` boundary, that's the novel bit.` },
    { id: 'hf1', t: now - 60_000 * 60 * 3 + 500, kind: 'handoff', from: ex, to: rv, text: 'Submitted diff for review · 2 files changed, +34 / -6' },
    {
      id: 'r3', kind: 'run', t: now - 60_000 * 60 * 2.8,
      endedAt: now - 60_000 * 60 * 2.5,
      agent: rv, role: 'reviewer', status: 'complete',
      durationMs: 420_000, turns: 9, tokensIn: 9_800, tokensOut: 1_600, costUsd: 0.08,
      summary: 'Approved. Suggested a comment explaining why flushMicrotasks is needed.',
      steps: [
        { t: now - 60_000 * 60 * 2.8,  kind: 'tool_call', tool: 'review_diff', arg: '2 files', result: '+34 / -6' },
        { t: now - 60_000 * 60 * 2.7,  kind: 'agent_think', text: 'Fix is tight. The new test is deterministic and names the exact failure mode.' },
        { t: now - 60_000 * 60 * 2.6,  kind: 'tool_call', tool: 'post_review_comment', arg: 'auth.integration.spec.ts:142', result: 'nit: worth a comment explaining flushMicrotasks' },
      ],
    },
    { id: 'ac3', t: now - 60_000 * 60 * 2.5, kind: 'comment', authorKind: 'agent', author: rv,
      text: `**Approved.** The fix is scoped and the new test is deterministic. Left one nit on \`auth.integration.spec.ts:142\` — a short comment explaining \`flushMicrotasks\` would help future-me. Not blocking.` },
    { id: 'c2', t: now - 60_000 * 60 * 2.3, kind: 'comment', authorKind: 'human', author: 'maria', text: 'Nice. Let\u2019s land this and kick off the 20-run verification in CI.' },
    {
      id: 'r4', kind: 'run', t: now - 60_000 * 60 * 1.2,
      endedAt: null, agent: ex, status: 'running',
      durationMs: null, turns: 11, tokensIn: 18_420, tokensOut: 3_140, costUsd: 0.21,
      summary: 'Addressing review comments and verifying stability across 20 iterations.',
      steps: [
        { t: now - 60_000 * 60 * 1.2, kind: 'tool_call', tool: 'edit', arg: 'auth.integration.spec.ts', result: '+// flushMicrotasks drains the scheduled …' },
        { t: now - 60_000 * 60 * 1.0, kind: 'tool_call', tool: 'run_tests', arg: 'auth.integration --repeat 20' },
        { t: now - 60_000 * 30,        kind: 'agent_think', text: 'Running the suite 20× to confirm no flake…' },
        { t: now - 60_000 * 2,         kind: 'tool_call', tool: 'run_tests', arg: 'auth.integration --repeat 20', result: 'running · 14/20 passed so far' },
      ],
    },
    // No closing comment yet — run is still running.
  ];
}

// ---------- SKILLS ----------
// Reusable playbooks agents can apply when a trigger matches.
const SKILLS = [
  {
    name: 'repro-first',
    display_name: 'Reproduce first',
    trigger: 'Task mentions a bug, flake, incident, or regression.',
    priority: 'always',
    enabled: true,
    body: `# Reproduce first

Before attempting any fix:
1. Make the failure deterministic on your machine.
2. Write a failing test that names the exact failure mode.
3. Only then propose a patch.

If you cannot reproduce in 15 minutes, stop and post a comment explaining what you tried.`,
    used_by: ['atlas', 'hazel'],
    openAllowlist: 1,
    updatedAt: Date.now() - 86_400_000 * 4,
  },
  {
    name: 'code-surgery',
    display_name: 'Code surgery',
    trigger: 'Refactors, type tightening, anything that touches >3 files.',
    priority: 'always',
    enabled: true,
    body: `Keep diffs small. One concept per commit. If a change grows beyond ~200 lines, stop and break it up.`,
    used_by: ['atlas'],
    openAllowlist: 1,
    updatedAt: Date.now() - 86_400_000 * 12,
  },
  {
    name: 'testcraft',
    display_name: 'Testcraft',
    trigger: 'Any task that adds or modifies logic without a paired test.',
    priority: '',
    enabled: true,
    body: `Prefer deterministic tests. Name the exact failure mode in the test description. Avoid \`setTimeout\` in tests — use fake timers or microtask flushes.`,
    used_by: ['atlas', 'hazel', 'quill'],
    openAllowlist: 0,
    updatedAt: Date.now() - 86_400_000 * 2,
  },
  {
    name: 'review-diff',
    display_name: 'Review diff',
    trigger: 'Handed off to a reviewer agent.',
    priority: 'always',
    enabled: true,
    body: `Reviewer protocol:
- One-line verdict: approve / request changes / block.
- ≤ 5 prioritized comments with file:line anchors.
- Propose a follow-up task if the diff reveals more work.`,
    used_by: ['garnet', 'piper'],
    openAllowlist: 0,
    updatedAt: Date.now() - 86_400_000,
  },
  {
    name: 'test-coverage-check',
    display_name: 'Test coverage check',
    trigger: 'Reviewer sees a change that modifies behavior without tests.',
    priority: '',
    enabled: true,
    body: `If the diff changes behavior but does not touch tests, request a test in your review. Exceptions: pure renames, pure doc changes, generated files.`,
    used_by: ['garnet'],
    openAllowlist: 0,
    updatedAt: Date.now() - 86_400_000 * 7,
  },
  {
    name: 'design-doc',
    display_name: 'Write a design doc',
    trigger: 'Task scope spans >1 service or introduces a new boundary.',
    priority: '',
    enabled: true,
    body: `Produce a one-page doc: Current state · Proposed state · Migration sequence · Rollback plan. Request human approval before any code change.`,
    used_by: ['otis'],
    openAllowlist: 0,
    updatedAt: Date.now() - 86_400_000 * 9,
  },
  {
    name: 'migration-plan',
    display_name: 'Migration plan',
    trigger: 'Breaking change in a shared module.',
    priority: '',
    enabled: true,
    body: `Ship breaking changes behind a flag. Migrate consumers in batches. Keep the old path alive for one release cycle.`,
    used_by: ['otis'],
    openAllowlist: 0,
    updatedAt: Date.now() - 86_400_000 * 21,
  },
  {
    name: 'docs-sweep',
    display_name: 'Docs sweep',
    trigger: 'Public API surface changes.',
    priority: '',
    enabled: true,
    body: `Pass across TSDoc on every exported symbol. Fill gaps, fix typos, keep examples runnable.`,
    used_by: ['quill'],
    openAllowlist: 0,
    updatedAt: Date.now() - 86_400_000 * 30,
  },
  {
    name: 'flaky-triage',
    display_name: 'Flaky-test triage',
    trigger: 'Suite has intermittent failures in the last 7 days.',
    priority: '',
    enabled: false,
    body: `Draft, not yet turned on.`,
    used_by: [],
    openAllowlist: 0,
    updatedAt: Date.now() - 86_400_000 * 60,
  },
];
const skillByName = Object.fromEntries(SKILLS.map(s => [s.name, s]));

// ---------- KNOWLEDGE BASE ----------
const KB_ENTRIES = [
  {
    slug: 'auth-module-overview',
    title: 'Auth module overview',
    category: 'reference',
    tags: ['auth', 'architecture'],
    pinned: true,
    updatedAt: Date.now() - 86_400_000 * 2,
    body: `The auth module owns token issuance, refresh, and revocation…

**Key files**
- \`auth/issueToken.ts\` — issues short-lived access + long-lived refresh
- \`auth/refreshToken.ts\` — rotates refresh tokens on use
- \`auth/revoke.ts\` — writes to the revocation list

**Invariants**
1. A refresh token is single-use. Once rotated, the old hash is added to the revocation list.
2. Clock skew tolerance is 5 seconds. Tests that need determinism must use \`jest.useFakeTimers\`.`,
    referenced_by: { tasks: ['WRK-812', 'WRK-809'], agents: ['atlas', 'otis'] },
  },
  {
    slug: 'deployment-runbook',
    title: 'Deployment runbook',
    category: 'howto',
    tags: ['ops', 'deploy'],
    pinned: true,
    updatedAt: Date.now() - 86_400_000 * 9,
    body: `Step-by-step for pushing a release…`,
    referenced_by: { tasks: ['WRK-790'], agents: ['atlas', 'otis'] },
  },
  {
    slug: 'style-guide',
    title: 'TypeScript style guide',
    category: 'reference',
    tags: ['style', 'typescript'],
    pinned: false,
    updatedAt: Date.now() - 86_400_000 * 30,
    body: `House rules for TS…`,
    referenced_by: { tasks: [], agents: ['atlas', 'quill'] },
  },
  {
    slug: 'rate-limit-spec',
    title: 'Rate-limit header spec',
    category: 'reference',
    tags: ['api', 'spec'],
    pinned: false,
    updatedAt: Date.now() - 86_400_000 * 4,
    body: `\`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\` (unix seconds). Match Anthropic spec.`,
    referenced_by: { tasks: ['WRK-806'], agents: ['atlas', 'hazel'] },
  },
  {
    slug: 'flaky-test-playbook',
    title: 'Flaky-test playbook',
    category: 'howto',
    tags: ['testing', 'flake'],
    pinned: false,
    updatedAt: Date.now() - 86_400_000 * 18,
    body: `How we hunt flakes…`,
    referenced_by: { tasks: ['WRK-812'], agents: ['atlas'] },
  },
  {
    slug: 'sse-contract',
    title: 'Run event SSE contract',
    category: 'reference',
    tags: ['sse', 'api'],
    pinned: false,
    updatedAt: Date.now() - 86_400_000 * 11,
    body: `Event types, ids, and reconnection semantics for the /runs SSE stream.`,
    referenced_by: { tasks: ['WRK-790'], agents: ['atlas'] },
  },
  {
    slug: 'escalation-rules',
    title: 'When to escalate to humans',
    category: 'policy',
    tags: ['ops', 'policy'],
    pinned: true,
    updatedAt: Date.now() - 86_400_000 * 1,
    body: `Escalate when: >2 retries · touching customer data · cost > $5 · reviewer disagrees twice.`,
    referenced_by: { tasks: ['WRK-801'], agents: ['atlas', 'otis', 'garnet'] },
  },
];
const kbBySlug = Object.fromEntries(KB_ENTRIES.map(e => [e.slug, e]));

// ---------- SCHEDULES ----------
const SCHEDULES = [
  {
    id: 'SCH-01',
    title: 'Nightly dependency audit',
    description: 'Run `pnpm audit --prod` and triage any new high/critical CVEs. Open tasks per advisory.',
    schedule: { kind: 'cron', expr: '0 3 * * *', human: 'Every day at 03:00 UTC' },
    executor: 'atlas', reviewer: 'garnet',
    enabled: true,
    nextRunAt: Date.now() + 1000 * 60 * 60 * 4,
    lastRunAt: Date.now() - 1000 * 60 * 60 * 20,
    lastRunStatus: 'done',
    runsLast30: 29, failuresLast30: 1,
    history: [
      { t: Date.now() - 1000 * 60 * 60 * 20, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 44, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 68, status: 'error' },
      { t: Date.now() - 1000 * 60 * 60 * 92, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 116, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 140, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 164, status: 'done' },
    ],
  },
  {
    id: 'SCH-02',
    title: 'Weekly flaky-test digest',
    description: 'Scan CI logs from the last 7 days. Produce a ranked list of flaky tests and file one task per top-5.',
    schedule: { kind: 'cron', expr: '0 9 * * 1', human: 'Every Monday at 09:00' },
    executor: 'hazel', reviewer: null,
    enabled: true,
    nextRunAt: Date.now() + 1000 * 60 * 60 * 38,
    lastRunAt: Date.now() - 1000 * 60 * 60 * 24 * 6,
    lastRunStatus: 'done',
    runsLast30: 4, failuresLast30: 0,
    history: [
      { t: Date.now() - 1000 * 60 * 60 * 24 * 6, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 24 * 13, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 24 * 20, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 24 * 27, status: 'done' },
    ],
  },
  {
    id: 'SCH-03',
    title: 'Knowledge-base freshness sweep',
    description: 'Re-summarize KB entries touched in the last 14 days. Flag any whose source has moved.',
    schedule: { kind: 'interval', expr: 'every 6h', human: 'Every 6 hours' },
    executor: 'quill', reviewer: null,
    enabled: true,
    nextRunAt: Date.now() + 1000 * 60 * 72,
    lastRunAt: Date.now() - 1000 * 60 * 60 * 5.8,
    lastRunStatus: 'done',
    runsLast30: 118, failuresLast30: 3,
    history: Array.from({ length: 14 }, (_, i) => ({
      t: Date.now() - 1000 * 60 * 60 * 6 * (i + 1),
      status: i === 3 || i === 9 ? 'error' : 'done',
    })),
  },
  {
    id: 'SCH-04',
    title: 'Generate release-notes draft',
    description: 'Assemble a draft release notes doc from merged PRs since the last tag.',
    schedule: { kind: 'cron', expr: '0 16 * * 5', human: 'Every Friday at 16:00' },
    executor: 'otis', reviewer: 'garnet',
    enabled: false,
    nextRunAt: null,
    lastRunAt: Date.now() - 1000 * 60 * 60 * 24 * 9,
    lastRunStatus: 'done',
    runsLast30: 3, failuresLast30: 0,
    history: [
      { t: Date.now() - 1000 * 60 * 60 * 24 * 9, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 24 * 16, status: 'done' },
      { t: Date.now() - 1000 * 60 * 60 * 24 * 23, status: 'done' },
    ],
  },
  {
    id: 'SCH-05',
    title: 'Triage new customer issues',
    description: 'Pull new Linear tickets from #support, categorize, propose an executor. Human approves before running.',
    schedule: { kind: 'cron', expr: '*/30 * * * *', human: 'Every 30 minutes · business hours' },
    executor: 'hazel', reviewer: null,
    enabled: true,
    nextRunAt: Date.now() + 1000 * 60 * 12,
    lastRunAt: Date.now() - 1000 * 60 * 18,
    lastRunStatus: 'done',
    runsLast30: 412, failuresLast30: 7,
    history: Array.from({ length: 30 }, (_, i) => ({
      t: Date.now() - 1000 * 60 * 30 * (i + 1),
      status: (i === 4 || i === 11) ? 'error' : 'done',
    })),
  },
];
const scheduleById = Object.fromEntries(SCHEDULES.map(s => [s.id, s]));

// ---------- FORMAT HELPERS ----------
function formatAge(ts) {
  const ms = Date.now() - ts;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms/60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms/3_600_000)}h ago`;
  return `${Math.floor(ms/86_400_000)}d ago`;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms/1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms/60_000)}m ${Math.floor((ms%60_000)/1000)}s`;
  return `${(ms/3_600_000).toFixed(1)}h`;
}
function formatTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n/1000).toFixed(1)}k`;
  return `${(n/1_000_000).toFixed(2)}M`;
}
function formatCost(n) {
  if (n == null) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
function formatIn(ts) {
  if (!ts) return '—';
  const ms = ts - Date.now();
  if (ms < 0) return 'due now';
  if (ms < 60_000) return `in ${Math.floor(ms/1000)}s`;
  if (ms < 3_600_000) return `in ${Math.floor(ms/60_000)}m`;
  if (ms < 86_400_000) return `in ${Math.floor(ms/3_600_000)}h ${Math.floor((ms%3_600_000)/60_000)}m`;
  return `in ${Math.floor(ms/86_400_000)}d`;
}

Object.assign(window, {
  AGENTS, agentBySlug, AGENTS_EX, agentExBySlug,
  TASKS, taskById, STATUSES, statusById,
  SKILLS, skillByName,
  KB_ENTRIES, kbBySlug,
  SCHEDULES, scheduleById,
  buildActivity,
  formatAge, formatTime, formatIn, formatDuration, formatTokens, formatCost,
});
