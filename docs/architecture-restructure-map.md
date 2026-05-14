# Architecture Restructure Implementation Map

This map grounds the restructure work in the current source shape. It is not an
aspirational replacement for `docs/ARCHITECTURE.md`; update the architecture
guide after the code changes land.

## Source Baseline

- Runtime shape: local-first Node app with CLI/service entrypoints,
  `src/coordinator.js`, Express/SSE API, SQLite, workers, Preact UI, optional
  Slack and Web Push integrations.
- Current boundary guard: `eslint.config.js` keeps `src/core` free of edge
  imports, bans API `db.prepare()`, and forces edge layers through the broad
  `src/core/index.js` barrel except query helpers and documented coordinator
  carve-outs.
- Current coordinator seam: `src/coordinator.js` owns data-dir bootstrapping,
  PID checks, DB open/seeding, server/static UI setup, watcher/manager
  construction, optional service startup, event-loop monitoring, signal
  handling, shutdown/drain, and test handles.
- Current core seam: `src/core/index.js` exports database lifecycle, workflow,
  runtime/provider dispatch, config, settings, run input/logs/artifacts,
  notifications, live input, comments, attachments, KB, mentions, journals,
  memory, projects, and more through one public barrel.

## Track Map

| Track | Current modules | Target modules | Tests / verification | Risk notes |
| --- | --- | --- | --- | --- |
| 1. Thin coordinator | `src/coordinator.js` | `src/coordinator/bootstrap.js`, `src/coordinator/http-static.js`, `src/coordinator/event-loop-monitor.js`, `src/coordinator/service-registry.js`, `src/coordinator/shutdown.js` or smaller equivalents | `src/__tests__/coordinator/startup.test.js`, shutdown tests, `npm run lint` | Preserve exported `startCoordinator`, `startDeferredService`, and `createWatcherProxy` compatibility for tests/API helpers. |
| 2. Background service registry | Inline `startOptionalServices()` in `src/coordinator.js`; managers expose inconsistent lifecycles | Registry that starts/stops/statuses consolidation, automation, team lead, search, event-loop monitor, push, Slack | Startup tests plus new lifecycle unit tests | Optional services must not block `/api/health`; Slack start timeout semantics must remain unchanged. |
| 3. Core domains | Broad `src/core/index.js`; future-shape note in `src/core/README.md` | Compatibility-preserving barrels under `src/core/workflow`, `src/core/runtime`, `src/core/content`, `src/core/platform`, and existing `src/core/db` | Import smoke tests or focused lint; existing core/API/coordinator tests | Start with public entrypoints that re-export existing modules; move implementation only when safe. |
| 4. Narrow imports | Edge imports currently encouraged through `src/core/index.js` | Callers import from the narrowest domain barrel where practical; lint docs updated | `npm run lint`, `./scripts/guard-imports.sh` | Do not flip lint to require narrow imports until enough callers migrate. |
| 5. Task watcher privilege | `src/coordinator/task-watcher.js` plus watcher helpers | More explicit watcher services for scheduling/finalization/recovery/delegation/dependent updates | `task-watcher*.test.js`, watcher subdirectory tests | Existing watcher helpers already cover part of this; avoid destabilizing state-machine side effects. |
| 6. Run event/log store | `src/core/run-logs.js`, `src/core/run-log-compaction.js`, `src/core/run-events.js`, `src/core/run-compactions.js`, `src/coordinator/spawn-worker.js`, `src/api/routes/runs.js` | `src/core/runtime/run-event-store.js` or `src/core/runs/run-event-store.js` behind a compatibility export | `run-events`, `run-log-compaction`, `spawn-worker`, `routes-runs` tests | Raw JSONL stays full-fidelity; DB timeline remains compact. |
| 7. Run-like lifecycle | Task run, assistant, Slack triage, automation, and lead-cycle paths each shape status/log/cost/failure data | Shared helpers for status, failure classification, cost/usage, event-log/timeline shaping | Focused tests for any touched domain | Do not force a schema merge without a migration plan. |
| 8. Webhook adapter | `src/api/routes/automations.js` imports `@worklab-ai/webhooks`; `src/core/mcp-config.js` exposes package command | `src/integrations/webhooks` adapter for package-facing normalization/config | Automation route tests and mcp-config tests | Keep package reusable and DB-free. |
| 9. Soft references | Soft references called out in `docs/ARCHITECTURE.md` and schema | FK migrations where safe, or documented invariants plus domain-service tests | DB migration tests, schema tests, affected API/core tests | Migration risk is high; default to documenting/enforcing invariant before adding FKs. |
| 10. UI API contracts | `src/ui/src/lib/api.js` is the central client; routes are lazy | Feature API modules only where clarity improves; keep shared request primitive | UI unit tests and build | Avoid UI churn unless a touched API contract warrants it. |
| 11. Health phases | `/api/health` returns core process/schema/package state; optional statuses are embedded in feature routes | Keep `/api/health` core-only; add optional service status endpoint/field separately if useful | `server-health.test.js`, startup tests | Startup readiness should not wait on indexing, Slack, push, or other optional managers. |
| 12. Docs drift | `docs/ARCHITECTURE.md` references current source but may drift after extraction | Update architecture guide, READMEs, release/runtime references after code changes | `git diff --check`; source spot checks | Do docs last in each batch so paths remain accurate. |

## Batch Plan

1. Extract coordinator support modules without changing behavior.
2. Introduce a lifecycle registry for optional services and route coordinator
   optional startup/shutdown through it.
3. Add core domain barrels as compatibility layers, then migrate low-risk
   coordinator/API imports.
4. Extract run event/log store around existing log readers and compaction
   helpers before moving API/spawn-worker logic behind it.
5. Add the webhook adapter and update automation/MCP surfaces to consume it.
6. Audit soft references and document/enforce invariants before any FK
   migration.
7. Update architecture docs and boundary docs to describe the new seams.
