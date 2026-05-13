# Worklab Agent And Task Recipes

Read this reference when creating or updating Worklab agents, tasks, subtasks,
or task instructions.

## Current Contracts

- Stages: `plan`, `execute`, `review`, `awaiting_children`, `awaiting_user`,
  `blocked`, `done`.
- Run policies: `manual`, `auto_plan_execute`.
- Decisions: `advance`, `delegate`, `pause`, `block` for plan/execute;
  `approve`, `reject` for review.
- Use `stage` rather than legacy `status`.
- Use `owner_agent` rather than legacy `executor_agent`.
- `reviewer_agent` may be `null` or omitted when a task does not need
  independent review.
- Empty `skills_allowlist`, `mcp_allowlist`, or `builtin_allowlist` means all
  available entries of that kind.

## Data Directory And CLI

- Default runtime data directory: `~/.worklab`.
- Effective data directory: prefer `worklab_status.config.dataDir` when admin
  MCP is available.
- Override data directory with `WORKLAB_DATA_DIR` or CLI flags such as
  `--data-dir /tmp/worklab-dev`.
- Useful related env vars: `WORKLAB_WORKSPACE`, `WORKLAB_HOST`, `WORKLAB_PORT`,
  `WORKLAB_LOG_LEVEL`.

Common CLI commands:

```bash
worklab status
worklab serve
worklab start
worklab restart
worklab stop
worklab mcp
worklab install-skill --target codex|claude|all
```

Use `worklab mcp` when an external agent needs the full-access Worklab admin
MCP bridge over stdio. Use `worklab install-skill` only for installing this
host-tool skill into Codex or Claude Code; it is separate from Worklab runtime
skill import under `dataDir/skills`.

## Model References

Always prefer `worklab_model_available` before choosing a model. Valid reference
forms:

- Claude SDK: `claude:claude-haiku-4-5-20251001`,
  `claude:claude-sonnet-4-6`, `claude:claude-opus-4-7`.
- Codex CLI: `codex:gpt-5.5`, `codex:gpt-5.4`,
  `codex:gpt-5.4-mini`.
- Pi SDK hosted OpenAI: `pi:openai:gpt-5.5`,
  `pi:openai:gpt-5.4`, `pi:openai:gpt-5.4-mini`.
- Pi SDK OpenAI Codex: `pi:openai-codex:gpt-5.5`.
- Custom Pi provider: `pi:<providerId>:<modelName>`.

Do not use tier aliases such as `claude:sonnet` or `codex:gpt-5`; Worklab
requires exact model ids. Do not use reserved legacy refs such as
`openai:<model>`, `claude-code:<model>`, `codex-cli:<model>`, or
`vercel:<providerId>:<model>`.

## Instruction Placement

Use projects for context shared across many tasks:

- repository or product background
- stable constraints and conventions
- common acceptance rules
- workdir and workflow expectations
- links to durable docs or Knowledge entries

Use task instructions for the task-specific delta:

- the exact requested change or investigation
- current acceptance criteria
- one-off constraints
- task-specific files, links, or evidence
- where this task intentionally overrides or narrows project context

Do not repeat project context inside every task. Repetition bloats run input and
makes later project-level updates harder to trust.

## Admin MCP Tool Map

Use these Worklab admin MCP tools when available:

- Status and discovery: `worklab_status`, `worklab_model_available`,
  `worklab_skill_list`, `worklab_mcp_status`.
- Agents: `worklab_agent_list`, `worklab_agent_get`,
  `worklab_agent_create`, `worklab_agent_update`, `worklab_agent_delete`,
  `worklab_agent_runs`.
- Tasks: `worklab_task_list`, `worklab_task_get`, `worklab_task_create`,
  `worklab_task_update`, `worklab_task_create_subtask`,
  `worklab_task_run`, `worklab_task_cancel`.
- Runs and activity: `worklab_run_get`, `worklab_activity_list`.
- Escape hatch: `worklab_api_request` for supported `/api/*` routes not covered
  by a named tool.

If admin MCP is unavailable, use the equivalent HTTP API paths:

- `GET /api/models/available`
- `GET/POST /api/agents`, `GET/PATCH/DELETE /api/agents/:name`
- `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`
- `POST /api/tasks/:id/subtasks`, `POST /api/tasks/:id/run`,
  `POST /api/tasks/:id/cancel`

## Agent Payloads

Codex CLI owner:

```json
{
  "name": "codex-coder",
  "display_name": "Codex Coder",
  "description": "Implements repository changes through Codex CLI.",
  "model": "codex:gpt-5.5",
  "effort": "high",
  "instructions": "Work in small, verifiable changes. Return a valid worklab_result.",
  "skills_allowlist": [],
  "mcp_allowlist": [],
  "builtin_allowlist": [],
  "enabled": true
}
```

Claude SDK reviewer:

```json
{
  "name": "claude-reviewer",
  "display_name": "Claude Reviewer",
  "description": "Reviews task output with Claude.",
  "model": "claude:claude-sonnet-4-6",
  "effort": "medium",
  "instructions": "Review against the task instructions and return approve or reject.",
  "skills_allowlist": [],
  "mcp_allowlist": [],
  "builtin_allowlist": ["Read", "Glob", "Grep", "Bash"],
  "enabled": true
}
```

For Codex CLI agents, keep `builtin_allowlist` empty. Worklab passes MCP config
and reasoning effort to Codex, but it does not expose a per-tool built-in
allowlist for Codex CLI runs.

## Task Payloads

Create a reviewed task:

```json
{
  "title": "Implement the import flow",
  "instructions": "Add the import flow described in the issue. Include focused tests.",
  "owner_agent": "codex-coder",
  "reviewer_agent": "claude-reviewer",
  "stage": "plan",
  "run_policy": "manual",
  "tags": ["feature"],
  "blocked_by_ids": [],
  "client_request_id": "implement-import-flow-2026-04-27"
}
```

Create a task that does not need review:

```json
{
  "title": "Refresh the README command snippet",
  "instructions": "Update only the CLI snippet and run the focused docs check.",
  "owner_agent": "codex-coder",
  "reviewer_agent": null,
  "stage": "plan",
  "run_policy": "manual",
  "tags": ["docs"],
  "blocked_by_ids": []
}
```

When `reviewer_agent` is `null`, an execute-stage owner result with
`decision: "advance"` moves the task straight to `done`. Use a reviewer for code
changes, risky operations, verification-heavy work, or any task where the user
explicitly asked for review.

Create a manual subtask:

```json
{
  "id": "W-12",
  "title": "Add validation tests",
  "instructions": "Cover invalid input and duplicate import cases.",
  "owner_agent": "codex-coder",
  "reviewer_agent": "claude-reviewer",
  "required": true
}
```

`id` can be a task id or public `task_key`. Manual subtasks start in `plan`.
Delegated subtasks created from a `worklab_result` start in `execute` and get
the parent reviewer only when the parent has one.

## Delegation Result

Use this from a plan or execute run when the owner should split work:

```json
{
  "schema": "worklab.v2",
  "stage": "plan",
  "decision": "delegate",
  "summary": "Split the work into implementation and tests.",
  "details": "The parent should wait for both required children.",
  "artifacts": {},
  "blocking_issues": [],
  "pending_actions": [],
  "subtasks": [
    {
      "title": "Implement parser changes",
      "instructions": "Modify the parser and update unit tests for valid imports.",
      "suggested_agent": "codex-coder",
      "required": true,
      "depends_on": [],
      "acceptance_criteria": ["Parser accepts the new format", "Focused tests pass"],
      "expected_artifact": "Patch and test summary"
    },
    {
      "title": "Review edge cases",
      "instructions": "Look for invalid input and duplicate import failures.",
      "suggested_agent": "claude-reviewer",
      "required": true,
      "depends_on": ["Implement parser changes"],
      "acceptance_criteria": ["Edge cases are listed with pass/fail status"],
      "expected_artifact": "Review notes"
    }
  ]
}
```

`suggested_agent` falls back to the parent owner if the named agent is missing
or disabled. `depends_on` can name another subtask in the same batch or an
existing task id/key.

## Common Mistakes To Avoid

- Do not send `status` or `executor_agent`; Worklab rejects them.
- Do not force a reviewer when the task does not need review; use
  `reviewer_agent: null`.
- Do not duplicate project-level common instructions in each task.
- Do not create rows directly in SQLite for user operations.
- Do not start a run from `awaiting_children`, `awaiting_user`, `blocked`, or
  `done`; move the task to `plan`, `execute`, or `review` first when appropriate.
- Do not set `builtin_allowlist` for Codex CLI agents.
- Do not assume model ids are still current; query model availability first.
