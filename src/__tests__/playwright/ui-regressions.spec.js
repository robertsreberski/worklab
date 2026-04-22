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
      // Keep polling until the app is ready.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
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
    body: { title, description: `${title} description` },
    ok: [201],
  });
  if (Object.keys(patch).length > 0) {
    await requestJson(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: patch,
      ok: [200],
    });
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
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        category: entry.category,
        pinned: entry.pinned,
      },
      ok: [200],
    });
  }
}

async function expectNoHorizontalOverflow(page) {
  const widths = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.innerWidth);
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
      new Promise((resolveExit) => serverProcess.once("exit", resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
    ]);
    if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
});

test("kb edit loads existing entries from the nested API shape", async ({ page }) => {
  await page.goto(`${baseUrl}/#/knowledge/welcome`);
  await expect(page.getByRole("heading", { name: "Welcome guide" })).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue(/nested KB route shape/);
});

test("dark theme link and form controls keep cards readable", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".task-card").first()).toBeVisible();
  const taskCardStyles = await page.locator(".task-card").first().evaluate((node) => {
    const styles = window.getComputedStyle(node);
    return {
      color: styles.color,
      backgroundColor: styles.backgroundColor,
      display: styles.display,
    };
  });
  expect(taskCardStyles.color).not.toBe("rgb(0, 0, 238)");
  expect(taskCardStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(taskCardStyles.display).toBe("block");

  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.getByText("Set an executor agent to enable Run now.")).toBeVisible();
  const backLinkStyles = await page.locator(".back-link").evaluate((node) => {
    const styles = window.getComputedStyle(node);
    return { color: styles.color, textDecorationLine: styles.textDecorationLine };
  });
  expect(backLinkStyles.color).not.toBe("rgb(0, 0, 238)");
  expect(backLinkStyles.textDecorationLine).toBe("none");

  await page.goto(`${baseUrl}/#/providers`);
  const selectStyles = await page.locator("select").first().evaluate((node) => {
    const styles = window.getComputedStyle(node);
    return { backgroundColor: styles.backgroundColor, color: styles.color };
  });
  expect(selectStyles.backgroundColor).not.toBe("rgb(255, 255, 255)");
  expect(selectStyles.color).not.toBe("rgb(0, 0, 0)");

  await page.goto(`${baseUrl}/#/settings`);
  const checkboxBox = await page.locator("input[type=\"checkbox\"]").boundingBox();
  expect(checkboxBox.width).toBeLessThan(30);
});

test("mobile routes stay usable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(`${baseUrl}/#/tasks`);
  const columns = page.locator(".column");
  await expect(columns).toHaveCount(4);
  const firstColumn = await columns.nth(0).boundingBox();
  const secondColumn = await columns.nth(1).boundingBox();
  expect(secondColumn.y).toBeGreaterThan(firstColumn.y);
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "+ New task" }).click();
  const modalBox = await page.locator(".modal").boundingBox();
  expect(modalBox.width).toBeLessThanOrEqual(390);

  await page.goto(`${baseUrl}/#/knowledge`);
  await expect(page.locator(".knowledge-table tbody tr").first()).toBeVisible();
  const knowledgeRowDisplay = await page.locator(".knowledge-table tbody tr").first().evaluate(
    (node) => window.getComputedStyle(node).display,
  );
  expect(knowledgeRowDisplay).toBe("block");
  await expectNoHorizontalOverflow(page);

  const routes = [
    { hash: `#/tasks/${taskId}`, ready: () => page.getByRole("heading", { name: "UI regression task" }) },
    { hash: "#/agents/new", ready: () => page.getByRole("heading", { name: "New agent" }) },
    { hash: "#/providers", ready: () => page.getByRole("heading", { name: "Providers" }) },
    { hash: "#/knowledge/welcome", ready: () => page.getByRole("heading", { name: "Welcome guide" }) },
    { hash: "#/settings", ready: () => page.getByRole("heading", { name: "Settings" }) },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(route.ready()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
