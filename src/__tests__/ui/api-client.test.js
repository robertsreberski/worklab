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
});
