# Contributing To Worklab

Worklab is in an active task/agent workflow redesign. The current planning
reference is the code-derived audit:

- [Task and agent logic audit](docs/audits/task-agent-logic-audit.md)

Older PRD, architecture, phase-plan, and setup docs were removed because they
were stale. Do not reintroduce behavior based on those deleted documents.

## Development Workflow

- Use Node 20+.
- Run `npm install` at the repo root.
- Run `npm test` before committing.
- Run `npm run lint`, `npm run lint:size`, and `./scripts/guard-imports.sh`
  for repo-wide cleanup or modularization work.
- Keep source changes close to the existing module boundaries:
  `src/core`, `src/coordinator`, `src/api`, `src/mcp`, `src/cli`, and `src/ui`.
- Add or update tests for workflow logic, provider behavior, recovery paths,
  and UI states touched by the change.

## Commit Style

- Use conventional commits: `type(scope): subject`.
- Keep commits focused.
- Include tests with behavior changes.
- Do not rewrite unrelated files or revert unrelated local changes.

## Current Design Constraints

- Prefer a clean v2 workflow over compatibility with obsolete task states.
- Keep task workflow state separate from run process state.
- All agent runtimes should converge on one structured result contract.
- Agents should request task/subtask changes through controlled APIs or MCP
  tools, not by editing DB/files directly.
- The system should recover from provider errors, invalid results, stale
  workers, cancellation, and repeated rejection loops with clear user-facing
  state.
