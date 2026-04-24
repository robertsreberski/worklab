import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

let serverProcess;
let baseUrl;
let dataDir;
let workspaceDir;
let taskId;
let blockerTaskId;
let blockedTaskId;
let scheduleId;

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(url, processRef) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) throw new Error("Worklab exited before becoming healthy.");
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for Worklab at ${url}`);
}

async function requestJson(path, { method = "GET", body, ok = [200] } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!ok.includes(response.status)) {
    const text = await response.text();
    throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  }
  if (response.status === 204) return null;
  return await response.json();
}

async function createTask(title, patch = {}) {
  const { task } = await requestJson("/api/tasks", {
    method: "POST",
    body: { title, description: `${title} description`, ...patch },
    ok: [201],
  });
  const patchBody = { ...patch };
  delete patchBody.blocked_by_ids;
  if (Object.keys(patchBody).length > 0) {
    await requestJson(`/api/tasks/${task.id}`, { method: "PATCH", body: patchBody, ok: [200] });
  }
  return task.id;
}

async function ensureKbEntry(entry) {
  try {
    await requestJson("/api/kb", { method: "POST", body: entry, ok: [201] });
  } catch (error) {
    if (!String(error.message).includes("409")) throw error;
    await requestJson(`/api/kb/${entry.slug}`, {
      method: "PATCH",
      body: {
        title: entry.title, body: entry.body, tags: entry.tags,
        category: entry.category, pinned: entry.pinned,
      },
      ok: [200],
    });
  }
}

async function expectNoHorizontalOverflow(page, label = "") {
  const data = await page.evaluate(() => {
    const offenders = [];
    const docScroll = document.documentElement.scrollWidth;
    for (const el of document.body.querySelectorAll("*")) {
      if (el.scrollWidth > window.innerWidth && el.offsetWidth > window.innerWidth) {
        const style = window.getComputedStyle(el);
        offenders.push({
          tag: el.tagName + (el.className ? "." + String(el.className).split(" ").join(".") : ""),
          scrollWidth: el.scrollWidth,
          offsetWidth: el.offsetWidth,
          overflowX: style.overflowX,
        });
      }
      if (offenders.length > 8) break;
    }
    return { innerWidth: window.innerWidth, scrollWidth: docScroll, offenders };
  });
  if (data.scrollWidth > data.innerWidth) {
    console.error(`Overflow on ${label}: scrollWidth=${data.scrollWidth}, innerWidth=${data.innerWidth}`);
    console.error("Offenders:", JSON.stringify(data.offenders, null, 2));
  }
  expect(data.scrollWidth, `${label}: scrollWidth=${data.scrollWidth}`).toBeLessThanOrEqual(data.innerWidth);
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-ui-data-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worklab-ui-workspace-"));
  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;

  serverProcess = spawn(process.execPath, ["src/cli/index.js", "start"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKLAB_DATA_DIR: dataDir,
      WORKLAB_WORKSPACE: workspaceDir,
      WORKLAB_PORT: String(port),
      WORKLAB_LOG_LEVEL: "error",
    },
    stdio: "ignore",
  });

  await waitForHealth(baseUrl, serverProcess);

  taskId = await createTask("UI regression task");
  await createTask("In progress task", { status: "in_progress" });
  blockerTaskId = await createTask("Dependency blocker");
  blockedTaskId = await createTask("Blocked detail task", { blocked_by_ids: [blockerTaskId] });
  const schedule = await requestJson("/api/schedules", {
    method: "POST",
    body: {
      title: "Regression schedule",
      description: "Ensures schedules route renders.",
      cadence: { type: "daily", hour: 9, minute: 15 },
      enabled: true,
    },
    ok: [201],
  });
  scheduleId = schedule.schedule.id;
  await requestJson(`/api/schedules/${scheduleId}/run`, { method: "POST", ok: [201] });

  await ensureKbEntry({
    slug: "welcome",
    title: "Welcome guide",
    category: "guide",
    tags: ["intro", "setup"],
    pinned: true,
    body: "# Welcome\n\nThis seeded entry exercises the nested KB route shape.",
  });
  await ensureKbEntry({
    slug: "mobile-layout-reference",
    title: "Mobile layout reference",
    category: "reference",
    tags: ["very-long-tag-name-for-mobile-layout", "wrapping-check"],
    body: "This entry keeps the knowledge list populated for the responsive layout test.",
  });
});

test.afterAll(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGINT");
    await Promise.race([
      new Promise((r) => serverProcess.once("exit", r)),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
});

test("commander lists tasks grouped by status", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();
  const groups = page.locator(".commander-group");
  const groupCount = await groups.count();
  expect(groupCount).toBeGreaterThan(0);
  // Dark-theme sanity check on row styling
  const rowStyles = await page.locator(".commander-row").first().evaluate((node) => {
    const s = window.getComputedStyle(node);
    return { color: s.color, background: s.backgroundColor };
  });
  expect(rowStyles.color).not.toBe("rgb(0, 0, 238)");
});

test("knowledge entry loads via the two-pane URL", async ({ page }) => {
  await page.goto(`${baseUrl}/#/knowledge/welcome`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Welcome guide" })).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue(/nested KB route shape/);
});

test("agents two-pane: clicking a list row selects inline editor via URL", async ({ page }) => {
  await page.goto(`${baseUrl}/#/agents/new`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "New agent" })).toBeVisible();
});

test("task edit is reachable via #/tasks/new and shows a full-page form", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/new`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();
  await expect(page.locator('input[placeholder*="actionable"]')).toBeVisible();
});

test("task detail renders two-column layout", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-hero-title", { hasText: "UI regression task" })).toBeVisible();
  await expect(page.locator(".task-detail-rail")).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Agents" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Details" })).toBeVisible();
});

test("task detail shows linked dependencies when the graph exists", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${blockedTaskId}`);
  await expect(page.locator(".card-title", { hasText: "Dependencies" })).toBeVisible();
  await expect(page.locator(".blocked-link", { hasText: "Dependency blocker" })).toBeVisible();
});

test("schedules route mounts the pane editor with upcoming and recent sections", async ({ page }) => {
  await page.goto(`${baseUrl}/#/schedules/${scheduleId}`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Regression schedule" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Upcoming fires" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Recent spawned tasks" })).toBeVisible();
});

test("mobile routes stay usable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const routes = [
    { hash: "#/tasks", ready: () => page.locator(".commander-row").first() },
    { hash: `#/tasks/${taskId}`, ready: () => page.locator(".task-hero-title", { hasText: "UI regression task" }) },
    { hash: "#/tasks/new", ready: () => page.locator(".task-edit-head").first() },
    { hash: "#/agents", ready: () => page.locator('h1.app-title', { hasText: "Agents" }) },
    { hash: "#/agents/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New agent" }) },
    { hash: "#/skills", ready: () => page.locator('h1.app-title', { hasText: "Skills" }) },
    { hash: "#/knowledge", ready: () => page.locator('h1.app-title', { hasText: "Knowledge" }) },
    { hash: "#/knowledge/welcome", ready: () => page.locator(".pane-detail-head h2", { hasText: "Welcome guide" }) },
    { hash: "#/providers", ready: () => page.locator('h1.app-title', { hasText: "Providers" }) },
    { hash: "#/activity", ready: () => page.locator('h1.app-title', { hasText: "Activity" }) },
    { hash: "#/schedules", ready: () => page.locator('h1.app-title', { hasText: "Schedules" }) },
    { hash: `#/schedules/${scheduleId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression schedule" }) },
    { hash: "#/settings", ready: () => page.locator('h1.app-title', { hasText: "Settings" }) },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(route.ready()).toBeVisible({ timeout: 5000 });
    await expectNoHorizontalOverflow(page, route.hash);
  }
});

test("pressing N opens new-task form from the commander", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks`);
  await page.locator(".commander-row").first().waitFor();
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#\/tasks\/new/);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();
});
