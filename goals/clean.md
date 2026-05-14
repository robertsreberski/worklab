/goal Audit the codebase to identify and remediate obsolete patterns, dead code, contradictory implementations, and other sources of unclarity — leaving the code clear, consistent, and sound.

## Pre-flight (do this first)
Spawn a subagent to review and refine THIS prompt for clarity, completeness, and accuracy. Apply its feedback before executing.

## Scope of audit

1. **Dead code**
   - Unused functions, classes, variables, types, exports
   - Unreferenced files and modules
   - Unused imports and dependencies (cross-check `package.json` against actual usage)
   - Unreachable branches and impossible conditions
   - Commented-out code that should be deleted
   - Feature flags permanently on/off; A/B test scaffolding for concluded experiments

2. **Obsolete patterns**
   - Deprecated internal or external APIs still being called
   - Legacy patterns superseded by newer conventions present elsewhere in the same codebase (flag the inconsistency, prefer the newer convention)
   - Outdated framework idioms (e.g. class components where functional + hooks are the norm; callback-style async where the codebase has moved to async/await)
   - Polyfills and compatibility shims no longer needed given current runtime targets
   - Stale TODO/FIXME/HACK comments — especially ones referencing resolved tickets

3. **Contradictory / inconsistent code**
   - Duplicate implementations of the same logic (utilities, helpers, formatters)
   - Conflicting configs (tsconfig, eslint, prettier, build tooling)
   - Inconsistent error-handling strategies across analogous modules
   - Type definitions that disagree with runtime behavior
   - Documentation, comments, or naming that contradicts the actual code
   - Inconsistent naming for the same concept

4. **Clarity & soundness**
   - Modules with unclear or overlapping responsibilities
   - Circular dependencies
   - Magic numbers/strings that should be named constants
   - Overly clever code obscuring intent
   - Missing, loose (`any`), or misleading types

## Process

### Phase 1 — Discovery
- Map the codebase structure and identify the project's *current canonical* patterns vs older variants.
- Run language-appropriate static analysis: `knip`, `ts-prune`, `depcheck`, `eslint`, `tsc --noEmit`, etc. Install if missing and reasonable; otherwise note the gap.
- Cross-reference imports/exports across the project.

### Phase 2 — Report (BEFORE changing anything)
Write `audit-findings.md` organized by the four categories above. Each finding must include:
- File path + line range
- Severity: Critical / Important / Minor / Cosmetic
- Confidence: High / Medium / Low — be honest, especially about dynamic-usage uncertainty
- Recommended action: delete / refactor / unify / clarify / leave-and-document
- Removal risk (e.g. "may be invoked via dynamic import", "part of public API surface")
- Brief rationale

End the report with a prioritized remediation plan and a list of open questions for me.

### Phase 3 — Confirmation
Stop. Present the report and wait for my explicit approval. For any Low-confidence or High-risk items, ask individually before touching them.

### Phase 4 — Remediation
After approval, apply changes in small, focused commits grouped by category. After each batch:
- Run build, type-check, lint, and tests
- If anything breaks, stop and report rather than papering over it
- Use clear commit messages explaining *why*, not just *what*

## Constraints
- Do NOT remove code that *appears* unused but may be reached dynamically (reflection, string-based lookups, framework conventions like Next.js route files, decorators, plugin registries) without explicit confirmation.
- Do NOT modify exported package APIs or public entrypoints without flagging.
- Preserve git history clarity — small focused commits, no mega-diffs.
- If something looks intentionally weird, ask before "fixing" it. Chesterton's fence applies.
- Respect existing test coverage; flag any drops.
- Prefer deletion over preservation when confidence is high — dead code is a liability.

## Deliverables
1. `audit-findings.md` — full report (Phase 2)
2. Post-approval: a series of focused commits
3. `audit-summary.md` — what was changed, what was deferred, and why

Begin with the subagent review of this prompt.
