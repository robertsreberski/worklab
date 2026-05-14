# Worklab Code Clarity Audit Findings

Date: 2026-05-14

This report covers Phase 1 and Phase 2 of `goals/clean.md`. No remediation was
performed. The pre-flight subagent review was applied as an operational guard:
Phase 1 stayed read-only, static-tool output was treated as evidence to verify,
dynamic/public surfaces were not treated as deletion candidates by default, and
the work stops at this report pending explicit approval.

## Severity And Confidence

- Critical: likely bug, security issue, data-loss risk, or build/release break.
- Important: real maintenance risk, failing repo gate, contradictory behavior,
  or stale guidance likely to mislead work.
- Minor: localized cleanup, dead code, or clarity issue with limited blast
  radius.
- Cosmetic: naming/comment/style issue only.

Confidence reflects current evidence only. Dynamic CLI, MCP, service-worker,
generated UI, package-export, and route surfaces were treated cautiously.

## Discovery Summary

Repository facts:

- Root package: `@worklab-ai/worklab@0.1.5`, ESM, Node `>=20`.
- Public CLI bin: `worklab -> src/cli/index.js`.
- Published package files include `src/api`, `src/cli`, `src/core`,
  `src/coordinator`, `src/mcp`, `src/ui/dist`, `src/worker`, and `src/worker.js`.
- Workspace packages: `@worklab-ai/agent-runtime@0.1.5`,
  `@worklab-ai/webhooks@0.1.5`, and private example `examples/echo-agent`.
- No repo-level `tsconfig.json` or `jsconfig.json` exists; `tsc --noEmit` is
  not currently a meaningful repo gate.

Commands run:

- `npm run lint`: failed with 5 `no-restricted-imports` boundary errors.
- `./scripts/guard-imports.sh`: failed with the same 5 boundary errors.
- `npm run lint:size`: failed because `Settings.jsx` and `TaskDetail.jsx` exceed
  the 1200-line production-source guard.
- `npm run pack:check`: passed; npm pack contents are valid for the root package.
- `./scripts/guard-banned-tokens.sh`: passed.
- `node scripts/release/validate-release.mjs --tag v0.1.5`: passed.
- `npx -y knip --reporter compact`: found unused-file/export/dependency leads.
- `npx -y depcheck --json`: found `picomatch` as unused in the root package;
  also flagged `@vitest/coverage-v8`, which is a false positive because
  `package.json:61` uses `vitest run --coverage`.
- `npx -y madge --circular --exclude '^src/ui/dist/' src packages`: found 4
  source circular dependencies.
- `npx -y jscpd --threshold 0 --min-lines 25 --min-tokens 150 ...`: found 3
  duplicated blocks.

Static-tool leads intentionally not reported as findings:

- `src/mcp/agent/server.js`: invoked dynamically through
  `src/mcp/launch-worklab-mcp.sh` and configured by `src/core/mcp-config.js`.
- `src/ui/public/sw.js`: registered by URL in `browserNotifications.js`.
- `src/worker.js`: spawned by coordinator/runtime config and included in the
  published package.
- `src/worker/automation-runner.js`: imported by `src/worker.js`.
- `src/__tests__/helpers/fake-worker.js`: used as a child-process test fixture.
- Most `src/core/index.js` unused-export output: this is the public domain barrel
  and needs per-export owner review before removal.
- MCP tool schemas and admin/agent tool module exports: these are registry
  surfaces and should not be deleted from static output alone.

## 1. Dead Code

### D1. Root dependency `picomatch` appears unused

- File path + line range: `package.json:72-89`
- Severity: Minor
- Confidence: High
- Recommended action: delete
- Removal risk: Low. `rg` found no source references outside `package.json` and
  `package-lock.json`; both `knip` and `depcheck` independently flagged it.
- Rationale: `picomatch` is listed as a direct runtime dependency at
  `package.json:84`, but current production code does not import it. Transitive
  dependencies still bring their own `picomatch` copies where needed.

### D2. Root UI compat re-export files are unreferenced

- File path + line range:
  - `src/ui/src/components/SearchField.jsx:1-2`
  - `src/ui/src/components/SelectField.jsx:1-3`
- Severity: Minor
- Confidence: High
- Recommended action: delete
- Removal risk: Low to Medium. These files are internal UI source, not package
  exports, but a stale local import could be added without static coverage.
- Rationale: `knip` flagged both files. `rg` found active usage of
  `components/primitives/SearchField.jsx` and `components/primitives/Select.jsx`,
  but no imports of the root `components/SearchField.jsx` or
  `components/SelectField.jsx` compatibility files.

### D3. `useLiveTicker` hook is unreferenced

- File path + line range: `src/ui/src/lib/useLiveTicker.js:1-27`
- Severity: Minor
- Confidence: High
- Recommended action: delete
- Removal risk: Low. It is UI-internal and `rg` found only the definition.
- Rationale: The hook cycles event lists, but no route/component/test imports it.
  Keeping it suggests a live ticker behavior that is not currently present.

### D4. `selectRunsWithLog` route helper is exported but unused

- File path + line range: `src/api/routes/tasks/serialization.js:673-675`
- Severity: Minor
- Confidence: High
- Recommended action: delete
- Removal risk: Low to Medium. It is exported from a route serialization module,
  but not from a package public surface; still confirm no dynamic test import
  expectations before removing.
- Rationale: `rg` found only this definition. The nearby active helper is
  `selectTaskRunsWithLog` at `src/api/routes/tasks/serialization.js:677-680`,
  while the DAL query `selectRunsWithLogJoin` lives in
  `src/core/db/queries/runs.js:319`.

### D5. Legacy SelectField CSS aliases have no JSX usage

- File path + line range: `src/ui/src/styles.css:7356-7437`
- Severity: Minor
- Confidence: Medium
- Recommended action: delete
- Removal risk: Medium. CSS class names can be coupled to rendered markup or
  tests indirectly, though `rg` found no `select-field*` usage outside this CSS
  block.
- Rationale: The comment says "deleted JSX; kept as defensive fallback". That is
  a reasonable temporary bridge, but the current audit found no JSX references,
  so this is now likely dead defensive CSS.

## 2. Obsolete Patterns

### O1. Back-compat runtime capability wrapper creates package cycles

- File path + line range:
  - `packages/agent-runtime/src/ai/backend.js:1-17`
  - `packages/agent-runtime/src/ai/runtime/registry.js:31-55`
  - `packages/agent-runtime/src/ai/providers/claude-sdk.js:12-15`
  - `packages/agent-runtime/src/ai/providers/pi-sdk.js:4-6`
- Severity: Important
- Confidence: High
- Recommended action: refactor
- Removal risk: Medium. `packages/agent-runtime` has public subpath exports, and
  `backend.js` is explicitly a back-compat surface.
- Rationale: `madge` reports cycles:
  `backend.js -> runtime/registry.js -> providers/claude-sdk.js -> backend.js`
  and the same through `providers/pi-sdk.js`. The comment in `backend.js` says it
  is a compatibility export over the canonical runtime bridge registry. The
  providers should not depend on that compatibility wrapper if the registry also
  lazy-loads providers.

### O2. State-machine comments refer to a moved/nonexistent source-of-truth path

- File path + line range: `src/core/state-machine.js:1-5`
- Severity: Cosmetic
- Confidence: High
- Recommended action: clarify
- Removal risk: Low. Comment-only.
- Rationale: The file imports from `./worklab-result/decisions.js`, but the
  header still says the source of truth is `src/ai/result/decisions.js` and
  references "Phase 7". That path does not exist in the current tree.

### O3. Release documentation has stale version/package instructions

- File path + line range:
  - `docs/npm-release.md:10-15`
  - `docs/npm-release.md:34-40`
  - `packages/webhooks/package.json:23-31`
- Severity: Important
- Confidence: High
- Recommended action: clarify
- Removal risk: Low. Documentation-only.
- Rationale: The release doc says the publishable packages are
  `@worklab-ai/agent-runtime` and `@worklab-ai/worklab`, but
  `@worklab-ai/webhooks` also has `publishConfig` and a public bin. The doc also
  hard-codes `0.1.3` even though the repo is at `0.1.5`; using the existing
  `X.Y.Z` pattern would avoid stale examples.

## 3. Contradictory / Inconsistent Code

### C1. Boundary lint fails despite docs saying the boundary is enforced

- File path + line range:
  - `src/api/routes/runs.js:1-15`
  - `src/api/routes/tasks.js:47-55`
  - `src/api/routes/tasks/serialization.js:1-18`
  - `src/cli/auth.js:5-8`
  - `src/cli/update.js:4-11`
  - `eslint.config.js:207-228`
  - `src/core/index.js:149-160` and `src/core/index.js:252-261`
- Severity: Important
- Confidence: High
- Recommended action: unify
- Removal risk: Low to Medium. Some missing barrel exports may need to be added
  intentionally rather than deep imports merely rewritten.
- Rationale: `npm run lint` and `./scripts/guard-imports.sh` both fail. Three API
  files deep-import `core/artifact-collection.js` even though
  `collectGitDiffArtifactsForRun` is already exported through the core barrel.
  `src/cli/update.js` deep-imports `core/update-check.js` even though the used
  update helpers are exported through the core barrel. `src/cli/auth.js`
  deep-imports `core/pi-oauth.js`; if `readPiAuthFile` is a CLI-approved domain
  helper, it needs a deliberate public-barrel export.

### C2. Source circular dependencies obscure ownership boundaries

- File path + line range:
  - `src/core/ai.js:16-22`
  - `src/core/providers.js:1-5`
  - `src/ui/src/components/primitives/StatusDot.jsx:1-7`
  - `src/ui/src/components/primitives/StatusPill.jsx:25-46`
- Severity: Important
- Confidence: High
- Recommended action: refactor
- Removal risk: Medium. These are central runtime/UI helpers.
- Rationale: `madge` found source cycles in addition to the agent-runtime cycles
  in O1. `src/core/providers.js` imports `WORKLAB_BUILTIN_TOOLS` from
  `src/core/ai.js` while `ai.js` imports provider helpers from `providers.js`.
  `StatusDot.jsx` imports `statusMeta` from `StatusPill.jsx`, while
  `StatusPill.jsx` re-exports `StatusDot`. Shared constants should live in an
  acyclic leaf module or the re-export should be moved to a barrel.

### C3. Current-reference docs point at a missing audit document

- File path + line range:
  - `AGENTS.md:20-22`
  - `CONTRIBUTING.md:3-7`
  - `docs/audits/task-agent-logic-audit.md` (missing)
- Severity: Important
- Confidence: High
- Recommended action: clarify
- Removal risk: Low to Medium. Need owner decision whether to restore the audit
  doc or update the references to current source/docs.
- Rationale: Both contributor/agent guidance files call
  `docs/audits/task-agent-logic-audit.md` a current reference, but `docs/audits`
  is absent from the repository. This directly contradicts the repo's "current
  references" guidance.

### C4. `CLAUDE.md` contradicts package names and current runtime-contract paths

- File path + line range:
  - `CLAUDE.md:7-18`
  - `src/core/worklab-result/contract.js` (current file)
  - `src/core/worklab-result/lead-cycle-contract.js` (current file)
  - `packages/agent-runtime/package.json:2-31`
- Severity: Important
- Confidence: High
- Recommended action: clarify
- Removal risk: Low. Documentation-only, but it influences agent behavior.
- Rationale: `CLAUDE.md` references `@worklab/agent-runtime`, while the package
  and imports use `@worklab-ai/agent-runtime`. It also points to
  `packages/agent-runtime/src/ai/result/decisions.js`,
  `packages/agent-runtime/src/ai/result/lead-cycle-contract.js`, and
  `src/ai/result/contract.js`-style locations, while the current Worklab result
  contracts live under `src/core/worklab-result/`.

### C5. Duplicate runner setup exists in task and review execution paths

- File path + line range:
  - `src/worker/task-runner.js:83-123`
  - `src/worker/review-runner.js:126-165`
- Severity: Minor
- Confidence: High
- Recommended action: unify
- Removal risk: Medium. These are execution paths; refactor only with focused
  worker/provider tests.
- Rationale: `jscpd` reports a 30-line clone. Both paths resolve the model,
  create SDK event coalescing, emit first-turn prompt diagnostics, and call
  `generateResponse` with nearly identical runtime options. The duplication is
  small but sits in high-value execution code where drift can create inconsistent
  behavior.

### C6. Duplicate editor modal patterns exist across KB and Skill editors

- File path + line range:
  - `src/ui/src/routes/KbEdit.jsx:396-427`
  - `src/ui/src/routes/SkillEdit.jsx:312-343`
- Severity: Minor
- Confidence: High
- Recommended action: unify
- Removal risk: Low to Medium. UI behavior and copy differ slightly.
- Rationale: `jscpd` reports a 44-line clone around delete and unsaved-change
  modals. A small shared editor modal primitive would keep future behavior
  changes consistent across entity editors.

## 4. Clarity & Soundness

### S1. Production file-size guard currently fails

- File path + line range:
  - `src/ui/src/routes/Settings.jsx:1-1237`
  - `src/ui/src/routes/TaskDetail.jsx:1-1217`
  - `scripts/guard-file-size.js:31-51`
- Severity: Important
- Confidence: High
- Recommended action: refactor
- Removal risk: Medium. Both are user-facing route components.
- Rationale: `npm run lint:size` fails because the guard counts 1238 lines for
  `Settings.jsx` and 1218 for `TaskDetail.jsx`, over the configured 1200-line
  ceiling. This creates a standing cleanup gate failure and signals overlapping
  route responsibilities.

### S2. Root dependency audit and package docs disagree on current package graph

- File path + line range:
  - `package.json:44-47`
  - `package.json:72-90`
  - `packages/webhooks/package.json:23-31`
  - `docs/npm-release.md:10-15`
- Severity: Minor
- Confidence: High
- Recommended action: clarify
- Removal risk: Low.
- Rationale: This is the package-graph version of O3/D1: the repo has three
  publishable packages by manifest, but release docs list two; root dependencies
  include an apparently unused `picomatch`. These are not runtime bugs, but they
  make dependency/release ownership less clear.

## Prioritized Remediation Plan

1. Restore green repo gates first:
   - Fix the five boundary imports so `npm run lint` and
     `./scripts/guard-imports.sh` pass.
   - Split or extract enough from `Settings.jsx` and `TaskDetail.jsx` for
     `npm run lint:size` to pass.

2. Remove high-confidence dead code:
   - Delete `picomatch` from root dependencies and refresh `package-lock.json`.
   - Delete `SearchField.jsx`, `SelectField.jsx`, `useLiveTicker.js`, and
     `selectRunsWithLog` after a focused `rg` check.
   - Delete the unused `.select-field*` CSS block if approved.

3. Break circular dependencies:
   - Move `WORKLAB_BUILTIN_TOOLS` to an acyclic constants module or provider
     constants module.
   - Move `statusMeta`/status metadata to a separate primitive metadata module,
     or stop re-exporting `StatusDot` from `StatusPill.jsx`.
   - In `packages/agent-runtime`, make provider modules depend on the canonical
     runtime capability registry or a leaf capability module, not the
     back-compat `backend.js` wrapper.

4. Update contradictory docs/comments:
   - Decide whether to restore `docs/audits/task-agent-logic-audit.md` or remove
     it from `AGENTS.md`/`CONTRIBUTING.md`.
   - Refresh `CLAUDE.md` package names, provider list, and contract paths.
   - Refresh `docs/npm-release.md` to include `@worklab-ai/webhooks` and avoid
     hard-coded stale versions.
   - Correct the stale `src/core/state-machine.js` header.

5. De-duplicate after gates are green:
   - Extract shared runner setup for task/review runs with focused worker tests.
   - Extract shared editor delete/unsaved modals or a small editor guard
     component with focused UI tests.

## Open Questions

1. Should `docs/audits/task-agent-logic-audit.md` be restored as a current
   reference, or should `AGENTS.md` and `CONTRIBUTING.md` stop naming it?
2. Is `CLAUDE.md` still intended to be maintained as current repo guidance, or
   should it be reduced/removed in favor of `AGENTS.md`?
3. May the remediation delete internal UI compatibility files
   `SearchField.jsx`, `SelectField.jsx`, and the `.select-field*` CSS block, or
   do you want a longer deprecation window for local branches?
4. Should `readPiAuthFile` become part of `src/core/index.js`, or should
   `src/cli/auth.js` stop needing that low-level helper?
5. Is `packages/agent-runtime/src/ai/backend.js` still a supported public
   subpath for external consumers, or can it be deprecated more aggressively?
6. Do you want the first remediation batch to include dependency lockfile
   changes for removing `picomatch`, or keep dependency cleanup separate?

## Approval Gate

Per `goals/clean.md`, remediation should not start until you explicitly approve
which findings to fix. Low-confidence or higher-risk items that need individual
approval before changes are D5, C5, and the public-surface part of O1.
