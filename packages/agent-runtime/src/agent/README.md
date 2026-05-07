# `src/agent/` — Agent Kernel

Generic agent runtime helpers: transcript snapshotting, context compaction,
allowlist resolution, prompt construction, built-in tools, and the PI MCP
tool bridge. The worker, assistant, and integration paths pass DB-backed
configuration into these helpers instead of letting the kernel read domain
state directly.

## May import from

- `src/ai/` (provider registry, contract, failure taxonomy)
- Third-party packages (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`,
  `zod`, `@modelcontextprotocol/sdk`)
- Other files inside `src/agent/`

## Must NOT import from

- `better-sqlite3`
- `src/core/`, `src/coordinator/`, `src/api/`, `src/mcp/`,
  `src/integrations/`, `src/cli/`, `src/worker/`

## Layout

```
src/agent/
├── index.js
├── compaction.js
├── transcript.js
├── allowlists.js
├── tools/
│   ├── index.js
│   ├── pi-bridge.js
│   ├── read.js / write.js / edit.js / glob.js / grep.js / bash.js / web-fetch.js / web-search.js
│   └── shared/
└── prompt/
    ├── system-prompt.js
    └── skill-index.js
```
