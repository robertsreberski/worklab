> Written 2026-04-22 after phase-5 shipped. This is a roadmap of candidates for future phases; not a plan. Specific phase plans (e.g. `phase-6.md`) get written only when a near-term item is chosen for execution.

# Worklab — Phase 6+ Roadmap

**Spec:** `docs/spec/worklab-design.md` §2 (Goals/Non-goals) and §11 (Open questions).

**Predecessor plan:** `docs/plans/phase-5.md`

---

## Recently shipped (for context)

Phases 1–5 delivered a complete v1 single-user agent orchestration tool. Phase 1 built the kanban task board, SQLite schema, CLI, and Preact UI scaffold. Phase 2 added the Claude Agent SDK runtime, skills system, MCP config loader, journaling, and live SSE event streaming. Phase 3 introduced the review workflow (executor → reviewer → approve/reject) and the shared knowledge base with filesystem CRUD tools. Phase 4 added multi-SDK dispatch (Claude/OpenAI/Vercel), a custom provider registry with AES-256-GCM-encrypted API keys, Ollama discovery, and a model picker with real model names. Phase 5 closed out v1 with nightly memory consolidation, hybrid semantic search (FTS5 + cosine), a chokidar-based indexer, `worklab install-service` for macOS launchd and Linux systemd, `worklab backup`, and a polished Activity and Settings UI. The test suite stands at 401 tests, all green.

---

## Near-term candidates (next release, v1.1-ish)

These are light-lift, high-value improvements that require no schema redesign and fit within the existing architecture.

### `kb_search` results surfaced into subsequent agent system prompts

Today `kb_search` returns hits as a tool-call result. The agent must explicitly re-read them to act. If the top-N results from the most recent `kb_search` call were automatically injected into the system prompt for the agent's next turn, the agent would have the context available without an extra round-trip. Implementation: the worker tracks the last `kb_search` result in a local variable; `context.js` accepts an optional `kbSearchHits` array and appends it as a fenced "Relevant KB context" block. Clears after each turn so stale context does not bleed across unrelated turns. Addresses spec §11 open question: "Should `kb_search` results bubble up through the system prompt?"

**Rationale:** Reduces tool-call round-trips for common "search then use" patterns without changing the MCP protocol.
**Complexity:** S

---

### Journal entries rendered inline in the task detail view

Currently journal entries live only in `data/agents/<name>/JOURNAL.md`. A user watching a task's detail view must separately read the file to understand what the agent actually did. The task detail view should fetch the tail of the relevant agent's `JOURNAL.md` for the specific run (by scanning for the run's dated header) and render the bullets inline, below the SSE event timeline. A new `GET /api/agents/:name/journal?run=<runId>` endpoint extracts the run-scoped section. Addresses spec §11: "Likely yes in v1.1."

**Rationale:** Closes the gap between the live event stream (what the SDK did) and the journal (what the agent decided), giving a complete human-readable summary without opening a terminal.
**Complexity:** S

---

### Rolling daily/weekly cost aggregates on the Activity page

Currently cost is tracked per `agent_logs` row. The Activity page shows per-run cost but no aggregated view. A summary header added above the run list should display: cost today, cost over the last 7 days, and cost over the last 30 days — broken down by agent. The data is already in `agent_logs.cost_usd`; no schema change is needed, only a new aggregate query endpoint (`GET /api/activity/cost-summary`) and a small UI component. Addresses spec §11: "v2: add activity-page aggregates."

**Rationale:** Daily visibility into spend prevents surprise overruns and helps users tune model choices. The data already exists; only the aggregation and display are missing.
**Complexity:** S

---

### Vector quantization for embeddings

The current embedding storage writes raw `Float32Array` bytes (768 floats × 4 bytes = 3KB per chunk) into the `embeddings` table. At ~10k chunks this is ~30MB in SQLite — manageable. Above that, index scans slow down and the DB balloons. Product quantization (PQ) or scalar quantization (SQ8) can reduce storage by 4–8× with minimal recall loss at typical worklab query volumes. Only needed when the KB + journal + memory corpus grows large enough to be a real problem. Addresses spec §11: "Not needed until ~10k chunks."

**Rationale:** Not urgent. Deferring avoids complexity now; revisit when `worklab doctor` reports the embeddings table exceeding 20MB.
**Complexity:** M (but unclear timing — data-size-gated)

---

## Mid-term (v2-ish)

These items appear in spec §2 as v1 non-goals. They are plausible future work but each requires meaningful design and implementation effort.

### Recurring / scheduled tasks

Enables "every Monday, summarize last week's Slack activity" and similar patterns. A task would gain an optional `schedule` field (cron expression). The coordinator's consolidation cron already has a tick-loop pattern (`consolidation-cron.js`) that can be generalized. New work needed: a `task_schedules` table to store next-fire times and cron expressions, a scheduler that iterates due schedules on each tick and creates task runs, UI to configure schedules on the task edit form, and parent/child tracking so scheduled instances are linked to the template task. Silent failure modes (e.g., the coordinator was offline at fire time) need a clear catch-up policy (fire-once-on-resume vs. skip-missed).

**Why deferred:** Adds persistent state management complexity and silent failure modes that would need careful UX treatment. Not needed until recurring patterns are confirmed as a primary use case.
**Complexity:** L

---

### Cost budgets and enforcement

Today cost is displayed per run and (post v1.1) in rolling aggregates, but never enforced. A budget feature would add daily/monthly spend limits configurable per agent or globally. A pre-flight check before spawning a worker would compare projected cost (estimated from model tier) against remaining budget and block the run with a clear error if it would exceed the limit. Soft-stop (warn at 80%, hard-stop at 100%) with override capability for the user.

**Why deferred:** The estimation problem is hard (token count is unknown before execution). A simpler approach — track actual spend and block the next run once the period limit is exceeded — is viable but requires a well-thought-out UX for the "budget exceeded" state (retry, raise limit, or continue).
**Complexity:** M

---

### Workflow chains

Enables task A's completion to auto-create and optionally auto-run task B with templated input (e.g., "after drafting, send to reviewer agent"). Would require a declarative hook in task frontmatter or a new `task_workflows` table, dependency resolution, cycle detection, and a fan-out spawning path in the coordinator. The task detail view would need to visualize the chain.

**Why deferred:** Powerful but introduces execution graph semantics that are hard to make legible to a non-technical user. Start simple; add chains only when linear tasks are well-understood.
**Complexity:** L

---

### Skill lab

Enables AI-authored skills with human approval: an agent could draft a new skill based on observed patterns, place it in a "proposed skills" queue, and a human approves or rejects it before it enters the active `data/skills/` folder. Needs a new `proposed_skills` table, a dedicated skill-drafting agent, an approval UI on the Skills page, and integration with the existing filesystem skills loader.

**Why deferred:** Meta-level complexity — an agent managing its own capabilities raises trust and auditability questions that warrant careful design. The current skills system (human-authored) is sufficient for v1 usage patterns.
**Complexity:** L

---

### Inter-task dependencies (blocking)

Task B cannot start until task A is in `done`. Useful for multi-step pipelines where output of one task feeds the next, without full workflow-chain automation. Would need a `task_dependencies` table (`blocker_id → blocked_id`), a dependency check in `task-watcher.js` before spawning a worker, and UI affordances (dependency badge, blocked state chip on the kanban card).

**Why deferred:** Workflow chains (above) is a superset; implement that first unless a minimal blocking primitive proves independently valuable. Cycle detection is non-trivial.
**Complexity:** M

---

## Speculative / explicit non-goals (documented, not planned)

These items are listed in spec §2 as v1 non-goals and remain out of scope. Documenting them here so a future reader does not re-open them without context.

### Multi-user / team features

Worklab is single-user by design. No authentication, no user table, no per-user data isolation. If you want team features, consider forking and adding an auth layer (e.g., better-auth) and per-user DB tenancy. This is not a direction the core project will pursue.

### Windows support

Out of scope for v1. The service install path uses launchd (macOS) and systemd user units (Linux). A Windows implementation would need a different service mechanism (NSSM, Task Scheduler, or Windows Service API) and filesystem path handling throughout. No PR will be accepted without a complete Windows service implementation plan and CI coverage.

### Electron / Tauri desktop shell

The browser tab served on `localhost:7878` is the supported UI surface. A desktop shell adds packaging complexity, OS-level auto-update machinery, and ongoing maintenance cost (framework upgrades, code-signing, notarization on macOS) without clear benefit over the existing "install as a background service + open browser" model.

### Cloud backup / sync

`worklab backup` produces a local `.tar.gz`. Getting that file to cloud storage (S3, Backblaze B2, rclone target) is the user's responsibility. The project ships no cloud credentials, no third-party SDK dependency, and no sync daemon. Users who want automated off-site backup can wrap `worklab backup` in a cron job and pipe the output to their preferred tool.

### Authentication

The coordinator binds to `localhost` only. If you expose it over the network (Tailscale, nginx reverse proxy, Cloudflare tunnel), authentication is your responsibility. The project will not add a login page, session management, or token issuance — these are solved problems outside worklab's scope.

---

## Technical debt / cleanup (loose ends after phase-5)

Small items that don't warrant a phase of their own but should be addressed before the code hardens further.

**Zod 4 migration surface.** The codebase currently uses Zod v3 APIs. Zod 4 has a narrower compat shim. If TypeScript is ever introduced, `z.infer<>` strict-mode behavior and `.strict()` schema differences will surface as type errors. Low priority while the project stays in plain ESM JavaScript, but worth a pass before any TypeScript migration.

**Real-SDK-but-offline Ollama smoke test.** The current multi-SDK e2e tests use ESM-level mocking for the Vercel and OpenAI SDK paths. A true offline test that spawns a local `llama.cpp` server (e.g., via a bundled tiny binary) would exercise the real Vercel AI SDK path end-to-end without a network dependency. Optional but would increase confidence in the Ollama provider path.
**Complexity:** M

**`PATCH /api/providers/:id` does not validate `provider_type` consistency.** Flagged during the A1 provider code review: a user can PATCH an `ollama` provider record to `provider_type: "openai_compat"` without resetting `base_url` or clearing the discovery cache, leaving the record in an inconsistent state. A simple guard in `routes-providers.js` — reject `provider_type` changes on existing records (force delete + recreate) — would close this.
**Complexity:** S

**Route-level `fetchImpl` injection.** Flagged during A1 review: `testProvider()` and `discoverModels()` in `providers.js` accept a `fetchImpl` parameter for testing, but the route handlers in `routes-providers.js` do not thread it through. This means provider-related integration tests rely on global `fetch` stubbing rather than dependency injection, making them fragile across Node versions. Passing `fetchImpl` from test helpers via the Express app factory would eliminate the global stub.
**Complexity:** S

---

## How to pick the next phase

**Stabilization criterion:** phase-5 running continuously for 2 weeks without manual intervention. Signals that the system is stable:

- No unhandled exceptions in `data/logs/coordinator.log` across multiple consolidation cycles.
- No consolidation runs producing malformed or empty `MEMORY.md` files.
- Embeddings index stays current with filesystem changes (chokidar watcher does not fall behind or crash).
- No drift between entries in `data/knowledge/` and `kbList` tool output.
- `worklab doctor` reports green on all checks after each restart.

**When ready:** pick ONE near-term item from the list above, read spec §8 for the implementation pattern, write `docs/plans/phase-6.md` as a specific plan (not a roadmap), execute using the subagent-driven-development workflow with TDD and two-stage review, and tag `phase-6` on completion. The near-term items are roughly ordered by value-to-effort ratio; the rolling cost aggregates and journal inline view are the strongest candidates for a first v1.1 release.
