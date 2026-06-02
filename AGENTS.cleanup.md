# Behavior-Preserving Cleanup Instructions

Managed by behavior-preserving-cleanup plugin.

## Cleanup Principle

Optimize for behavior-preserving minimality. Remove code only when evidence shows it is dead, redundant, ineffective, or unnecessarily complex, and only when validation remains no worse than baseline.

## Hard Gates

- Preserve runtime behavior and public APIs.
- Do not change auth, billing, persistence, migrations, generated code, vendored code, serialized formats, or security-sensitive paths without explicit approval.
- Do not add production dependencies.
- Do not allow multiple agents to edit code concurrently.
- Treat baseline failures as pre-existing only after recording them in `CLEANUP_BASELINE.md`.

## Workflow

1. Establish baseline validation commands and outcomes.
2. Run read-only audit agents to collect evidence-backed cleanup candidates.
3. Merge accepted findings into `CLEANUP_INVENTORY.csv`.
4. Apply P0/P1 changes in small batches with one implementation worker.
5. Validate after each batch and at the end.
6. Write `CLEANUP_REPORT.md` with metrics, decisions, and validation evidence.

## Completion Bar

- P0/P1 Cleanup Completion Rate is 100 percent.
- Introduced validation failures are 0.
- New production dependencies are 0.
- Unapproved public API changes are 0.
