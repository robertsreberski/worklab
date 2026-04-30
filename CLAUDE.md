# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Worklab is a single-user, local AI agent orchestration app: an Express API + Preact UI + SQLite (better-sqlite3) backend that spawns worker processes to run agents against tasks via Claude Agent SDK, OpenAI Agents SDK, Vercel AI SDK, Claude Code CLI, and Codex CLI. It also exposes a token-protected admin MCP endpoint with full Worklab API access.

The task/agent workflow is being redesigned ("v2"). The authoritative reference is `docs/audits/task-agent-logic-audit.md`. Older PRD/architecture/phase-plan docs were intentionally deleted — do **not** reintroduce behaviors from them; treat the source, tests, and that audit as the ground truth.

`AGENTS.md` and `CONTRIBUTING.md` apply in full. The notes below highlight what isn't already obvious from those.

## Module Boundaries

Worklab is layered. Each layer's `README.md` lists what it owns and what it must not import; the matching ESLint rules in `eslint.config.js` enforce the boundary at error level. The direct-`db.prepare()` ban in `src/api/**` blocks any new SQL outside `core/db/queries/*`. Edge layers (api, mcp, integrations, cli, worker, coordinator outside the watcher carve-outs) consume `core/` via the public barrel `src/core/index.js`; the only deep import allowed everywhere is `core/db/queries/*`. The carve-outs (`coordinator/task-watcher.js`, `coordinator/watcher/*.js`, `coordinator/spawn-worker.js`, and the single `cli/mcp.js → mcp/admin/tools.js` line marked with `eslint-disable`) are documented inline. Run `npm run lint` and `./scripts/guard-imports.sh` to check.

- `src/ai/` — Provider layer: SDK/CLI adapters (`providers/{claude-sdk,pi-sdk,claude-cli,codex-app}.js`), the `worklab_result` contract (`result/contract.js`), failure-kind taxonomy (`failure.js`), streaming-event normalization (`streaming/codex-events.js`), and a registry (`registry.js`). No DB, no domain layers.
- `src/agent/` — Agent kernel: context compaction (`compaction.js`), transcript snapshots (`transcript.js`), allowlist resolution (`allowlists.js`), built-in tool implementations (`tools/index.js`), the PI tool bridge (`tools/pi-bridge.js`), and the prompt builders (`prompt/system-prompt.js`). May use `src/ai/` only.
- `src/core/` — Worklab domain: SQLite layer in `db/` (open, schema/, migrations/runner.js, queries/<aggregate>.js — every SQL statement lives in `queries/`), task state machine, knowledge base, journals, memory consolidation, run/event helpers, automations, embeddings, projects, settings, credentials, and assorted leaf utilities. May use `src/agent/` and `src/ai/`. Public re-exports in `src/core/index.js`.
- `src/coordinator/` — Process orchestrator: `task-watcher.js` (DB → spawn decisions, decomposed across `watcher/{run-handler,final-text,kb-publisher,delegation-handler,failure-classifier}.js`), `spawn-worker.js` (forks `src/worker.js`), `automation-manager.js`, `consolidation-cron.js`, `search-indexer.js`. Owns scheduling; never runs agent code in-process.
- `src/worker.js` + `src/coordinator.js` — Child entry points spawned by the coordinator. Worker result-shaping helpers live in `src/worker/result-emitter.js`.
- `src/api/` — Express edge: `server.js`, SSE in `sse.js`, route modules in `routes/<aggregate>.js`. Routes call into `src/core/`; direct `db.prepare()` is forbidden (lint enforces).
- `src/mcp/` — MCP servers: `admin/{server,tools}.js` (HTTP, full admin surface) and `agent/{server,tools}.js` (stdio, the constrained tool surface exposed to agents). Agents must mutate task/subtask state through these tools, not by editing the DB or files.
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
- Test layout mirrors source: `src/__tests__/{core,coordinator,api,mcp,cli,ui,integrations,e2e,playwright}/`. Place new tests in the matching folder.
- Passing tests do not imply workflow correctness — several worker-exit defects are masked by stubs (see the audit). When changing scheduler/worker behavior, prefer adding integration coverage in `src/__tests__/e2e/` over relying on stubs.

Before finalizing substantial changes: `npm test`, `npm run build:ui`, `git diff --check`. UI changes: also run `./scripts/guard-banned-tokens.sh` and Playwright when layout/browser behavior could regress.

## UI Design System Guardrails

`scripts/guard-banned-tokens.sh` enforces `docs/ui-design-system.md` rules and is intended for CI/pre-commit. It fails on:

- Half-pixel font sizes (`10.5px`, `11.5px`, `12.5px`, `13.5px`).
- Raw hex colors anywhere in `src/ui/src/styles.css` outside the `:root` token block — use CSS variables.
- Off-spec `border-radius` px values; only `2/6/10/999` px or the `--radius-xs/sm/md/pill` tokens are allowed.

Stick to the tokens defined in `styles.css` and the primitives in `components/primitives/` rather than inventing new variants.

## v2 Workflow Constraints (from CONTRIBUTING.md)

- Prefer a clean v2 workflow over compatibility with obsolete task states.
- Keep task workflow state separate from run process state — do **not** overload `in_progress` to mean "worker running" + "needs retry" + "reviewer rejected" + "stuck". The audit explains the target split.
- All agent runtimes must converge on one structured `worklab_result` contract.
- Agents request task/subtask changes through controlled APIs or MCP tools, never by editing the DB or files directly.
- Recovery from provider errors, invalid results, stale workers, cancellation, and rejection loops must surface as explicit user-facing state.

## Commit Style

Conventional commits: `type(scope): subject`. Keep commits focused and granular (commit after each logical change), include tests with behavior changes, and don't sweep up unrelated edits.
