import { describe, expect, it, vi } from "vitest";
import { adminToolDefinitions, apiRequest, createAdminToolHandlers } from "../../mcp/admin-tools.js";

describe("admin MCP tools", () => {
  it("exposes full-access API escape hatch and task wrappers", () => {
    const names = adminToolDefinitions.map((tool) => tool.name);
    expect(names).toContain("worklab_api_request");
    expect(names).toContain("worklab_task_create");
    expect(names).toContain("worklab_automation_create");
    expect(names).not.toContain("worklab_schedule_create");
    expect(names).toContain("worklab_service_restart");
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

    const automation = await handlers.worklab_automation_run({ id: "auto_1" });
    expect(automation.url).toBe("http://localhost:7878/api/automations/auto_1/run");
    expect(automation.method).toBe("POST");
  });
});
