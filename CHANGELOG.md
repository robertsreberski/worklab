# Changelog

## Unreleased

- Upgraded `@mono-agent/agent-runtime` from 0.4.1 to 0.15.1.
  - Context-window overflows now report the runtime's `context_limit` failure
    kind instead of `usage_limit`. Both take the same compact continuation, so
    auto-recovery is unchanged; the UI labels them apart.
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
  - The runtime now owns the Pi dependency. Worklab reads the Pi model catalog
    and runs Pi OAuth through the runtime façade
    (`listPiBuiltinModels`, `getPiBuiltinModel`, `reasoningLevelsForPiModel`,
    `resolvePiOAuthApiKey`, `loginPiOAuth`); `@earendil-works/pi-ai` is a
    devDependency for test fixtures only, and a lint rule keeps it out of
    production code. `worklab auth pi` gained device-code and selection
    prompts, which the façade requires.
  - Claude provider tests inject `RuntimeRunOptions.claudeAgentQuery` instead
    of mocking `@anthropic-ai/claude-agent-sdk` by package name. The parallel
    Anthropic SDK copies in the dependency tree are intentional and must not be
    force-deduplicated.
  - A codex app-server that dies mid-turn now fails fast even with live input
    attached, instead of stalling until `worker_timeout_ms`
    ([mono-agent#545](https://github.com/robertsreberski/mono-agent/issues/545)).
  - Removed `agent_tool_payload_compaction_trigger_chars` and
    `agent_tool_prune_trigger_tokens`. The runtime deleted the policy fields
    they fed, which nothing had ever read; stored values go inert with no
    migration.

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
