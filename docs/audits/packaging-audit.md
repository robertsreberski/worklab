# Packaging Audit — Worklab as a Family of npm Packages

_Status: 2026-05-14 — audit only, no extraction performed._

## 1. Goals and use cases

Worklab ships today as one Node application (Express API + Preact UI + SQLite + coordinator + workers) with a single workspace package, `@worklab-ai/agent-runtime`, being extracted for reuse. The question this audit answers: **what additional layers should ship as their own npm packages, and what is currently in the way?**

The audit is framed against three concrete reuse scenarios the user named, plus two opportunistic ones drawn from the architecture review.

### U1 — Embed an orchestrated agent team in any Node app

> "I install one package, declare a lead + a small roster of workers, give them a goal, and call `await team.run()` from my own service. I don't want Worklab's DB or UI — I'll persist whatever I want."

The v33 lead-cycle work is the closest existing shape (lead → planner → workers → verifier, with a structured `worklab.lead_cycle.v1` result driving task creation and advisories). Today the lead cycle requires the full Worklab schema and the coordinator's watcher to function.

### U2 — Webhook-driven specialist with a chat interface

> "An HTTP request lands (GitHub issue comment, Slack mention, generic webhook). One agent picks it up, replies in a chat-shaped surface, optionally creates follow-up work. I want the agent kernel + a thin transport, not a full task workflow."

`src/integrations/slack/service.js` (675 LOC) is the existing reference: receive event → triage agent with structured output (`TRIAGE_RESULT_JSON_SCHEMA`) → dispatch to create_task / create_comment / answer / delegate / escalate. The pattern is generalizable; the implementation is Slack-and-Worklab-shaped.

### U3 — TUI harness replacing the Preact UI

> "I want a terminal UI (Ink, blessed, or homegrown) that talks to the same coordinator and DB Worklab uses. The current Preact app should keep working."

There are two candidate client surfaces today: the REST API under `src/api/routes/` (24 modules) and the admin MCP server in `src/mcp/admin/tools/index.js` (14 modules). The question is which is the more stable, complete contract.

### U4a — Evaluation harness

Reuse the provider abstraction + `failure.js` taxonomy + `cost.js` to benchmark agents against fixtures. Already 80% there because `@worklab-ai/agent-runtime` exposes `createRuntime()` (see `examples/echo-agent/`); missing piece is metric aggregation.

### U4b — Ad-hoc "ask once" CLI

`worklab ask "summarize last week's runs"` style command that runs an agent without persisting a task row. Useful for scripting and for getting feedback before committing to a task. Today every run creates `task_runs` rows.

## 2. Today's seams

### What's already extracted

- **`@worklab-ai/agent-runtime@0.1.3`** (`packages/agent-runtime/`). Provider layer (Claude SDK, Claude CLI, Codex CLI, pi-ai), agent kernel (compaction, transcript, allowlists, tool implementations), failure-kind taxonomy, cost helpers. Public exports: `createRuntime`, `runtimeCapabilities`, plus deep paths under `./ai/*` and `./agent/*` (see `packages/agent-runtime/package.json` `exports`). Zero `better-sqlite3` dependency; zero `~/.worklab` hardcoding. The `dataDir` parameter that exists (e.g. `packages/agent-runtime/src/agent/tools/pi-bridge.js:313`) is caller-provided, not hardcoded.
- **`examples/echo-agent/`** is the existing demo of `createRuntime` end-to-end (single Claude SDK turn with the Bash tool). Pattern to follow for new examples.

### What's *intended* to be extracted but isn't yet

CLAUDE.md states the `worklab_result` contract files live under `packages/agent-runtime/src/ai/result/`. **They do not.** They live only at `src/core/worklab-result/{decisions,contract,lead-cycle-contract,lenient-parse}.js`. The runtime package imports them only indirectly via the worker. This is the single highest-leverage move on the board: relocating the directory and exposing it from the package costs almost nothing.

### What's organized but not yet packaged

- **`src/core/index.js`** (546 lines) is the Worklab domain barrel. It already labels itself "public surface" and is the boundary the API, MCP, coordinator, and integrations all consume. Codifying this as `@worklab-ai/core-client` is mostly a packaging act, not a refactor.
- **`src/mcp/admin/tools/index.js`** and **`src/mcp/agent/tools/index.js`** — already modular tool definitions. Each tool exports `{ definition, handler }` shapes. The constraint is that handlers reach `getDb()` or `context.db` and assume a Worklab schema is open.
- **`src/integrations/slack/`** — 4 files (`service.js` 675 LOC, `context.js` 84, `filter.js` 26, `triage-result.js` 80). Self-contained, only reaches into core through high-level helpers. Already nearly publishable.

## 3. Recommended package decomposition

Priority order is "easiest first × unlocks the most use cases first." S = days, M = weeks, L = months.

| # | Package | Effort | Purpose | Source paths | Coupling to break | Unlocks |
|---|---|---|---|---|---|---|
| 1 | **`@worklab-ai/agent-result-parser`** | S | Move the `worklab_result` and `lead_cycle.v1` contract definitions out of `src/core/` into a published package (or add them to `@worklab-ai/agent-runtime` exports). | `src/core/worklab-result/{decisions,contract,lead-cycle-contract,lenient-parse}.js` | Almost none — these files only depend on `zod`. Importers in `src/core/` switch to the new path. | All reuse cases — every downstream parser needs these. |
| 2 | **`@worklab-ai/core-client`** | S/M | Re-package `src/core/index.js` as the stable in-process API surface for non-Worklab consumers (TUI, custom UIs, scripts). | `src/core/index.js` + the modules it re-exports | Caller still needs a SQLite DB opened against the Worklab schema. Document the contract: "open the DB via `openDb()`, run `runMigrations()`, then call domain functions." Don't try to hide the DB. | U3 (TUI), bespoke automation scripts. |
| 3 | **`@worklab-ai/slack-bridge`** | S | Lift `src/integrations/slack/` as its own published transport adapter. Pair it with the (existing) `agent-runtime` and the new contract package; do not bind it to Worklab core. | `src/integrations/slack/{service,context,filter,triage-result}.js` | `service.js` reaches into the DB for past-task / memory / KB context. Replace those direct reads with an injected `getContext(threadId)` callback. ~30 call sites. | U2 (webhook chat specialist on Slack), reused inside Worklab via DI. |
| 4 | **`@worklab-ai/team-orchestrator`** | M | The lead-cycle pattern as a library: declare a team config + roster, get a `runLeadCycle(input)` that returns `{ task_creations, task_assignments, advisory_notes, goal_status }`. Caller chooses how to persist. | `src/core/teams.js` (goal-contract helpers + roster validators), `src/core/worklab-result/lead-cycle-contract.js`, `src/worker/lead-cycle-runner.js`, prompt assembly from `src/core/prompts/system-prompt.js` for the lead system prompt | `lead-cycle-runner.js` currently uses `buildTaskRunInput()` (DB-backed). Replace with an explicit `{ team, roster, recentCycles, advisoryHistory }` input. Goal-contract helpers in `teams.js` are pure once split from `db/queries/teams.js`. | U1 (in-app team), and used inside Worklab via DI. |
| 5 | **`@worklab-ai/webhook-agent`** + transports | M | Generalize the Slack triage pattern: `createWebhookAgent({ systemPrompt, decisionSchema, onDecision })`. Transport adapters (`webhook-slack`, `webhook-linear`, `webhook-http`) feed it events and post replies back. | Distill from `src/integrations/slack/service.js`; pull the decision-schema-and-dispatch core out. | The "context bundle" the agent sees (task history, memory, knowledge) needs an injectable resolver. Caller decides where the context comes from. | U2 across multiple transports, and the in-app Slack integration. |
| 6 | **`@worklab-ai/evaluator`** | S | Wrap `createRuntime()` with metric aggregation (cost, turns, failure-kind histogram, latency). | `packages/agent-runtime/src/ai/failure.js`, `cost.js`, plus a thin harness module. | None — agent-runtime is already DB-free. This is mostly new glue + a tiny test-fixture format. | U4a (evaluation), regression detection for Worklab itself. |
| 7 | **`@worklab-ai/orchestrator`** | L | The full coordinator (`src/coordinator/`) made injectable: takes a storage adapter, an artifact adapter, a settings provider, and produces a runnable scheduler. | `src/coordinator/{task-watcher.js (1193 LOC), spawn-worker.js (979 LOC), watcher/*.js, automation-manager.js, consolidation-cron.js, team-lead-cron.js}` | ~413 `db.prepare` call sites under `src/core` + `src/coordinator`. The `while (true)` polling loop in `task-watcher.js` couples to the SQLite-singleton pattern. Heavy DI lift; not worth attempting until packages 1–5 stabilize. | U1 at scale, custom schedulers. Defer. |

### Anti-recommendations

| Don't package | Reason |
|---|---|
| `src/api/` | Worklab-specific Express routes. Downstream consumers will write their own HTTP layer or use MCP. |
| `src/ui/` | Tightly coupled to Worklab domain concepts; not a reusable library. |
| `src/cli/` | The `worklab` binary, service install, backup, doctor. App-specific shell. |
| `src/core/assistant.js` | Worklab's per-user assistant thread service. Domain logic, not a primitive. |
| `src/core/embeddings.js` / `kb.js` | Tightly coupled to Worklab's category taxonomy and DB schema. Useful pattern but not a generic library. |

## 4. Cross-cutting blockers

These coupling points appear in multiple proposed packages. Fixing each one once unblocks several extractions.

### 4.1 SQLite singleton pattern

`getDb()` is called from inside `src/core/` and `src/coordinator/` modules — ~413 `db.prepare` call sites under those two trees. As long as core domain functions reach `getDb()` themselves, no consumer can inject a different storage. Path forward: every domain function that needs the DB takes `db` as the first parameter (already true for many — `getDb()` is the residual). Cleanup is grindy but mechanical.

### 4.2 `~/.worklab` data-dir assumption

Artifact paths, journals, MCP config, embedding files all assume a data dir. The agent-runtime already accepts `dataDir` as a caller-provided parameter; `src/core/` largely does too. The remaining leak is in helpers like `agentJournalPath(dataDir)` where callers default to the Worklab data dir if not passed. A `core-client` consumer just has to be aware they must pass it explicitly. **This is documentation, not refactoring.**

### 4.3 Settings coupling

Budgets, embedding backend selection, MCP config all come from `readSettings(db)`. For library consumers this is fine — they open a DB, write settings, then call domain functions — but the implicit "settings live in SQLite" assumption blocks pure-config-object usage. For `@worklab-ai/team-orchestrator`, accept settings as a plain object and document the shape.

### 4.4 Prompt builder bleeds Worklab affordances

`src/core/prompts/system-prompt.js` (737 LOC) hardcodes the Worklab MCP tool surface (`journal_append`, `kb_create`, `todo_write`, `run_log_read`, etc.). For U1 and U2 a consumer wants the orchestration *structure* (skill index, KB section, capability listing) without the Worklab affordances. The clean fix is to inject the affordance list rather than have it hardcoded, but this is invasive — defer until `team-orchestrator` is built and we know what affordances it actually needs.

### 4.5 CLAUDE.md is stale on the result contract path

CLAUDE.md says `packages/agent-runtime/src/ai/result/decisions.js` is canonical. That path does not exist. The contract lives at `src/core/worklab-result/`. This blocks package #1 less than it confuses new contributors — note it in the next CLAUDE.md edit alongside extraction work.

## 5. Use-case fit matrix

| Use case | What exists | Missing | Minimum viable path |
|---|---|---|---|
| **U1 — Embedded team orchestrator** | Lead-cycle contract (`src/core/worklab-result/lead-cycle-contract.js`), goal-contract helpers (`src/core/teams.js`), lead-cycle runner (`src/worker/lead-cycle-runner.js`), team-lead cron (`src/coordinator/team-lead-cron.js`) | DB-free invocation of the lead cycle; pure-object team config input; caller-provided persistence for created tasks. | Ship packages #1 (result-parser) and #4 (team-orchestrator). Caller assembles `{ team, roster, recentCycles }` and gets `{ task_creations, advisory_notes, goal_status }` back to do with as they wish. |
| **U2 — Webhook chat specialist** | Slack integration (`src/integrations/slack/`), triage schema, context bundler, generic SSE broker (`src/api/sse.js`) | Generic transport interface, injectable context resolver, separation of triage-decision parsing from Slack-specific posting. | Ship packages #1, #3 (slack-bridge — uses Slack today), and #5 (webhook-agent — generalizes the pattern for other transports). Add `webhook-linear`, `webhook-http` later. |
| **U3 — TUI harness** | REST API (`src/api/routes/`, 24 modules with SSE for live updates), admin MCP (`src/mcp/admin/tools/`), the domain barrel at `src/core/index.js`. | A documented stable client contract. The REST surface is the richer of the two (streaming, query params, pagination); MCP is request-response only. | Use the REST API as the primary contract. Ship package #2 (`core-client`) for in-process consumers who want to skip HTTP. No new code is strictly required — this use case is a documentation exercise + a versioning commitment. |
| **U4a — Evaluation harness** | `createRuntime()`, `failure.js` taxonomy, `cost.js` | Aggregation harness + fixture format | Ship package #6 (`evaluator`). Mostly new glue. |
| **U4b — Ad-hoc CLI** | The full worker pipeline (creates `task_runs` rows) | An "ephemeral" mode that runs an agent without persisting | A flag on the worker, not a new package. Defer until U1/U2 land — the same DB-free pathway covers it. |

## 6. Recommended phasing

Each phase is bounded so it can be paused without leaving the tree in a worse state.

### Phase 1 — Low-risk publication wins

- Ship **`@worklab-ai/agent-result-parser`** (package #1). Move `src/core/worklab-result/` into the runtime package's `exports` or a new sibling package, update ~5 importers, fix CLAUDE.md.
- Ship **`@worklab-ai/evaluator`** (package #6). Pure additive — no internal refactor.
- Update `examples/` with a "team echo" sample that uses the result-parser to validate fixture outputs.

Outcome: no internal API changes; two new published packages; CLAUDE.md correct.

### Phase 2 — Stabilize the in-process contract

- Ship **`@worklab-ai/core-client`** (package #2). Codify `src/core/index.js` as the contract; add a semver discipline note to CLAUDE.md.
- Document the REST API surface (`src/api/routes/`) as the over-the-wire equivalent.
- Build a small TUI proof-of-concept against this contract (Ink or blessed) as `examples/tui-harness/`. The PoC IS the verification that the contract is usable.

Outcome: U3 is achievable; downstream consumers have a stable target.

### Phase 3 — Transport adapters and team library

- Ship **`@worklab-ai/slack-bridge`** (package #3) with an injectable context resolver. In-tree Slack integration switches to consuming the published package.
- Ship **`@worklab-ai/team-orchestrator`** (package #4) — DB-free team-cycle invocation. Worklab's coordinator continues to use the same library internally, with a thin DB-backed adapter for persistence.
- Begin **`@worklab-ai/webhook-agent`** (package #5) by generalizing the Slack triage pattern; ship `webhook-http` first as the simplest transport.

Outcome: U1 and U2 are both achievable; in-tree Worklab consumes its own libraries (good dogfood).

### Phase 4 — Orchestrator extraction (deferred)

- Tackle **`@worklab-ai/orchestrator`** (package #7) only after Phase 3 stabilizes. ~413 `db.prepare` call sites need to flow `db` through DI before the coordinator can run against a non-Worklab storage. Reassess whether this is worth it — the cost is high and most downstream consumers can use packages 4 and 5 directly without ever needing a generic scheduler.

## 7. What this audit is *not*

- Not an execution plan. No package has a step-by-step "do this, then this." Each phase needs its own planning pass with concrete file-by-file diffs.
- Not a defense of the v33 architecture or the v2 redesign. Where this audit assumes those decisions, it cites the relevant source (`CLAUDE.md`, `eslint.config.js`) and stops there.
- Not a recommendation to extract everything that *could* be extracted. The anti-recommendations in §3 are deliberate — packaging cost is real.

## 8. Open questions to resolve before Phase 3

These will affect how packages #3–#5 are shaped; flag them at planning time:

1. Will Worklab consume its own published packages from `node_modules` (slower CI, true dogfood) or via workspace symlinks (faster, less realistic)? Likely workspace symlinks given the existing workspaces config in `package.json`.
2. What's the versioning policy? Are these packages independently versioned, or do they all tag together at every Worklab release? Default recommendation: independent semver, with `peerDependencies` pinning runtime against parser, etc.
3. Where does the `slack-bridge` belong long-term — as a Worklab-org package, or as a community module? If it stays Worklab-org, what's the contribution model for `linear-bridge`, `discord-bridge`, etc.?

These are decisions for the next planning pass; not blocking the audit itself.
