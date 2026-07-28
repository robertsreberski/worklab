# Changelog

## Unreleased

- Upgraded `@mono-agent/agent-runtime` from 0.4.1 to 0.15.0.
  - Context-window overflows now report the runtime's new `context_limit`
    failure kind instead of `usage_limit`. Both take the same compact
    continuation, so auto-recovery is unchanged; the UI labels them apart.
  - Compaction limits are adaptive by default — the four
    `agent_compaction_*` numeric settings default to `null` and the runtime
    scales them to each model's context window. Existing explicit values keep
    working, and the Settings UI gained an Adaptive toggle.
  - Worklab now passes the runtime's typed `toolLimits` / `compaction` policy
    objects instead of the deprecated flat `settings` bag, which removes a
    `deprecated_settings_option` warning from every run.
  - Adapted to the runtime's flat codex `file_change` event and the removal of
    `ai/backend.js`, the Claude file-edit hooks, and the effort-derived
    `thinking` option.
  - Pinned `@earendil-works/pi-ai` to 0.80.6 and added
    `@anthropic-ai/claude-agent-sdk` as a devDependency so both dedupe to a
    single copy; without the latter the Claude test suite issued real API
    calls instead of using its mock.
  - Known gap: a codex app-server that dies mid-turn does not fail fast while
    live input is attached (upstream
    [mono-agent#545](https://github.com/robertsreberski/mono-agent/issues/545));
    the run stalls until `worker_timeout_ms`.

- Prepared the npm launch path for `@worklab-ai/worklab`, including scoped
  package metadata, a public `@mono-agent/agent-runtime` npm dependency,
  bundled UI startup behavior for global installs, and pack-content validation.
- Removed obsolete in-repo docs that no longer matched the rapidly changing
  codebase.
- Added a code-derived task and agent logic audit at
  [docs/audits/task-agent-logic-audit.md](docs/audits/task-agent-logic-audit.md).
- Captured the target v2 direction: structured runtime results, first-class
  Claude Code and Codex CLI providers, autonomous subtask delegation, subagent
  coordination, parent/child joins, and explicit recovery states.
