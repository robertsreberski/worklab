# `src/agent/` — Agent Kernel

Generic agent runtime: the run loop, transcript snapshotting, context
compaction, allowlist resolution, and the built-in tool registry. The
kernel takes injected dependencies (provider, DB-backed config, hooks)
so the worker, the assistant, and Slack triage all share one runtime.

## May import from

- `src/ai/` (provider registry, contract, failure taxonomy)
- Third-party packages (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`,
  `zod`, `@modelcontextprotocol/sdk`)
- Other files inside `src/agent/`

## Must NOT import from

- `better-sqlite3`
- `src/core/`, `src/coordinator/`, `src/api/`, `src/mcp/`,
  `src/integrations/`, `src/cli/`, `src/worker/`

## Future shape

```
src/agent/
├── index.js              # public re-exports
├── types.js              # Agent, RunRequest, RunOutcome, ToolContext
├── run.js                # the run loop
├── compaction.js         # context-overflow handling
├── transcript.js         # snapshot helpers
├── allowlists.js         # skill / mcp / builtin filters
├── tools/
│   ├── registry.js
│   ├── read.js / write.js / edit.js / glob.js / grep.js / bash.js / web-fetch.js / web-search.js
└── prompt/
    ├── system-prompt.js
    ├── skills-index.js
    └── tool-surface.js
```

Phase 4 progressively populates this layout. The current pass moves the
kernel-shaped helpers (compaction, transcript, allowlists,
ai-tool-helpers) without yet introducing the run loop — that arrives in
Phase 5 when worker.js gets decomposed.
