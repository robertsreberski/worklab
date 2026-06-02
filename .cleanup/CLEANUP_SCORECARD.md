# Cleanup Scorecard

Managed by behavior-preserving-cleanup plugin.

## Primary Metric

P0/P1 Cleanup Completion Rate =

`(resolved P0/P1 findings + intentionally kept P0/P1 findings with written rationale) / total accepted P0/P1 findings`

Target: 100 percent.

## Required Gates

- Introduced validation failures: 0
- New production dependencies: 0
- Unapproved public API changes: 0
- Unapproved security, auth, billing, data, migration, generated, vendor, or serialized-format changes: 0

## Severity Model

- P0: Proven dead code, unused dependency, unreachable code, or ineffective configuration with direct evidence.
- P1: Clear redundancy, useless wrapper, single-use abstraction, or duplicate implementation with low behavior risk.
- P2: Probable overengineering that needs stronger product or maintainer judgment.
- P3: Risk area requiring explicit approval before modification.

## Finding Statuses

- accepted
- resolved
- kept_with_rationale
- rejected
- deferred
