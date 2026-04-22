# Worklab

Local, single-user AI agent orchestration tool for work tasks.

## Documentation

- **Product spec (PRD):** [`/opt/claude-workspace/docs/superpowers/specs/2026-04-21-worklab-design.md`](/opt/claude-workspace/docs/superpowers/specs/2026-04-21-worklab-design.md)
- **Phase 1 plan** — skeleton, DB, CLI, tasks-only MVP: [`/opt/claude-workspace/docs/superpowers/plans/2026-04-21-worklab-phase-1.md`](/opt/claude-workspace/docs/superpowers/plans/2026-04-21-worklab-phase-1.md) (tag `phase-1`)
- **Phase 2 plan** — Claude agent runtime, skills, MCP, journaling: [`/opt/claude-workspace/docs/superpowers/plans/2026-04-22-worklab-phase-2.md`](/opt/claude-workspace/docs/superpowers/plans/2026-04-22-worklab-phase-2.md) (tag `phase-2`)
- **Phase 3 plan** — reviewer loop, KB CRUD, pinned KB in prompts, comment UI polish: [`/home/mickey/.claude/plans/using-writing-plans-baseed-calm-pine.md`](/home/mickey/.claude/plans/using-writing-plans-baseed-calm-pine.md) (tag `phase-3`)

Upcoming phases (plans not yet written):
- **Phase 4** — multi-SDK, custom providers, encryption.
- **Phase 5** — consolidation, semantic search, service install, backup, activity/settings polish.

## Quick start

```bash
npm install
npm run build:ui
npm start
```

Open http://localhost:7878.
