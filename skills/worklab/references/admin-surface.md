# Worklab Admin Surface

Read this when a Worklab request touches anything beyond basic task/agent
creation, or when a named MCP tool is missing and the HTTP API fallback is
needed.

## Discovery First

- Start with `worklab_status` for health, service state, and effective config.
- Use compact list tools first, then get/detail tools for the target resource.
- Prefer named admin MCP tools. Use `worklab_api_request` only for supported
  `/api/*` paths that have no named tool.
- Do not write directly to `worklab.db`, `~/.worklab/config`, journals,
  memories, or skill folders unless the user explicitly asks for file repair or
  Worklab development.

## Current View And Resource References

The in-app assistant passes compact view context for routes such as:

- Tasks: `task_list`, `task_new`, `task_detail`, `task_edit`; detail can include
  `selected_run_id`.
- Projects: `project_list`, `project_new`, `project_detail`, `project_edit`.
- Agents, skills, knowledge, providers: list/new/detail/edit variants.
- Activity, automations, settings, and design-system views.

Use this context only as a pointer. When a request depends on exact saved state,
call the relevant tool:

- Current task/run: `worklab_task_get`, `worklab_run_get`.
- Current project: `worklab_project_get`.
- Current agent: `worklab_agent_get`, `worklab_agent_runs`.
- Current skill: `worklab_skill_get`, `worklab_skill_usage`.
- Current KB entry: `worklab_kb_read`.
- Current provider: `worklab_provider_get`, `worklab_provider_models`.

If no current resource id/key is available, ask for it instead of guessing.

## Admin MCP Tool Map

Service and runtime:

- `worklab_status`: app health, service metadata, config.
- `worklab_service_status`, `worklab_service_restart`,
  `worklab_service_stop`: user service lifecycle.
- HTTP-only runtime settings:
  - `GET /api/settings/runtime`
  - `PATCH /api/settings/runtime`
  - `POST /api/settings/runtime/restart`

Settings, models, and providers:

- `worklab_settings_get`, `worklab_settings_update`.
- `worklab_model_available`, `worklab_model_embeddings`.
- `worklab_provider_list/get/create/update/delete/test/discover`.
- `worklab_provider_models`, `worklab_provider_model_update`.
- Use `/api/models/available` for runnable agent/chat models.
- Use `/api/models/embeddings` for embedding model settings.

MCP configuration:

- `worklab_mcp_config_get`, `worklab_mcp_config_set`,
  `worklab_mcp_status`.
- HTTP-only smoke check: `POST /api/mcp/health`.
- Worklab validates stdio MCP commands as absolute paths. Verify live endpoints
  before registering SSE or HTTP MCP servers.

Projects:

- `worklab_project_list/get/create/update/archive`.
- Project `context` and `workdir` are run-input inputs for linked tasks.
- Put common/shared instructions, repo norms, recurring constraints, and stable
  background into project context rather than repeating them in every task.
- Treat user-supplied project workdirs as definite; create/patch exactly what
  the user supplied unless they ask for path normalization.

Tasks, comments, subtasks, and runs:

- `worklab_task_list/get/create/create_many/update/bulk_update/delete`.
- `worklab_task_comment`, `worklab_task_comment_delete`.
- `worklab_task_create_subtask`.
- `worklab_task_run`, `worklab_task_cancel`.
- `worklab_run_get`, `worklab_activity_list`.
- Task instructions should contain the task-specific delta, acceptance
  criteria, one-off constraints, and current request details. Do not repeat the
  linked project's common context unless intentionally overriding or narrowing
  it for that task.
- `reviewer_agent` may be `null` or omitted when independent review is not
  needed. With no reviewer, an execute-stage owner `advance` completes the task
  directly.
- HTTP-only useful paths:
  - `GET /api/tasks/:id/runs`
  - `GET /api/tasks/:id/run-preview`
  - `POST /api/tasks/:id/retry`
  - `GET /api/runs/cost-summary`
  - `GET /api/runs/:id/raw-log`
  - `GET /api/runs/:id/stream`
  - `POST /api/runs/:id/messages` for live run input when supported.

Agents and memory:

- `worklab_agent_list/get/create/update/delete`.
- `worklab_agent_runs`, `worklab_agent_journal`,
  `worklab_agent_consolidate`.
- HTTP-only memory read: `GET /api/agents/:name/memory`.
- Agent-side run tools include `journal_append`, `journal_summary`,
  `memory_read`, `run_log_read`, `journal_search`, and `memory_search`.

Skills:

- `worklab_skill_list/get/create/update/delete/usage`.
- HTTP-only ZIP import: `POST /api/skills/import`.
- Imported Worklab runtime skills are filesystem-backed under
  `dataDir/skills/<skill-name>/`.
- This host-tool skill can be installed into Codex or Claude Code with
  `worklab install-skill --target codex|claude|all`; that is separate from
  Worklab runtime skill import.
- Bundled `scripts/`, `references/`, `assets/`, and `agents/openai.yaml`
  should be preserved.
- Use `priority: always`, `trigger`, and `display_name` when a Worklab runtime
  skill must inline reliably.

Knowledge Base and search:

- `worklab_kb_list/read/create/update/delete`.
- `worklab_search` searches KB, journals, and memories. Use `kind` values
  `all`, `kb`, `journal`, or `memory`.
- Agent-side tools include `kb_create`, `kb_update`, `kb_delete`, `kb_read`,
  `kb_list`, and `kb_search`.
- Preserve substantial deliverables, reusable analysis, and runbooks in KB
  rather than leaving them only in chat or run output.

Automations:

- `worklab_automation_list/get/create/update/delete/run`.
- Task-scoped automation paths also exist under
  `/api/tasks/:taskId/automations`.
- Preserve existing recurring automations when migrating tools/providers; patch
  instructions/config rather than disabling unless requested.

Assistant chat and runs:

- HTTP-only assistant paths:
  - `GET /api/assistant`
  - `GET /api/assistant/messages`
  - `POST /api/assistant/messages`
  - `GET /api/assistant/runs/:id`
  - `POST /api/assistant/runs/:id/cancel`
  - `GET /api/assistant/runs/:id/stream`
- Only one assistant run can be active in the personal thread. Cancel or wait
  before starting another.
- Assistant run results use `worklab.assistant.v1`, not task-run
  `worklab.v2`.
- The assistant persists journal bullets and durable memory facts for its
  configured agent; do not put transient current-view facts into durable memory.

Events and Slack:

- Global SSE: `GET /api/events/stream`.
- Slack status: `GET /api/slack/status`.
- Slack service/skill changes should preserve tokens as managed local secrets;
  never place bearer tokens in skill text, task instructions, KB, or final
  replies.

## Validation Matrix

- After MCP edits: fetch `/api/mcp/status` and run `POST /api/mcp/health` for
  new/changed servers.
- After provider edits: run provider test and model discovery/list checks.
- After settings/runtime edits: fetch settings/runtime and service status; note
  when restart is required.
- After skill edits/imports: fetch skill detail and usage; confirm file tree.
- After task/run actions: fetch task detail, run detail, and activity.
- After automation edits: fetch automation detail and, if requested, run once.
