# Dead-Code Audit

_Status: 2026-05-14 — audit only, no removals applied._

## Scope and method

- **Target tree:** `src/` and `packages/agent-runtime/` (whole repo minus `node_modules`, `dist`, `.git`).
- **Searches used:**
  - `grep -rn 'TODO(audit-followup)\|FIXME\|XXX\|@deprecated' src packages --include='*.js'`
  - `grep -rni 'legacy\|deprecated' src packages --include='*.js'`
  - Per-symbol grep for every flagged export, e.g. `grep -rn 'RUN_STATUSES' src packages --include='*.js'`.
  - Module-level import audit: for each file under `src/core/`, `grep -rn 'from .*<name>.js'`.
- **Out of scope:** style, naming, doc comments, log message wording, file-size nits. Only *removals* are listed.
- **Conservative bias:** anything reachable via a string-table lookup (MCP tool name registration, dynamic event-kind dispatch) is flagged as **Needs verification**, not safe-to-remove.

## 1. High-confidence removals

These are reviewed and verified dead. Each entry lists the path, what it is, why it is safely dead, and the grep that confirms it.

### 1.1 `src/__tests__/smoke.test.js`

```js
describe("smoke", () => {
  it("passes", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- 8 lines. Asserts `1 + 1 === 2`. Has no value as a sentinel — the full suite covers actual behavior.
- **Action:** delete the file.

### 1.2 `src/core/agent-contract.js` (entire 164-line module) and its test

Exports:
- `RUN_STATUSES`, `EVENT_KINDS`, `PROVIDER_KINDS` (top-level arrays)
- `normalizeUsage()`
- `validateRunResult()`
- `isKnownEventKind()`
- `makeRuntimeWarning()`, `makeMcpInitFailedWarning()`

Verification:

```
grep -rn 'agent-contract' src packages --include='*.js'
# → src/__tests__/core/agent-contract.test.js:10

grep -rn 'validateRunResult\|normalizeUsage\|makeRuntimeWarning\|makeMcpInitFailedWarning\|isKnownEventKind' src packages --include='*.js' | grep -v __tests__
# → packages/agent-runtime/src/ai/providers/claude-sdk.js:85
#   function makeRuntimeWarning(message, warningKind = "claude_post_success_error") {
```

The `makeRuntimeWarning` in `claude-sdk.js` is a **local function with the same name**, not the export. There are no production importers. Test-only module.

Note: `agent-contract.js` itself imports `normalizeWorklabResult` / `validateWorklabResultSemantics` from `./worklab-result/contract.js` and re-validates them inside `validateRunResult()`. Those upstream helpers are *not* dead and stay.

- **Action:** delete `src/core/agent-contract.js` and `src/__tests__/core/agent-contract.test.js`.

## 2. Needs verification (don't auto-delete)

Items that look unused but might be reached through indirection. Before removing, run the listed verification.

### 2.1 MCP tool name strings

Some MCP tool surfaces register handlers by string name (`src/mcp/admin/tools/index.js`, `src/mcp/agent/tools/index.js`). Before deleting any function that *looks* like an unused handler, confirm:

```
grep -rn '"<tool_name>"' src packages --include='*.js'
grep -rn "'<tool_name>'" src packages --include='*.js'
```

No specific candidates flagged at this pass — but if a future cleanup deletes a tool, this check is mandatory.

### 2.2 Dynamic provider lookup

`packages/agent-runtime/src/ai/registry.js` registers providers by SDK key. Before deleting an apparently-unused provider helper, grep:

```
grep -rn '"claude"\|"pi"\|"codex"' packages src --include='*.js'
```

Some helpers (e.g. provider-session-id normalizers — see §3.2 below) are reached via these string keys.

## 3. Redundancy hotspots

These are *not* removal candidates — they are places where future consolidation will pay off, listed for triage.

### 3.1 `worklab_result` contract location

CLAUDE.md claims the canonical decision/contract vocabulary lives at `packages/agent-runtime/src/ai/result/decisions.js`. Verified false:

```
find packages -name 'decisions.js' -o -name 'contract.js' -o -name 'lead-cycle-contract.js' -o -name 'lenient-parse.js'
# → (no results)

ls src/core/worklab-result/
# → contract.js decisions.js lead-cycle-contract.js lenient-parse.js
```

The contract files only live in `src/core/worklab-result/`. The agent-runtime package imports them only indirectly via worker glue. This is not a *removal* — the contract is live — but it means:

- **CLAUDE.md is stale** on this point (covered in §6 too).
- The packaging audit treats moving this directory into `@worklab-ai/agent-runtime` (or a new sibling package) as the highest-leverage S-effort win, because it doesn't actually duplicate any code today — it just isn't where the docs say it is.

### 3.2 Provider-session-id normalization

Two normalization sites:

- `src/worker/result-emitter.js:44` — `providerSessionPayload(result)` reads `result.provider_session_id` / `result.session_id` / nested provider info.
- `src/coordinator/spawn-worker.js:678..681` — re-extracts the same value from `finalPayload` before writing it back to the DB.

Both are correct in isolation (one reads from the runner result, the other from the IPC payload), but the field-name fallback list is duplicated. Recommendation: lift into a single helper in `packages/agent-runtime/src/ai/` after the result-parser extraction lands.

### 3.3 Worker result-shaping vs result-emitter

Runner files in `src/worker/{task,review,consolidate,automation,lead-cycle}-runner.js` each shape their own terminal output, and `src/worker/result-emitter.js` shapes again before emission. This is transitional duplication from the agent-runtime extraction. Don't consolidate yet — wait for the runtime extraction to settle (per CLAUDE.md "`worklab_result` contract … will move out in later phases of the extraction").

## 4. Intentional shims — DO NOT REMOVE

Listed so future audits don't re-flag them.

| File / Symbol | Why it stays |
|---|---|
| `src/coordinator/spawn-worker.js:7` `PROCESS_TO_LEGACY_STATUS` | Populates the deprecated `task_runs.status` column so readers that haven't migrated to `process_status` still see non-NULL values. Documented inline. |
| `src/core/db/migrations/runner.js:13` `LEGACY_STATUS_TO_PROCESS`, `legacyToProcess`, `processToLegacy` | Migration shim that backfills `process_status` from `status` on pre-v2 DBs. Used in §480, §482. |
| `src/core/db/migrations/runner.js:211` `dropLegacyTeamReplacedColumns` | Drops project `allowed_agents_json` and per-agent budget columns retired by the v33 team change set. Cannot be removed until we stop supporting upgrades from pre-v33 DBs. |
| `src/core/db/migrations/runner.js:488` `resetLegacyEmbeddings` | Embedding-index migration. Same reasoning. |
| `src/core/db/migrations/runner.js:979..983` `schedule_spawns` / `schedules` drops | Removes pre-v2 scheduler tables. The DROP statements must remain. |
| `src/core/planning-harness.js` `"legacy"` harness mode | Still selectable as one of five planning harnesses. Active behavior, not dead code. |
| `src/core/ai.js` `canonicalizeLegacyModelReference` | Re-exported, used by `src/core/db/migrations/runner.js:6`, `src/core/verification-adjudicator.js:96`, `src/core/verification-adjudicator-settings.js:27`. |
| `src/ui/src/lib/navigation.js` `LEGACY_ROUTE_ALIASES` | Rewrites old URLs that may be bookmarked. |
| `src/api/routes/models.js:13` `text-embedding-ada-002 "Legacy"` row | Still a valid OpenAI model the user might pick. The label is a description, not a removal flag. |

## 5. `TODO(audit-followup)` inventory

```
grep -rn 'TODO(audit-followup)' src packages --include='*.js'
# → (no matches)
```

Zero hits in source. The only mention is `CLAUDE.md:84`, which is meta-documentation ("A few `TODO(audit-followup)` markers remain in the code…"). That documentation line is itself stale and can be deleted next time CLAUDE.md is touched. Keep CLAUDE.md edits out of scope for this audit.

## 6. Docs and `data-template/` stragglers

- **`docs/`**: contents are `ai-runtime-bridge.md`, `audits/`, `npm-release.md`, `ui-design-system.md`. All currently referenced (the UI design system is enforced by `scripts/guard-banned-tokens.sh`; the npm release doc is used by the release scripts; `ai-runtime-bridge.md` documents the active extraction). No removals.
- **`data-template/`**: every file is copied wholesale by `src/core/first-boot.js → seedDataFromTemplate()`. `data-template/agents/_seed/*` (executor, planner, reviewer) and the `agents/example/` stubs are all expected to ship. No removals.
- **Stale CLAUDE.md fact**: claim that `worklab_result` contract files live in `packages/agent-runtime/src/ai/result/`. They don't (see §3.1). This is a doc-correctness issue, not a removal — flag for the next CLAUDE.md edit.

## 7. Orphan-file check

Every `.js` under `src/` is reachable from an entry point (`src/cli/index.js`, `src/coordinator.js`, `src/worker.js`, the API server, or a test). No orphans found.

## 8. Summary table

| Category | Count | Items | Action |
|---|---|---|---|
| High-confidence removal | 3 | `smoke.test.js`, `src/core/agent-contract.js`, `src/__tests__/core/agent-contract.test.js` | Delete |
| Needs verification | 0 individually flagged | Recipe in §2 for future cases | Run verification grep before deleting |
| Redundancy (don't remove yet) | 3 | Contract location mismatch, provider-session normalization, worker result-shaping vs emitter | Defer until extraction phases land |
| Intentional shims (KEEP) | 9 | See §4 | None — don't re-flag |
| `TODO(audit-followup)` markers | 0 | — | None |
| Doc/data-template stragglers | 0 | — | None — CLAUDE.md is stale on one point (§6) but that's a doc edit, not a removal |
| Orphan files | 0 | — | None |

**Total bytes recoverable from high-confidence removals: ~170 LOC across 3 files.** This is small because the codebase is already disciplined — the value of this audit is mostly the "KEEP" list and the redundancy hotspots, which prevent the next pass from re-relitigating settled questions.
