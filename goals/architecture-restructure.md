/goal Thoroughly simplify and modularize the Worklab architecture, using the current architecture guide as the source-grounded map and implementing the twelve restructure tracks below.

## Objective

Restructure the existing local-first Worklab monolith so the architecture is easier to understand, safer to extend, and more modular inside the current process/package shape. Preserve the product behavior, local runtime model, SQLite persistence, worker process model, HTTP/SSE API, and Preact UI. Do not turn Worklab into microservices, introduce an external queue, or create a parallel agent/team orchestration system.

Use `docs/ARCHITECTURE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, the test suite, and the source code as the authority. If documentation and source disagree, trust the source and update docs only after confirming the live code path.

## Required restructuring tracks

Implement all twelve tracks, in a practical order that minimizes regression risk:

1. **Thin coordinator composition root**
   - Split coordinator startup into clear modules for bootstrap, HTTP/static server construction, background service startup, shutdown/drain handling, and process/runtime monitoring.
   - Keep the top-level coordinator entrypoint as orchestration glue, not a module that owns every subsystem directly.

2. **Background service registry**
   - Introduce a common lifecycle shape for optional/background services such as automation, team lead cycle, search indexing, Slack, push notifications, consolidation, and similar managers.
   - Each service should expose start/stop/status or equivalent lifecycle hooks, with clear handling for optional failures.

3. **Bounded `src/core` domains**
   - Split core public surface by domain while preserving existing behavior:
     - `core/workflow`: projects, tasks, runs, dependencies, delegation, stage transitions.
     - `core/runtime`: model/provider dispatch, runtime session/cost tracking, tool/runtime contracts.
     - `core/content`: knowledge, journals, memory, embeddings, search.
     - `core/platform`: config, settings, credentials, service tokens, notifications.
     - `core/db`: schema, migrations, DB lifecycle, query helpers.
   - Move code incrementally. Do not perform a giant rename if a smaller compatibility layer is safer.

4. **Reduce giant core barrel imports**
   - Reduce reliance on broad `src/core/index.js` imports.
   - Add domain entrypoints and update callers to import from the narrowest stable domain.
   - Preserve compatibility where needed, but make new boundaries clear and enforceable.

5. **Shrink task watcher privileged access**
   - Reduce the task watcher's direct dependency on deep core internals.
   - Extract explicit services such as run scheduling, run finalization, recovery planning, delegation handling, and parent/dependent task updates.
   - Prefer command-style core APIs for workflow state transitions.

6. **Centralize run/event/log persistence**
   - Introduce a clear `RunEventStore` or equivalent module that owns append, compaction, hydration, tailing, raw-log path validation, and semantic timeline shaping.
   - Preserve raw JSONL logs as the durable full-fidelity truth.
   - Keep SQLite event rows compact enough for fast UI/API loading.

7. **Normalize run-like lifecycle behavior**
   - Identify common lifecycle behavior across task runs, assistant runs, Slack triage, automation executions, and any other run-like process.
   - Share status, failure classification, event-log, transcript, cost/usage, and result-shaping helpers where appropriate.
   - Do not force one mega-table unless the current schema and migration risk clearly support it.

8. **Webhook integration adapter**
   - Centralize use of `@worklab-ai/webhooks` behind a local Worklab integration adapter.
   - Keep webhook payload normalization, id/secret validation, route mapping, and package-boundary assumptions in one place.

9. **Clarify soft references and relationship invariants**
   - Review unconstrained or soft-reference columns called out by the architecture guide.
   - Add foreign keys where semantically stable and migration-safe.
   - Where soft references are intentional, document and enforce invariants in domain services/tests.

10. **UI modularization by API contracts**
    - Keep the UI browser-only and API/SSE-driven.
    - Split large client/API helpers by feature only where it improves clarity.
    - Preserve shared fetch primitives, shared route shells, shared design-system components, and existing lazy route behavior.

11. **Explicit health phases**
    - Keep core `/api/health` fast and health-critical.
    - Expose optional/background service status separately where useful.
    - Ensure optional startup work such as indexing or external integrations does not block basic readiness.

12. **Fix known documentation drift**
    - Update stale docs discovered during the restructure, including architecture-guide drift, package names, runtime paths, UI dev-server notes, release references, and audit references.
    - Keep docs source-grounded and remove obsolete references instead of carrying them forward.

## Execution process

### Phase 1: Source-grounded map

Read `docs/ARCHITECTURE.md` first, then verify each planned track against the actual source. Produce a short implementation map before editing:

- Current modules involved.
- Proposed target modules.
- Compatibility shims, if any.
- Tests that should move or be added.
- Migration or runtime risks.

### Phase 2: Implement incrementally

Work in small batches. After every meaningful change, commit granularly with a message explaining why the boundary changed.

Suggested batch order:

1. Documentation drift and architecture map updates.
2. Coordinator bootstrap/service lifecycle extraction.
3. Background service registry.
4. Run event/log store extraction.
5. Task watcher service extraction.
6. Core domain entrypoints and import tightening.
7. Run-like lifecycle helper sharing.
8. Webhook adapter.
9. Soft-reference/FK invariant cleanup.
10. UI API-client modularization, if still useful.
11. Health/status phase separation.
12. Final docs/test cleanup.

If a batch becomes too large, split it further and commit each stable slice.

### Phase 3: Tests and verification

For each batch, run the narrowest relevant tests first. Before final handoff, run:

```bash
npm test
npm run build:ui
git diff --check
```

For CLI/service/coordinator changes, include focused CLI/core tests. For API or runtime changes, include focused API/core/coordinator tests. For UI changes, include focused UI tests and browser/Playwright checks when layout or browser behavior can regress.

If the installed Worklab service is running and the final changes affect served runtime behavior, restart it safely only after checking for active runs, then verify `/api/health`.

## Constraints

- Preserve existing behavior unless a change is explicitly part of the simplification.
- Keep changes close to existing module boundaries.
- Do not rewrite unrelated generated artifacts or local runtime data.
- Do not delete dynamically reached code without proving it is unwired.
- Do not remove public package entrypoints without compatibility shims or an explicit migration.
- Keep raw logs full-fidelity; slim derived DB/UI timelines instead.
- Reuse existing planner, owner, reviewer, delegation, comment, automation, and KB primitives rather than introducing parallel coordination surfaces.
- Prefer explicit domain APIs over direct DB access outside persistence/query modules.
- Update tests alongside behavior or boundary changes.

## Deliverables

1. A series of focused commits covering all twelve tracks.
2. Updated architecture/module documentation that matches the final source.
3. Focused tests for changed seams plus final `npm test`, `npm run build:ui`, and `git diff --check` verification.
4. A final summary listing what changed, what was intentionally deferred, and any residual risks.
