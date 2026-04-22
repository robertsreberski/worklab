# Configuration

Environment variables, UI settings, data directory layout, and security details.

---

## Environment Variables

Set these in your shell, a `.env` file loaded by your process manager, or a
systemd `Environment=` directive. None are required — defaults work for local use.

| Variable | Default | Purpose |
|----------|---------|---------|
| `WORKLAB_PORT` | `7878` | HTTP port the coordinator listens on |
| `WORKLAB_DATA_DIR` | `<repo>/data` | Path to the data directory |
| `WORKLAB_WORKSPACE` | `~/worklab-workspace` | Working directory made available to agents |
| `PROVIDER_ENCRYPTION_KEY` | auto | 32-byte hex or base64 master key for provider API key encryption. If unset, a random key is generated and saved to `data/.provider-encryption-key` on first boot. |
| `ANTHROPIC_API_KEY` | — | API key for the Claude Agent SDK path |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token for Claude subscription auth (alternative to API key) |
| `OPENAI_API_KEY` | — | API key for the OpenAI Agents SDK path |
| `WORKLAB_LOG_LEVEL` | `info` | Log verbosity (`trace`, `debug`, `info`, `warn`, `error`) |
| `WORKLAB_TIMEZONE` | system | IANA timezone string (e.g. `Europe/Amsterdam`) used for consolidation scheduling |

Source: `src/core/config.js`.

---

## Settings Table

These settings are persisted in the database and editable via **Settings** in the
web UI. Changes take effect immediately without restart.

| Key | Default | Description |
|-----|---------|-------------|
| `consolidation_hour` | `3` | Hour (0–23, local time) when nightly memory consolidation runs |
| `consolidation_enabled` | `true` | Master switch for the nightly consolidation cron |
| `default_embedding_model` | `ollama:nomic-embed-text` | Model used for semantic search indexing. Format: `ollama:<model>` or `openai:<model>` |
| `journal_tail_lines` | `80` | Number of journal lines fed to the consolidation agent |
| `kb_pinned_limit` | `10` | Maximum number of pinned knowledge base entries injected into every system prompt |
| `worker_timeout_ms` | `1800000` | Hard timeout for a single worker run (ms). Default is 30 minutes. |
| `cancel_grace_ms` | `5000` | Time the coordinator waits after SIGTERM before force-killing a worker |

Source: `src/core/settings.js`.

---

## Data Directory Layout

```
data/
├── worklab.db               — SQLite database (WAL mode)
├── worklab.db-wal           — WAL journal (present during writes)
├── worklab.db-shm           — Shared memory file
├── .coordinator.pid         — PID of the running coordinator (deleted on clean shutdown)
├── .provider-encryption-key — 32-byte master key (0600 perms; auto-generated if absent)
├── config/
│   └── mcp.json             — User MCP server registry (Claude Desktop format)
├── agents/
│   └── <name>/
│       ├── JOURNAL.md       — Append-only work log written by the agent
│       └── MEMORY.md        — Distilled long-term memory, rewritten by consolidation
├── skills/
│   └── <name>/
│       └── SKILL.md         — Skill definition with YAML frontmatter
├── knowledge/
│   └── <slug>.md            — Knowledge base entry (body + metadata as frontmatter)
└── logs/
    ├── worklab.out.log      — stdout from the service (when managed by launchd/systemd)
    ├── worklab.err.log      — stderr from the service
    └── workers/
        └── <run-id>.log     — Per-run worker logs
```

---

## `data-template/` vs `data/`

`data-template/` is git-tracked and contains the default seed files (empty
agent directories, example skill, etc.). It is never modified at runtime.

`data/` is git-ignored runtime state. On first boot, if `data/` is empty,
worklab copies `data-template/` into it (see `src/core/first-boot.js`).

To reset to defaults: delete `data/` and restart. All database records, agent
memory, and provider keys will be lost.

---

## Provider Encryption Key

Worklab encrypts stored provider API keys with AES-256-GCM. The encryption key
is resolved in this order:

1. `PROVIDER_ENCRYPTION_KEY` environment variable (hex or base64, ≥ 32 bytes)
2. `data/.provider-encryption-key` file (binary, created 0600 on first boot)

**Rotation warning:** if you delete `data/.provider-encryption-key` or change
`PROVIDER_ENCRYPTION_KEY`, all previously stored provider API keys become
unreadable. You will need to re-enter them in **Settings → Providers**.

Source: `src/core/crypto.js`.

---

## MCP Config (`data/config/mcp.json`)

Optional. Uses Claude Desktop JSON format:

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "/usr/local/bin/my-mcp-server",
      "args": ["--port", "3000"]
    }
  }
}
```

The built-in `worklab` MCP server (task management, journal, KB tools) is
always injected and does not need to be listed here.

**Security constraints:**
- stdio `command` paths must be absolute.
- Remote URLs must resolve to a private/local address, OR the provider must
  have "Trust public URL" explicitly enabled in the Providers UI.
