import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../ui/src/lib/api.js";

function uiSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...uiSourceFiles(path));
    } else if (/\.[cm]?[jt]sx?$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

describe("ui API client", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches run cost summary through a named helper", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        today: { total_usd: 0.01, run_count: 1 },
        week: { total_usd: 0.01, run_count: 1 },
        today_by_agent: [],
      }),
    }));

    const result = await api.getRunCostSummary();

    expect(result.today.total_usd).toBe(0.01);
    expect(global.fetch).toHaveBeenCalledWith("/api/runs/cost-summary", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
  });

  it("checks and applies app updates through named helpers", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ update: { update_available: true } }),
    }));

    await api.getUpdate({ refresh: "1" });
    await api.applyUpdate("0.2.0");

    expect(global.fetch).toHaveBeenCalledWith("/api/update?refresh=1", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
    expect(global.fetch).toHaveBeenCalledWith("/api/update/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "0.2.0" }),
    });
  });

  it("fetches core health and optional service status through app-status helpers", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));

    await api.getHealth();
    await api.getServiceStatus();

    expect(global.fetch).toHaveBeenCalledWith("/api/health", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
    expect(global.fetch).toHaveBeenCalledWith("/api/services/status", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
  });

  it("sends assistant messages through a named helper", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ run: { id: "run-1" } }),
    }));

    const result = await api.sendAssistantMessage("Create a task");

    expect(result.run.id).toBe("run-1");
    expect(global.fetch).toHaveBeenCalledWith("/api/assistant/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Create a task" }),
    });
  });

  it("sends assistant view context when provided", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ run: { id: "run-1" } }),
    }));

    await api.sendAssistantMessage("What is happening here?", {
      view: "task_detail",
      resource_type: "task",
      resource_id: "task-1",
      selected_run_id: "run-1",
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/assistant/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "What is happening here?",
        view_context: {
          view: "task_detail",
          resource_type: "task",
          resource_id: "task-1",
          selected_run_id: "run-1",
        },
      }),
    });
  });

  it("fetches assistant blank state through a named helper", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ thread: { id: "personal" }, messages: [], history: { has_more: true } }),
    }));

    const result = await api.getAssistant({ view: "blank" });

    expect(result.history.has_more).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith("/api/assistant?view=blank", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
  });

  it("fetches paged assistant messages through a named helper", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "msg-1" }], history: { has_more: false } }),
    }));

    const result = await api.getAssistantMessages({ limit: "5", before: "msg-6" });

    expect(result.messages[0].id).toBe("msg-1");
    expect(global.fetch).toHaveBeenCalledWith("/api/assistant/messages?limit=5&before=msg-6", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
  });

  it("lists projects with query parameters", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ projects: [{ id: "project-1", name: "Launch" }] }),
    }));

    const result = await api.listProjects({ include_archived: "true", q: "launch" });

    expect(result.projects[0].id).toBe("project-1");
    expect(global.fetch).toHaveBeenCalledWith("/api/projects?include_archived=true&q=launch", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
  });

  it("creates projects through a named helper", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ project: { id: "project-1", name: "Launch" } }),
    }));

    const result = await api.createProject({ name: "Launch", context: "Shared notes" });

    expect(result.project.name).toBe("Launch");
    expect(global.fetch).toHaveBeenCalledWith("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Launch", context: "Shared notes" }),
    });
  });

  it("encodes dynamic path segments from decoded route ids", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await api.getTask("task 1");
    await api.patchTask("task/1", { title: "Updated" });
    await api.getRun("run/1");
    await api.getAgent("agent 1");
    await api.getSkill("skill/1");
    await api.getProvider("provider 1");

    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/tasks/task%201",
      "/api/tasks/task%2F1",
      "/api/runs/run%2F1",
      "/api/agents/agent%201",
      "/api/skills/skill%2F1",
      "/api/providers/provider%201",
    ]);
  });

  it("supports summary task detail queries and explicit task run history loads", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await api.getTask("task 1", { runs: "summary", run_limit: "20" });
    await api.listTaskRuns("task 1", { view: "full" });

    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/tasks/task%201?runs=summary&run_limit=20",
      "/api/tasks/task%201/runs?view=full",
    ]);
  });

  it("preserves query parameters when request signals are provided", async () => {
    const controller = new AbortController();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await api.getTask("task 1", { runs: "summary", run_limit: "20", signal: controller.signal });
    await api.listAgents({ view: "summary", signal: controller.signal });
    await api.listAgents({ view: "summary" }, { signal: controller.signal });

    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/tasks/task%201?runs=summary&run_limit=20",
      "/api/agents?view=summary",
      "/api/agents?view=summary",
    ]);
    expect(global.fetch.mock.calls.map(([, options]) => options.signal)).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
  });

  it("uses named ACP profile, operation, and mono discovery helpers", async () => {
    const controller = new AbortController();
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await api.listAcpProfiles({ signal: controller.signal });
    await api.getAcpProfile("profile/1");
    await api.createAcpProfile({ driver: "generic", command: "/usr/local/bin/agent" });
    await api.patchAcpProfile("profile/1", { cwd: "/workspace" });
    await api.probeAcpProfile("profile/1");
    await api.listAcpProfileSessions("profile/1");
    await api.getAcpOperation("operation/1");
    await api.listAcpOperationInteractions("operation/1");
    await api.listAcpInteractions({ state: "pending" });
    await api.respondAcpInteraction("interaction/1", { optionId: "allow" });
    await api.discoverMonoAgents({ signal: controller.signal });

    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/acp/profiles",
      "/api/acp/profiles/profile%2F1",
      "/api/acp/profiles",
      "/api/acp/profiles/profile%2F1",
      "/api/acp/profiles/profile%2F1/probe",
      "/api/acp/profiles/profile%2F1/sessions:list",
      "/api/acp/operations/operation%2F1",
      "/api/acp/operations/operation%2F1/interactions",
      "/api/acp/interactions?state=pending",
      "/api/acp/interactions/interaction%2F1/respond",
      "/api/acp/discovery/mono",
    ]);
    expect(global.fetch.mock.calls.map(([, options]) => options.method)).toEqual([
      "GET", "GET", "POST", "PATCH", "POST", "POST", "GET", "GET", "GET", "POST", "GET",
    ]);
    expect(global.fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(global.fetch.mock.calls[10][1].signal).toBe(controller.signal);
  });

  it("imports mono-agent discovery by source id only", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ profile: { id: "profile-1" } }),
    }));

    await api.importMonoAgent("mono-source-1");

    expect(global.fetch).toHaveBeenCalledWith("/api/acp/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "mono-source-1" }),
      signal: undefined,
    });
  });
});

describe("ui API call sites", () => {
  it("use named API helpers instead of generic verb helpers", () => {
    const uiRoot = resolve(import.meta.dirname, "../../ui/src");
    const genericCalls = [];
    for (const file of uiSourceFiles(uiRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bapi\.(get|post|put|patch|delete)\s*\(/g)) {
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        genericCalls.push(`${relative(uiRoot, file)}:${line}: ${match[0]}`);
      }
    }

    expect(genericCalls).toEqual([]);
  });

  it("loads task detail with summary runs before explicit full history", () => {
    const taskDetailSource = readFileSync(resolve(import.meta.dirname, "../../ui/src/routes/TaskDetail.jsx"), "utf8");
    expect(taskDetailSource).toMatch(/api\.getTask\(id,\s*\{\s*runs:\s*"summary",\s*run_limit:/);
    expect(taskDetailSource).toMatch(/api\.listTaskRuns\(operationTaskId,\s*\{\s*view:\s*"full"/);
  });

  it("keeps create-to-detail navigation on cached summary data", () => {
    const taskEditSource = readFileSync(resolve(import.meta.dirname, "../../ui/src/routes/TaskEdit.jsx"), "utf8");
    expect(taskEditSource).toMatch(/writeTaskDetailSummaryCache/);
    expect(taskEditSource).toMatch(/const r = await api\.createTask\(patch\);[\s\S]*writeTaskDetailSummaryCache\(r\.task\);[\s\S]*return taskRouteId\(r\.task\);/);
  });

  it("uses summary agent payloads on task create and detail surfaces", () => {
    const taskEditSource = readFileSync(resolve(import.meta.dirname, "../../ui/src/routes/TaskEdit.jsx"), "utf8");
    const taskDetailSource = readFileSync(resolve(import.meta.dirname, "../../ui/src/routes/TaskDetail.jsx"), "utf8");
    expect(taskEditSource).toMatch(/api\.listAgents\(\{\s*view:\s*"summary"\s*\},\s*\{\s*signal:/);
    expect(taskDetailSource).toMatch(/api\.listAgents\(\{\s*view:\s*"summary"\s*\},\s*\{\s*signal:/);
  });
});
