# Contributing to Worklab

Worklab is a single-user tool. Contributions are welcome, but the scope is
guarded by the [product spec](docs/spec/worklab-design.md) §2 and the
[Phase 6+ roadmap](docs/plans/phase-6-roadmap.md). Before opening a PR for a
non-trivial change, please confirm it aligns with one of those documents, or
file an issue to discuss.

## Development workflow

- **Node 20+** required. Run `npm install` at the repo root.
- **Test-driven development.** Every new feature or bugfix gets a failing
  test first, then the implementation, then a passing test. See
  `src/__tests__/` for existing patterns (unit under `core/`, API under
  `api/`, coordinator under `coordinator/`, e2e under `e2e/`).
- Run `npm test` before every commit. Coverage thresholds are enforced
  (60% lines / functions / branches / statements on `src/` excluding
  `__tests__` and `ui`).
- Follow the existing module structure: pure domain logic under
  `src/core/`, orchestration under `src/coordinator/`, HTTP routes under
  `src/api/`, CLI under `src/cli/`, MCP tools under `src/mcp/`, UI under
  `src/ui/`.
- See [architecture.md](docs/architecture.md) for a tour of how the
  pieces fit together.

## Commit style

- Conventional commits: `type(scope): subject`.
  - Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.
  - Example: `feat(kb): add pinned KB cap setting`.
- One focused change per commit. Bundle the test and the code.
- For phase-level work, suffix with `(phase-N TX)` (matches the existing
  phase plan format).
- Use a HEREDOC multi-line body when context warrants it.

## Phase discipline

New user-facing features land in numbered phases:

1. Pick a near-term candidate from [phase-6-roadmap.md](docs/plans/phase-6-roadmap.md).
2. Write a concrete `docs/plans/phase-N.md` following the Phase 3/4/5
   plan format (context, out-of-scope, file structure, task list with
   acceptance criteria, verification).
3. Execute the plan using test-driven development with two-stage review
   (spec compliance first, then code quality).
4. Tag `phase-N` on completion. Update `CHANGELOG.md` with a new entry.

Skipping the plan step is tempting but costs more time when scope drift
starts happening mid-implementation. Write the plan.

## What to avoid

- **No push to `main` without `npm test` green.**
- **No amend/force-push on `main`.** Create a follow-up commit instead.
- **No new dependencies without justification** — the project is
  deliberately low-bloat. If a dep adds a small feature you could write
  yourself in 30 lines, write the 30 lines.
- **Don't break filesystem-as-source-of-truth.** KB entries, skills,
  journals, and memory live in `data/` on disk; the DB is an index.
  Deleting the DB and rebuilding from disk must always work (enforced
  by tests).
- **No features from the spec §2 non-goal list** (auth, multi-user,
  cloud backup, recurring tasks, Windows, desktop shell) without prior
  discussion.

## Questions

Open a GitHub issue. Keep it scoped to a single concern.
