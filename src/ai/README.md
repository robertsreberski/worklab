# `src/ai/` — Provider Layer

Pure provider plumbing: SDKs, CLIs, the structured-result contract, failure
classification, and streaming-event normalization. This layer **never reads
or writes the database**, knows nothing about the workflow state machine,
and does not spawn workers — it is a pi-mono-style provider kernel that
the agent kernel (`src/agent/`) and the rest of the app consume through
provider backends.

## May import from

- Third-party packages (`@anthropic-ai/claude-agent-sdk`, `@mariozechner/pi-ai`,
  `@mariozechner/pi-agent-core`, `zod`, `@modelcontextprotocol/sdk`)
- `src/agent/` for kernel-owned tool, skill-path, and compaction helpers
- Other files inside `src/ai/`

## Must NOT import from

- `better-sqlite3`, `node:fs` for project-state writes
- `src/core/`, `src/coordinator/`, `src/api/`, `src/mcp/`,
  `src/integrations/`, `src/cli/`, `src/worker/`

## Layout

```
src/ai/
├── index.js
├── backend.js
├── cost.js
├── failure.js
├── file-change-stats.js
├── live-input-prompt.js
├── pi-oauth.js
├── registry.js
├── result/
│   ├── contract.js
│   └── decisions.js
├── streaming/
│   └── codex-events.js
└── providers/
    ├── claude-sdk.js
    ├── pi-sdk.js
    ├── claude-cli.js
    └── codex-app.js
```
