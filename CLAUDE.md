# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Worklab is a single-user, local AI agent orchestration app: an Express API + Preact UI + SQLite (better-sqlite3) backend that spawns worker processes to run agents against tasks through `@worklab-ai/agent-runtime` backends: Claude SDK, Claude Code CLI, Pi SDK providers, and the Codex CLI app-server. It also exposes a token-protected admin MCP endpoint with full Worklab API access.

The current task/agent workflow is the v2 workflow. The authoritative references are `src/core/state-machine.js` (the deterministic orchestrator that owns every task transition), `src/core/worklab-result/contract.js` (the `worklab.v2` contract), `src/core/worklab-result/decisions.js` (stage/decision vocabulary), and `src/core/worklab-result/lead-cycle-contract.js` (the `worklab.lead_cycle.v1` team-lead contract). Older PRD/architecture/phase-plan docs were intentionally deleted — do **not** reintroduce behaviors from them; treat the source and tests as the ground truth.

`AGENTS.md` and `CONTRIBUTING.md` apply in full. The notes below highlight what isn't already obvious from those.

## Module Boundaries

Worklab is layered. Each layer's `README.md` lists what it owns and what it must not import; the matching ESLint rules in `eslint.config.js` enforce the boundary at error level. The direct-`db.prepare()` ban in `src/api/**` blocks any new SQL outside `core/db/queries/*`. Edge layers consume core domain helpers via `src/core/index.js`, use the `@worklab-ai/agent-runtime` package for kernel/provider concerns, and only deep-import `core/db/queries/*` for DAL helpers. The carve-outs (`coordinator/task-watcher.js`, `coordinator/watcher/*.js`, `coordinator/spawn-worker.js`, and the single `cli/mcp.js → mcp/admin/tools/index.js` line marked with `eslint-disable`) are documented inline. Run `npm run lint` and `./scripts/guard-imports.sh` to check.

- `packages/agent-runtime/` — The agent runtime, a workspace package (`@worklab-ai/agent-runtime`) reusable outside Worklab. Contains the provider layer (SDK/CLI adapters in `src/ai/providers/{claude-sdk,pi-sdk,claude-cli,codex-app}.js`, failure-kind taxonomy in `src/ai/failure.js`, streaming-event normalization in `src/ai/streaming/codex-events.js`, registry in `src/ai/runtime/registry.js`) and the agent kernel (context compaction in `src/agent/compaction.js`, transcript snapshots in `src/agent/transcript.js`, allowlist resolution in `src/agent/allowlists.js`, built-in tool implementations in `src/agent/tools/`, the PI tool bridge in `src/agent/tools/pi-bridge.js`). No DB, no Worklab domain contracts, no Worklab persistence.
- `src/core/` — Worklab domain: SQLite layer in `db/` (open, schema/, migrations/runner.js, queries/<aggregate>.js — every SQL statement lives in `queries/`), task state machine, `worklab_result` contracts in `worklab-result/`, knowledge base, journals, memory consolidation, run/event helpers, automations, embeddings, projects, settings, credentials, the worklab-shaped stage prompt builders in `prompts/system-prompt.js`, and assorted leaf utilities. May use `@worklab-ai/agent-runtime`. Public re-exports in `src/core/index.js`.
- `src/coordinator/` — Process orchestrator: `task-watcher.js` (DB → spawn decisions, decomposed across `watcher/{run-handler,final-text,kb-publisher,delegation-handler,failure-classifier}.js`), `spawn-worker.js` (forks `src/worker.js`), `automation-manager.js`, `consolidation-cron.js`, `search-indexer.js`. Owns scheduling; never runs agent code in-process.
- `src/worker.js` + `src/coordinator.js` — Child entry points spawned by the coordinator. Worker result-shaping helpers live in `src/worker/result-emitter.js`.
- `src/api/` — Express edge: `server.js`, SSE in `sse.js`, route modules in `routes/<aggregate>.js`. Routes call into `src/core/`; direct `db.prepare()` is forbidden (lint enforces).
- `src/mcp/` — MCP servers: `admin/server.js` + `admin/tools/index.js` (HTTP, full admin surface) and `agent/server.js` + `agent/tools/index.js` (stdio, the constrained tool surface exposed to agents). Agents must mutate task/subtask state through these tools, not by editing the DB or files.
- `src/integrations/slack/` — Slack Bolt integration (`service.js`, `context.js`, `filter.js`, `triage-result.js`). Talks to Worklab via core/agent — never via the API.
- `src/cli/` — `worklab` binary (`bin` in `package.json`). `index.js` lazy-imports subcommands; `args.js` applies `--port/--host/--data-dir/--workspace` before `bootstrapWorklabEnv`.
- `src/ui/` — Preact + Vite app. Routes in `src/ui/src/routes/`, primitives in `components/primitives/`, layout shells in `components/layout/`. Built bundle goes to `src/ui/dist/` and is served by the API. Browser-only — no Node imports.

Runtime data lives in `~/.worklab` by default (`WORKLAB_DATA_DIR` to override). `data-template/` is the seed copied on first boot (see `src/core/first-boot.js`).

## Commands

```bash
npm install                # Node 20+ required
npm test                   # full Vitest suite
npx vitest run <path>      # single test file
npm run test:watch         # watch mode
npm run test:coverage      # coverage thresholds: 60% lines/funcs/branches/stmts (excludes src/ui)
npm run build:ui           # Vite build → src/ui/dist
npm run dev:api            # API + static UI (no UI HMR)
npm run dev:ui             # Vite dev server with HMR; proxies /api to dev:api
npm start                  # build:ui then `worklab serve`
npm run test:e2e:ollama    # Playwright against a freshly built UI (chromium, serial)
./scripts/guard-banned-tokens.sh   # UI design-token lint (see below)
npm run lint                       # boundary-import + db.prepare lint
./scripts/guard-imports.sh         # same, formatted for pre-commit
```

For Vite + non-default API port, pass the same port to both: `npm run dev:api -- --port 9000` and `WORKLAB_PORT=9000 npm run dev:ui`.

`worklab start`/`restart` rebuild the UI and (re)write the per-user host service definition; pass `--no-build` only to skip the rebuild deliberately. `worklab mcp` runs the stdio MCP bridge for agents.

## Testing Rules

- Tests must never touch the developer's real `~/.worklab`. Use temp dirs and set `WORKLAB_DATA_DIR` explicitly whenever a test touches runtime files, service tokens, the DB, logs, MCP config, or backups.
- Use unique `WORKLAB_PORT` values for any spawned server and clean up child processes in `afterEach`/teardown.
- Stub network calls, provider SDKs, long-running workers, and host service managers unless the test is explicitly end-to-end.
- Test layout mirrors source: `src/__tests__/{ai,agent,core,coordinator,api,mcp,cli,ui,integrations,e2e,playwright}/`. Pure-runtime unit tests live in `packages/agent-runtime/src/__tests__/`; worklab-side `src/__tests__/{ai,agent}/` is reserved for cross-boundary integration tests that exercise the runtime against worklab core (real DB, live-input queues, etc.). Place new tests in the matching folder.
- Passing tests do not imply workflow correctness — several worker-exit defects are masked by stubs (see the audit). When changing scheduler/worker behavior, prefer adding integration coverage in `src/__tests__/e2e/` over relying on stubs.

Before finalizing substantial changes: `npm test`, `npm run build:ui`, `git diff --check`. UI changes: also run `./scripts/guard-banned-tokens.sh` and Playwright when layout/browser behavior could regress.

## UI Design System Guardrails

`scripts/guard-banned-tokens.sh` enforces `docs/ui-design-system.md` rules and is intended for CI/pre-commit. It fails on:

- Half-pixel font sizes (`10.5px`, `11.5px`, `12.5px`, `13.5px`).
- Raw hex colors anywhere in `src/ui/src/styles.css` outside the `:root` token block — use CSS variables.
- Off-spec `border-radius` px values; only `2/6/10/999` px or the `--radius-xs/sm/md/pill` tokens are allowed.

Stick to the tokens defined in `styles.css` and the primitives in `components/primitives/` rather than inventing new variants.

## Runtime behaviour notes

Background on runtime behaviour you need when touching the worker, coordinator, or recovery paths:

- `packages/agent-runtime/src/agent/tool-bloat.js` caps any single tool_result aggregate at `agent_tool_payload_max_bytes` (default 256 KB) and persists the originals under `<runArtifactDir>/tool-output/`. The runtime warning kind for truncations is `tool_payload_truncated`; `task_runs.diagnostics_json` carries `tool_results_truncated` (count).
- `src/core/worklab-result/lenient-parse.js` (`parseWorklabResultLenient`) is the fallback parser the worker invokes before declaring `invalid_result`. When it recovers, `diagnostics.result_recovered_via = "lenient"`.
- `cancelled_shutdown` is a distinct failure kind from `cancelled_stale`. It does not count against failure budgets. The shutdown watchdog is configurable via `WORKLAB_DRAIN_TIMEOUT_MS` (default 60 s) or the equivalent `worklab start/stop/restart --drain-timeout-ms` CLI flag. On shutdown the coordinator sends a `worklab_drain` message over the worker IPC pipe; the worker aborts its AbortController, emits a `drained` event, and exits cleanly. spawn-worker persists a transcript-tail snapshot tagged `resume_kind: "drained"` so the next coordinator boot can schedule a fresh continuation with `continuation_reason: "coordinator_resume"` instead of re-running the work.
- `task_runs.parent_relationship` (`stage_progression | recovery_continuation | manual_retry`) disambiguates the overloaded `parent_run_id`.
- `tasks.lifetime_*_count` columns are monotonic and survive `reset_failure_count`. `getTaskHealth(db, id)` returns them; the task detail endpoint exposes them as `task.health`.
- Recovery continuations come in four flavours: `provider_retryable` (default), `schema_correction` (capped at 2), `finalisation` (single shot when the parent ran `journal_summary` and then dropped), and `coordinator_resume` (scheduled at boot for runs the previous coordinator drained cleanly on shutdown — receives the parent's transcript-tail snapshot through `diagnosticsSeed.resume_snapshot`).
- `WORKLAB_PROVIDER_SESSION_ID` is set by the spawn path for recovery continuations so pi-sdk reuses the parent's session_id (other providers are a follow-up).
- `POST /api/tasks/:id/cancel` accepts a structured `reason_kind` enum (`wrong_direction | agent_stuck | context_bloat | scope_change | other`) plus an optional `reason_note`.

## Teams + lead-cycle (v33)

- A team has a name, a goal, a lead agent, a roster (`team_members`), an optional schedule (`schedule_enabled` + `schedule_interval_minutes`), and team-scoped budgets (`daily_budget_usd`, `per_run_budget_usd`). Teams retire the project `allowed_agents_json` allowlist and the per-agent `daily_budget_usd` / `per_run_budget_usd` columns — those are dropped by migration v33. Per-agent live-run soft/hard tier files in `data-template/agents/<name>/budget.json` remain and govern in-flight cancellation; they are orthogonal to aggregate spend caps.
- Projects assigned to a team (`projects.team_id`) inherit that team's roster for all delegation. Tasks may override with `tasks.team_id`; otherwise the watcher resolves the effective team via `effectiveTeamForTask` in `src/core/teams.js`. Roster enforcement lives in `enforceTeamRoster` (delegation-handler.js) and reports `delegation_agent_not_in_team` (or `delegation_team_roster_empty`) when a planner picks an off-roster agent.
- The lead is invoked through a new run kind: `task_runs.kind = 'lead_cycle'`, anchored on a synthetic per-(team, project) root task flagged `tasks.is_team_root = 1`. The lead returns a `worklab.lead_cycle.v1` document (see `src/core/worklab-result/lead-cycle-contract.js`), which the watcher converts into existing side-effects: `task_creations` flow through `createDelegatedSubtasks`, `advisory_notes` become system comments on the named target tasks, and `goal_status` updates the synthetic root's metadata. The lead can only create new tasks; it cannot reassign existing ones or directly mutate state.
- Lead cycles fire on three triggers, all gated by `hasInFlightLeadCycle`: event-driven (a task with an effective team transitions to `done`/`blocked`), scheduled (`src/coordinator/team-lead-cron.js` polls every 60 s), and manual (`POST /api/teams/:id/run-lead` and `worklab_team_run_lead`). Synthetic root tasks are filtered out of default task listings (`is_team_root = 0`) — opt in with `?include_team_roots=true`.

## v2 Workflow Constraints (from CONTRIBUTING.md)

- Prefer a clean v2 workflow over compatibility with obsolete task states.
- Keep task workflow state separate from run process state — do **not** overload `in_progress` to mean "worker running" + "needs retry" + "reviewer rejected" + "stuck". The audit explains the target split.
- All agent runtimes must converge on one structured `worklab_result` contract.
- Agents request task/subtask changes through controlled APIs or MCP tools, never by editing the DB or files directly.
- Recovery from provider errors, invalid results, stale workers, cancellation, and rejection loops must surface as explicit user-facing state.

## Commit Style

Conventional commits: `type(scope): subject`. Keep commits focused and granular (commit after each logical change), include tests with behavior changes, and don't sweep up unrelated edits.

## WORKFLOW RULES (important)

After every change, make sure you commit code granularly. When building a specific feature, break the work into small logical commits as you go rather than batching everything into one commit at the end.
