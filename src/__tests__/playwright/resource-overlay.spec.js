import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import Database from "better-sqlite3";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

let serverProcess;
let baseUrl;
let dataDir;
let workspaceDir;
let taskId;

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
    } catch {}
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
    throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) return null;
  return await response.json();
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-overlay-data-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worklab-overlay-workspace-"));
  const port = await findFreePort();
  baseUrl = `http://localhost:${port}`;

  serverProcess = spawn(process.execPath, ["src/cli/index.js", "serve"], {
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

  const db = new Database(join(dataDir, "worklab.db"));
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (name, display_name, sdk, model, created_at, updated_at)
     VALUES (?, ?, 'codex', 'test-model', ?, ?)`,
  ).run("overlay-agent", "Overlay Agent", now, now);
  db.close();

  await requestJson("/api/projects", {
    method: "POST",
    body: {
      name: "Overlay Project",
      slug: "overlay-project",
      context: Array.from({ length: 80 }, (_, index) => `Overlay project context line ${index + 1}.`).join("\n"),
    },
    ok: [201],
  });

  const created = await requestJson("/api/tasks", {
    method: "POST",
    body: { title: "Overlay badge task", instructions: "Exercise resource overlay badge clicks." },
    ok: [201],
  });
  taskId = created.task.id;
  await requestJson(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    body: { body: "Ask @agent/overlay-agent to review @project/overlay-project." },
    ok: [201],
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

test("entity badge clicks open a resource overlay without changing the URL", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".activity-item-body .entity-badge--agent")).toBeVisible();

  const startingUrl = page.url();
  await page.locator(".activity-item-body .entity-badge--agent").click();

  await expect(page.locator(".resource-overlay-modal")).toBeVisible();
  await expect(page.locator(".resource-overlay-modal")).toContainText("Overlay Agent");
  await expect(page.locator(".resource-overlay-modal .library-route-tabs")).toHaveCount(0);
  expect(page.url()).toBe(startingUrl);

  await page.locator(".resource-overlay-modal .modal-head").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".resource-overlay-modal")).toHaveCount(0);
  expect(page.url()).toBe(startingUrl);
});

test("resource overlay shows only the resource detail view for project badges", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".activity-item-body .entity-badge--project")).toBeVisible();

  await page.locator(".activity-item-body .entity-badge--project").click();

  await expect(page.locator(".resource-overlay-modal")).toBeVisible();
  await expect(page.locator(".resource-overlay-modal")).toContainText("Overlay Project");
  await expect(page.locator(".resource-overlay-modal .pane-list")).toHaveCount(0);
  await expect(page.locator(".resource-overlay-modal .project-pane-row")).toHaveCount(0);
  await expect(page.locator(".resource-overlay-modal .project-detail-body")).toBeVisible();
});

test("resource overlay scroll container receives focus and scrolls detail content", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".activity-item-body .entity-badge--project")).toBeVisible();

  await page.locator(".activity-item-body .entity-badge--project").click();

  const scroll = page.locator(".resource-overlay-scroll");
  await expect(scroll).toBeFocused();
  await expect(scroll).toBeVisible();
  await expect(page.locator(".resource-overlay-modal .project-detail-body")).toBeVisible();

  await expect.poll(async () => scroll.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await scroll.press("PageDown");
  await expect.poll(async () => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});

test("resource overlay uses broad desktop sizing and full mobile sizing", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${baseUrl}/#/tasks/${taskId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".activity-item-body .entity-badge--agent").click();
  await expect(page.locator(".resource-overlay-modal")).toBeVisible();
  await expect.poll(async () => page.locator(".modal-backdrop").evaluate((node) => getComputedStyle(node).transform)).toBe("none");

  const desktop = await page.locator(".resource-overlay-modal").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  expect(Math.abs(desktop.width - desktop.viewportWidth * 0.8)).toBeLessThanOrEqual(24);
  expect(Math.abs(desktop.height - desktop.viewportHeight * 0.8)).toBeLessThanOrEqual(24);
  expect(desktop.width).toBeLessThanOrEqual(desktop.viewportWidth);
  expect(desktop.height).toBeLessThanOrEqual(desktop.viewportHeight);

  await page.locator(".resource-overlay-modal .modal-head").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".resource-overlay-modal")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".activity-item-body .entity-badge--agent").click();
  await expect(page.locator(".resource-overlay-modal")).toBeVisible();
  await expect.poll(async () => page.locator(".modal-backdrop").evaluate((node) => getComputedStyle(node).transform)).toBe("none");

  const mobile = await page.locator(".resource-overlay-modal").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  expect(mobile.width).toBe(mobile.viewportWidth);
  expect(mobile.height).toBe(mobile.viewportHeight);
  expect(mobile.overflow).toBeLessThanOrEqual(0);
});

test("resource overlay open-page action navigates to the full route", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".activity-item-body .entity-badge--agent").click();
  await expect(page.locator(".resource-overlay-modal")).toBeVisible();

  await page.locator(".resource-overlay-modal").getByRole("button", { name: "Open page" }).click();

  await expect(page.locator(".resource-overlay-modal")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/library\/agents\/overlay-agent$/);
});

test("dirty resource overlay edits block accidental close", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".activity-item-body .entity-badge--agent").click();
  await expect(page.locator(".resource-overlay-modal")).toBeVisible();

  await page.locator(".resource-overlay-modal .agent-profile-grid .input").first().fill("Overlay Agent Edited");
  await page.locator(".resource-overlay-modal .modal-head").getByRole("button", { name: "Close" }).click();

  await expect(page.getByRole("heading", { name: "You have unsaved changes" })).toBeVisible();
  await expect(page.locator(".resource-overlay-modal")).toBeVisible();
});
