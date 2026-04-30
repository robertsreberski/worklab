# `src/ai/` — Provider Layer

Pure provider plumbing: SDKs, CLIs, the structured-result contract, failure
classification, and streaming-event normalization. This layer **never reads
or writes the database**, knows nothing about the workflow state machine,
and does not spawn workers — it is a pi-mono-style provider kernel that
the agent kernel (`src/agent/`) and the rest of the app consume through
the registry.

## May import from

- Third-party packages (`@anthropic-ai/claude-agent-sdk`, `@mariozechner/pi-ai`,
  `@mariozechner/pi-agent-core`, `zod`, `@modelcontextprotocol/sdk`)
- Other files inside `src/ai/`

## Must NOT import from

- `better-sqlite3`, `node:fs` for project-state writes
- `src/core/`, `src/coordinator/`, `src/api/`, `src/mcp/`,
  `src/integrations/`, `src/cli/`, `src/agent/`, `src/worker/`

## Future shape

```
src/ai/
├── index.js              # public re-exports
├── types.js              # ApiProvider, RunRequest, ProviderEvent, ProviderResult
├── registry.js           # registerProvider / getProvider / listProviders
├── failure.js            # classifyFailure + failure-kind taxonomy
├── result/
│   ├── contract.js       # worklab_result schema + version
│   ├── parser.js
│   └── decisions.js
├── streaming/
│   ├── normalize.js
│   └── events.js
└── providers/
    ├── claude-sdk.js
    ├── pi-sdk.js
    ├── claude-cli.js
    ├── codex-cli.js
    └── codex-app.js
```

Phase 3 progressively populates this layout and replaces the
`src/core/ai-*.js` and `src/core/failure-kind.js` files with re-export
shims so existing importers keep working while the migration is in flight.
