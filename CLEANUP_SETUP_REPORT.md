# Cleanup Setup Report

Managed by behavior-preserving-cleanup plugin.

## Config Changes
- agents.max_threads: missing -> 6
- agents.max_depth: missing -> 1
- features.goals: missing -> true

## Created
- `.codex/config.toml` - created repo-local Codex config
- `AGENTS.cleanup.md` - created from template
- `.cleanup/CLEANUP_SCORECARD.md` - created from template
- `.cleanup/CLEANUP_INVENTORY.csv` - created from template
- `.cleanup/CLEANUP_BASELINE.template.md` - created from template
- `.cleanup/CLEANUP_REPORT.template.md` - created from template
- `.codex/agents/dead-code-hunter.toml` - created from template
- `.codex/agents/abstraction-reviewer.toml` - created from template
- `.codex/agents/dependency-config-reviewer.toml` - created from template
- `.codex/agents/test-sentinel.toml` - created from template
- `.codex/agents/codebase-cartographer.toml` - created from template
- `.codex/agents/cleanup-worker.toml` - created from template

## Updated
- None.

## Unchanged
- None.

## Skipped
- None.

## Next Command

Run `$cleanup-goal` when ready to audit and simplify this repository.

If this repository already has `AGENTS.md`, review `AGENTS.cleanup.md` and copy or link the cleanup section manually.
