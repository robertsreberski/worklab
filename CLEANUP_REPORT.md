# Cleanup Report

Managed by behavior-preserving-cleanup plugin.

## Summary

- Objective: smaller, simpler, behavior-preserving cleanup with no public API, schema, auth, package export, or generated-output changes.
- Baseline: recorded in `CLEANUP_BASELINE.md` at commit `990aef16edc2e2ca3a53e698e4816f7b76d8fa8d`.
- Applied cleanup: removed unused internal helpers/exports, one ineffective UI condition, and duplicate CLI flag wrappers.
- Final validation: focused validations for edited areas passed; full validation remains red only in known baseline/flaky areas documented below.

## Metrics

- P0/P1 Cleanup Completion Rate: 100% (26/26 P0/P1 findings resolved or kept with rationale).
- Introduced validation failures: 0 attributed to edited areas.
- New production dependencies: 0.
- Unapproved public API changes: 0.
- P2/P3 findings changed without explicit approval: 0.

## Changes Applied

| Finding ID | Severity | Action | Validation |
| --- | --- | --- | --- |
| LOCAL-001 | P0 | Removed unused `__eventCoalescerTest` export. | `src/__tests__/worker/event-coalescer.test.js` passed in focused batch. |
| DC-002 | P0 | Removed always-truthy `language || true` branch in `CodeBlock`. | `npm run build:ui` passed. |
| DC-003 | P0 | Removed unused Slack `shouldProcessSlackMessage` wrapper. | `src/__tests__/integrations/slack.test.js` passed in focused batch. |
| DC-004 to DC-009 | P0 | Removed unused internal DB query helpers with no call sites. | Relevant API/core focused tests passed in focused batch. |
| AR-002 | P0 | Removed unused KB mirror-builder helpers and stale file comment. | `src/__tests__/coordinator/task-watcher.test.js` passed in focused batch. |
| AR-003 | P0 | Removed unused rich-final helper chain. | `src/__tests__/coordinator/task-watcher.test.js` passed; one unrelated review test flaked in batch and passed in isolation. |
| AR-010 | P1 | Inlined single-use `compactedEvents` wrapper. | `src/__tests__/cli/compact-logs.test.js` passed in focused batch. |
| AR-011 | P1 | Reused `hasFlag(args, "--dry-run")` in service install/uninstall code. | CLI focused tests passed in focused batch. |

## Findings Kept

| Finding ID | Severity | Rationale |
| --- | --- | --- |
| DC-001 | P0 | Kept because package dependency shape and lockfile updates are public release/install surfaces. |
| DCR-001 | P0 | Kept because moving `preact` affects root package install shape and possible UI rebuild behavior. |
| DCR-002 to DCR-005 | P1 | Kept because package scripts and validation wiring are developer workflow policy, not low-risk product cleanup. |
| DCR-006 | P3 | Kept because release/package validation is a P3 package-contract surface requiring explicit approval. |
| AR-001 | P1 | Kept because coordinator lifecycle tests are unstable and the refactor touches orchestration behavior. |
| AR-004 to AR-005 | P1 | Kept because provider prompt/error formatting is public package behavior. |
| AR-006 to AR-009 | P1 | Kept because these are broader cross-boundary refactors not needed for a safe cleanup batch. |

## Risk Notes

- No DB schema, migration, serialized run format, MCP tool schema, HTTP API contract, auth, secret-handling, generated UI, or package export files were changed.
- Internal exported helpers were removed only after `rg` found no source, test, script, or doc call sites.
- Full-suite test results vary in coordinator/worker tests; two extra failures beyond the saved baseline passed when rerun in isolation.

## Validation Evidence

| Command | Result | Notes |
| --- | --- | --- |
| `npx vitest run ...focused edited-area tests...` | Failed with 1 coordinator flake | 331 passed, 1 failed in `task-watcher-review`; failed test passed in isolation. |
| `npx vitest run src/__tests__/coordinator/task-watcher-review.test.js -t "re-delegation supersedes"` | Passed | Isolated rerun of focused-batch flake. |
| `npx vitest run src/__tests__/coordinator/spawn-worker.test.js -t "delivers live user messages"` | Passed | Isolated rerun of extra full-suite worker failure. |
| `npm run build:ui` | Passed | Final validation passed. |
| `npm run pack:check` | Passed | Final validation passed. |
| `git diff --check` | Passed | Final validation passed. |
| `npm run lint` | Failed, baseline-matching | Same 6 direct `db.prepare` violations in `src/api/routes/mentions.js`. |
| `npm run lint:size` | Failed, baseline-matching | Same oversized `AgentEdit.jsx` and `task-watcher.js` files. |
| `npm test` | Failed | Final: 6 failed files, 19 failed tests. Baseline: 5 failed files, 17 failed tests. Extra two coordinator/worker failures passed in isolation and are not in edited code paths. |
