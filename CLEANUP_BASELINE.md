# Cleanup Baseline

Managed by behavior-preserving-cleanup plugin.

## Repository

- Path: `/opt/claude-workspace/local/worklab`
- Branch: `main`
- Commit: `990aef16edc2e2ca3a53e698e4816f7b76d8fa8d`
- Recorded: `2026-06-02T13:13:53Z`

## Install Commands

- Command: `npm install`
- Result: Passed after restoring local dependencies.
- Notes: npm reported 18 audit findings: 13 moderate, 3 high, 2 critical. No tracked files changed.

## Validation Commands

| Command | Result | Notes |
| --- | --- | --- |
| `node --version && npm --version` | Passed | Node `v25.8.0`, npm `11.9.0`; package engine requires Node `>=20`. |
| `npm test` before install | Failed | Incomplete local dependencies caused 133 failed suites and 11 failed tests. Superseded by post-install baseline. |
| `npm test` after install | Failed | 5 failed files, 17 failed tests; details below. |
| `npm run build:ui` before install | Failed | `vite-plugin-pwa` missing from incomplete local dependencies. Superseded by post-install baseline. |
| `npm run build:ui` after install | Passed | Vite/PWA build completed. |
| `npm run lint` before install | Failed | `eslint` missing from incomplete local dependencies. Superseded by post-install baseline. |
| `npm run lint` after install | Failed | 6 `no-restricted-syntax` errors in `src/api/routes/mentions.js` for direct `db.prepare` use in API routes. |
| `npm run lint:size` | Failed | `src/ui/src/routes/AgentEdit.jsx` has 1233 lines and `src/coordinator/task-watcher.js` has 1205 lines, over the 1200-line limit. |
| `npm run pack:check` | Passed | npm pack dry run validated 294 package files. |
| `npm run test:e2e:ollama` | Not run | Requires an Ollama-backed e2e environment; not practical for this cleanup baseline. |

## Pre-Existing Failures

- `npm test` post-install fails in `src/__tests__/coordinator/shutdown-drain.test.js`: `transcript_tail_json` is null where the test expects a drain snapshot.
- `npm test` post-install fails in `src/__tests__/coordinator/spawn-worker.test.js`: running log events are empty where the test expects sequence ids `[1, 2]`.
- `npm test` post-install fails in `src/__tests__/ui/assistant-run-stream.test.js`: 2 EventSource/global stream tests do not create or receive the fake EventSource.
- `npm test` post-install fails in `src/__tests__/ui/use-run-stream.test.js`: 10 EventSource/run stream tests do not create or receive the fake EventSource.
- `npm test` post-install fails in `src/__tests__/ui/use-sse.test.js`: 3 EventSource/SSE tests do not create or receive the fake EventSource.
- `npm run lint` fails in `src/api/routes/mentions.js` at direct `db.prepare` calls on lines 335, 371, 395, 405, 416, and 427.
- `npm run lint:size` fails because `src/ui/src/routes/AgentEdit.jsx` and `src/coordinator/task-watcher.js` exceed 1200 lines.

## Notes

- Behavior-preserving cleanup must introduce zero failures beyond this baseline.
- Full validation can remain red only for the pre-existing failures listed above.
