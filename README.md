# Worklab

Worklab is a local, single-user AI agent orchestration workspace.

The task and agent workflow is being redesigned around a code-derived audit:

- [Task and agent logic audit](docs/audits/task-agent-logic-audit.md)

Older architecture, PRD, phase-plan, and setup docs were removed because the
code has moved faster than those documents and they were no longer reliable.
Use the source and tests as the operational truth until new implementation
docs are generated from the v2 workflow.

## Current Direction

- Agents can run through SDK-backed providers and local Claude Code/Codex CLI
  runtimes today.
- Tasks should support autonomous agent planning, subtask creation, subagent
  delegation, parent/child joins, structured results, and recoverable errors.

## Development

```bash
npm install
npm test
```

For local startup:

```bash
npm start
```

Open `http://localhost:7878`.

## License

MIT. See [LICENSE](LICENSE).
