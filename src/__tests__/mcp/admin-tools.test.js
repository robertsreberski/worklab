import { describe, expect, it, vi } from "vitest";
import { adminToolDefinitions, apiRequest, createAdminToolHandlers } from "../../mcp/admin/tools/index.js";

describe("admin MCP tools", () => {
  it("exposes full-access API escape hatch and task wrappers", () => {
    const names = adminToolDefinitions.map((tool) => tool.name);
    expect(names).toContain("worklab_api_request");
    expect(names).toContain("worklab_project_create");
    expect(names).toContain("worklab_project_archive");
    expect(names).toContain("worklab_task_create");
    expect(names).toContain("worklab_task_create_many");
    expect(names).toContain("worklab_task_bulk_update");
    expect(names).toContain("worklab_task_comment_delete");
    expect(names).toContain("worklab_agent_create");
    expect(names).toContain("worklab_automation_create");
    expect(names).toContain("worklab_kb_organize");
    expect(names).toContain("worklab_kb_cleanup_auto_promoted");
    expect(names).not.toContain("worklab_schedule_create");
    expect(names).toContain("worklab_service_restart");
  });

  // Snapshot-style guard: catches accidental drift after the per-domain
  // tool-module split. Tool names must be unique and the total count must
  // not change without an explicit edit to this number.
  it("registers exactly 78 unique admin tool definitions", () => {
    expect(adminToolDefinitions.length).toBe(78);
    const names = adminToolDefinitions.map((tool) => tool.name);
    expect(new Set(names).size).toBe(adminToolDefinitions.length);
  });

  it("marks KB admin tools with read/destructive annotations", () => {
    expect(adminToolDefinitions.find((tool) => tool.name === "worklab_kb_list")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(adminToolDefinitions.find((tool) => tool.name === "worklab_kb_delete")?.annotations).toMatchObject({
      destructiveHint: true,
    });
    expect(adminToolDefinitions.find((tool) => tool.name === "worklab_kb_organize")?.inputSchema.properties).toHaveProperty("apply");
    expect(adminToolDefinitions.find((tool) => tool.name === "worklab_kb_cleanup_auto_promoted")?.annotations).toMatchObject({
      destructiveHint: true,
    });
    expect(adminToolDefinitions.find((tool) => tool.name === "worklab_kb_cleanup_auto_promoted")?.inputSchema.properties).toHaveProperty("apply");
  });

  it("defines create-agent with explicit MCP fields", () => {
    const tool = adminToolDefinitions.find((definition) => definition.name === "worklab_agent_create");

    expect(tool.inputSchema.required).toEqual(["display_name", "model"]);
    expect(tool.inputSchema.properties).toMatchObject({
      display_name: { type: "string" },
      model: { type: "string" },
      instructions: { type: "string" },
      skills_allowlist: { type: "array" },
      mcp_allowlist: { type: "array" },
      builtin_allowlist: { type: "array" },
      browser_tools_review_only: { type: "boolean" },
    });
    expect(tool.inputSchema.properties.per_run_budget_usd).toBeUndefined();
    expect(tool.inputSchema.properties.daily_budget_usd).toBeUndefined();
  });

  it("apiRequest restricts requests to /api paths", async () => {
    await expect(apiRequest({ baseUrl: "http://127.0.0.1:1" }, "GET", "/mcp")).rejects.toThrow(/\/api/);
  });

  it("maps wrapper tools onto existing HTTP API routes", async () => {
    const fetchImpl = vi.fn(async (url, init) => new Response(JSON.stringify({
      url: String(url),
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const handlers = createAdminToolHandlers({
      baseUrl: "http://localhost:7878",
      config: { dataDir: "/data", repoRoot: "/repo" },
      fetchImpl,
    });

    const result = await handlers.worklab_task_update({ id: "task_1", patch: { title: "New" } });

    expect(result.url).toBe("http://localhost:7878/api/tasks/task_1");
    expect(result.method).toBe("PATCH");
    expect(result.body).toEqual({ title: "New" });

    const project = await handlers.worklab_project_create({
      name: "Project",
      context: "Shared context",
      workdir: "/tmp/project",
      worktree_mode: "auto",
    });
    expect(project.url).toBe("http://localhost:7878/api/projects");
    expect(project.method).toBe("POST");
    expect(project.body).toMatchObject({ name: "Project", context: "Shared context", workdir: "/tmp/project", worktree_mode: "auto" });

    const projectList = await handlers.worklab_project_list({ q: "proj", include_archived: true });
    expect(projectList.url).toBe("http://localhost:7878/api/projects?q=proj&include_archived=true");

    const archivedProject = await handlers.worklab_project_archive({ id: "project_1" });
    expect(archivedProject.url).toBe("http://localhost:7878/api/projects/project_1");
    expect(archivedProject.method).toBe("DELETE");

    const automation = await handlers.worklab_automation_run({ id: "auto_1" });
    expect(automation.url).toBe("http://localhost:7878/api/automations/auto_1/run");
    expect(automation.method).toBe("POST");

    const deletedComment = await handlers.worklab_task_comment_delete({ id: "task_1", comment_id: "comment_1" });
    expect(deletedComment.url).toBe("http://localhost:7878/api/tasks/task_1/comments/comment_1");
    expect(deletedComment.method).toBe("DELETE");
    expect(deletedComment.body).toBeNull();

    const members = [{ agent_name: "eng", role_description: "Build" }];
    const roster = await handlers.worklab_team_members_set({ id: "team_1", members });
    expect(roster.url).toBe("http://localhost:7878/api/teams/team_1/members");
    expect(roster.method).toBe("PUT");
    expect(roster.body).toEqual({ members });

    const taskList = await handlers.worklab_task_list({ team: "team-alpha" });
    expect(taskList.url).toBe("http://localhost:7878/api/tasks?team=team-alpha");
    expect(taskList.method).toBe("GET");
    expect(taskList.body).toBeNull();
  });

  it("returns compact filtered agent summaries without full instructions", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      agents: [
        {
          name: "game-dev",
          display_name: "Game Dev",
          description: "Builds games",
          sdk: "pi",
          model: "pi:openai-codex:gpt-5.5",
          effort: "xhigh",
          instructions: "Very long private instructions ".repeat(1000),
          skills_allowlist: ["sprite-work"],
          skills_allowlist_mode: "custom",
          mcp_allowlist: ["worklab"],
          mcp_allowlist_mode: "custom",
          builtin_allowlist: [],
          builtin_allowlist_mode: "all",
          allow_self_review: true,
          browser_tools_review_only: true,
          enabled: true,
          last_run_at: 123,
          run_count_30d: 4,
          avg_run_duration_ms: 5000,
        },
        {
          name: "archived-agent",
          display_name: "Archived Agent",
          instructions: "should not match",
          enabled: false,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const handlers = createAdminToolHandlers({ baseUrl: "http://localhost:7878", fetchImpl });

    const result = await handlers.worklab_agent_list({ q: "game", enabled: true, limit: 1 });

    expect(result).toMatchObject({ count: 2, matched: 1, returned: 1, truncated: false });
    expect(result.agents[0]).toMatchObject({
      name: "game-dev",
      model: "pi:openai-codex:gpt-5.5",
      skills_allowlist: { mode: "custom", count: 1 },
      mcp_allowlist: { mode: "custom", count: 1 },
      browser_tools_review_only: true,
    });
    expect(result.agents[0]).not.toHaveProperty("instructions");
    expect(JSON.stringify(result)).not.toContain("Very long private instructions");
  });

  it("returns compact outputs for task and agent creation MCP helpers", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/tasks") {
        return new Response(JSON.stringify({
          task: {
            id: "task-1",
            task_key: "T-1",
            title: "Build it",
            instructions: "Long task instructions ".repeat(500),
            stage: "plan",
            run_policy: "manual",
            owner_agent: "builder",
            reviewer_agent: "reviewer",
            dependency_ids: ["T-0"],
          },
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (path === "/api/agents") {
        return new Response(JSON.stringify({
          agent: {
            name: "builder",
            display_name: "Builder",
            model: "pi:openai-codex:gpt-5.5",
            effort: "high",
            instructions: "Long private instructions ".repeat(500),
            skills_allowlist: ["frontend"],
            skills_allowlist_mode: "custom",
            mcp_allowlist: [],
            mcp_allowlist_mode: "all",
            builtin_allowlist: [],
            builtin_allowlist_mode: "all",
            enabled: true,
          },
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });
    const handlers = createAdminToolHandlers({ baseUrl: "http://localhost:7878", fetchImpl });

    const task = await handlers.worklab_task_create({ title: "Build it", instructions: "Long task instructions" });
    const agent = await handlers.worklab_agent_create({ display_name: "Builder", model: "pi:openai-codex:gpt-5.5" });

    expect(task.task).toMatchObject({ id: "task-1", task_key: "T-1", dependency_count: 1 });
    expect(JSON.stringify(task)).not.toContain("Long task instructions");
    expect(agent.agent).toMatchObject({
      name: "builder",
      model: "pi:openai-codex:gpt-5.5",
      skills_allowlist: { mode: "custom", count: 1 },
    });
    expect(JSON.stringify(agent)).not.toContain("Long private instructions");
    expect(fetchImpl).toHaveBeenCalledWith(new URL("http://localhost:7878/api/tasks"), expect.objectContaining({
      method: "POST",
    }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ title: "Build it", instructions: "Long task instructions" });
  });

  it("creates many tasks and bulk-updates tasks through compact MCP helpers", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init.body ? JSON.parse(init.body) : {};
      if (path === "/api/tasks/bulk") {
        return new Response(JSON.stringify({
          summary: { requested: 2, succeeded: 2, failed: 0 },
          results: body.ids.map((id) => ({
            id,
            task_id: `internal-${id}`,
            ok: true,
            task: { id: `internal-${id}`, task_key: id, title: `Updated ${id}`, stage: body.patch.stage },
          })),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        task: { id: body.client_request_id || body.title, task_key: "T-9", title: body.title, stage: "plan" },
      }), { status: 201, headers: { "content-type": "application/json" } });
    });
    const handlers = createAdminToolHandlers({ baseUrl: "http://localhost:7878", fetchImpl });

    const created = await handlers.worklab_task_create_many({
      tasks: [{ title: "One", client_request_id: "one" }, { title: "Two", client_request_id: "two" }],
    });
    const updated = await handlers.worklab_task_bulk_update({ ids: ["T-1", "T-2"], patch: { stage: "execute" } });

    expect(created.summary).toEqual({ requested: 2, succeeded: 2, failed: 0 });
    expect(created.results.map((result) => result.task.id)).toEqual(["one", "two"]);
    expect(updated.summary.succeeded).toBe(2);
    expect(updated.results[0]).toMatchObject({
      id: "T-1",
      ok: true,
      task: { task_key: "T-1", stage: "execute" },
    });
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body)).toEqual({
      operation: "patch",
      ids: ["T-1", "T-2"],
      patch: { stage: "execute" },
    });
  });

  it("returns compact filtered model choices without raw catalogs", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      groups: [
        {
          id: "pi:openai-codex",
          label: "OpenAI Codex",
          runtime_kind: "pi-agent",
          models: [
            {
              value: "pi:openai-codex:gpt-5.5",
              label: "Codex GPT-5.5",
              description: "Flagship",
              sdk: "pi",
              provider: "openai-codex",
              model: "gpt-5.5",
              capabilities: {
                context_window: 400000,
                max_tokens: 128000,
                reasoning: true,
                reasoning_levels: ["low", "medium", "high", "xhigh"],
                tool_use: true,
              },
              pricing: { input: 1, output: 2 },
              builtin_tools: ["Read", "Write", "Bash"],
              available: true,
            },
          ],
        },
        {
          id: "claude",
          label: "Claude",
          models: [{
            value: "claude:claude-sonnet-4-6",
            label: "Claude Sonnet",
            sdk: "claude",
            model: "claude-sonnet-4-6",
            capabilities: {},
            available: true,
          }],
        },
      ],
      models: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const handlers = createAdminToolHandlers({ baseUrl: "http://localhost:7878", fetchImpl });

    const result = await handlers.worklab_model_available({ sdk: "pi", limit: 1 });

    expect(result).toMatchObject({ count: 2, available_count: 2, matched: 1, returned: 1, truncated: false });
    expect(result.models[0]).toMatchObject({
      value: "pi:openai-codex:gpt-5.5",
      sdk: "pi",
      provider: "openai-codex",
      context_window: 400000,
      max_tokens: 128000,
      reasoning_levels: ["low", "medium", "high", "xhigh"],
    });
    expect(result.models[0]).not.toHaveProperty("capabilities");
    expect(result.models[0]).not.toHaveProperty("pricing");
    expect(result.models[0]).not.toHaveProperty("builtin_tools");
  });
});
