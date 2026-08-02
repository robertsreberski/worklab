# Changelog

## Unreleased

- Upgraded `@mono-agent/agent-runtime` from 0.4.1 to 0.17.1.
  - Non-empty skill sets now carry an explicit `skillsRoot`, as required by
    the runtime's indexed-skill contract, while `skillDirs` continues to bound
    filesystem access for Worklab's disclosed skills.
  - Worklab deliberately leaves the runtime's new per-route retry attempts,
    request-scoped `toolEnvironment`, and generic Pi `Agent` subagents unset.
    Existing fallback routing, worker environment, and native-subagent policy
    remain Worklab-owned.
  - Runtime 0.17.1 restores fallback routing when Pi 0.83 reports a missing
    credential as `Provider is not configured`: the failure is normalized to
    `provider_auth`, so the next configured route is attempted.
  - Fixed direct Codex runs, which the upgrade had broken outright. The
    runtime fails a run closed unless the tool policy is an omitted
    allowlist or one containing `"*"`, and Worklab always sends an explicit
    array — every codex run returned `skipped_capability_mismatch` /
    `codex_tool_policy_unsupported`. `src/core/tool-policy-projection.js`
    now expresses "allow every builtin" as the wildcard for the runtimes
    that advertise `tool_policy: "allow_all_only"`, leaving Claude and Pi
    alone so their agents keep exactly the tools Worklab granted.
  - Codex agents can run the plan stage. Read-only planning is now routed
    through the provider's native `permissionMode: "plan"` instead of a
    tool denylist those runtimes reject, so a Codex planner works rather
    than failing outright. It costs `WebFetch`/`WebSearch` until
    [mono-agent#552](https://github.com/robertsreberski/mono-agent/issues/552)
    lands; the run emits a `tool_policy_downgraded` warning naming them.
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
