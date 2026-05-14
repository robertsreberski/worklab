# `src/coordinator/` — Process Orchestrator

Owns scheduling, worker spawning, and post-run reconciliation. The coordinator
turns DB state into spawn decisions and records the outcomes; it never runs
agent code in-process.

## May import from

- `src/core/` (domain + DAL)
- `src/agent/` (kernel — to derive run inputs)
- `src/ai/` (provider registry — to pre-validate before spawn)

## Must NOT import from

- `src/api/`, `src/mcp/`, `src/integrations/`, `src/cli/`, `src/worker/`
- `better-sqlite3` directly

## Layout

```
src/coordinator/
├── service-registry.js
├── startup-timer.js
├── event-loop-monitor.js
├── static-ui.js
├── watcher-proxy.js
├── task-watcher.js
├── watcher/
│   ├── auto-start-scheduler.js
│   ├── run-handler.js
│   ├── delegation-handler.js
│   ├── kb-publisher.js
│   ├── failure-classifier.js
│   └── final-text.js
├── spawn-worker.js
├── automation-manager.js
├── consolidation-cron.js
└── search-indexer.js
```
