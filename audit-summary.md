# Audit Summary

## Changed

- Restored boundary clarity by moving runtime capability metadata and built-in
  tool constants to leaf modules, then retargeting callers through the public
  core/runtime seams.
- Removed high-confidence dead code: obsolete root UI compatibility components,
  an unused live ticker hook, an unused task-run selector, stale SelectField
  CSS, and the unused root `picomatch` dependency.
- Reconciled contradictory references in `CLAUDE.md`, npm release docs, runtime
  bridge docs, UI README, and architecture notes. Added
  `docs/audits/task-agent-logic-audit.md` so AGENTS/CONTRIBUTING point at a real
  current reference.
- Reduced structural drift by extracting the shared worker runtime turn runner,
  shared editor guard/delete modals, task detail activity UI, and Settings
  overview metadata.
- Brought oversized source files back under the 1200-line guard:
  `src/ui/src/routes/Settings.jsx` and `src/ui/src/routes/TaskDetail.jsx`.

## Deferred

- No approved audit findings were deferred.
- `depcheck` still reports `@vitest/coverage-v8` as unused, but it is retained
  because `npm run test:coverage` loads it through Vitest configuration rather
  than a direct source import.
- The pre-existing untracked `goals/documentation.md` was left untouched.

## Verification

- `npm test` -> 207 files passed, 2155 tests passed.
- `npm run lint` -> passed.
- `npm run lint:size` -> passed; largest file is now
  `src/coordinator/task-watcher.js` at 1194 lines.
- `./scripts/guard-imports.sh` -> passed.
- `npm run build:ui` -> passed.
- `npm run pack:check` -> passed.
- `npx -y madge --circular --exclude '^src/ui/dist/' src packages` -> no
  circular dependencies found.
- `git diff --check` -> passed.

## Commits

- `6b14184c` refactor: align boundaries and break utility cycles
- `e40044b3` chore: remove stale dead code and dependency noise
- `aba8e3b1` docs: align current workflow and release references
- `ed8ab468` refactor: clarify runner and editor structure
- `d23d7af0` test: follow extracted task activity component
