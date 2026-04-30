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

## Future shape

```
src/coordinator/
├── index.js                  # createCoordinator bootstrap
├── watcher/                  # decomposed task-watcher.js
│   ├── index.js              # main loop / event dispatch
│   ├── run-handler.js
│   ├── stage-router.js
│   ├── delegation-handler.js
│   ├── parent-resumer.js
│   ├── kb-publisher.js
│   ├── failure-classifier.js
│   ├── verdict-parser.js
│   └── final-text.js
├── spawn-worker.js
├── automation-manager.js
├── consolidation-cron.js
├── search-indexer.js
└── stale-recovery.js
```
