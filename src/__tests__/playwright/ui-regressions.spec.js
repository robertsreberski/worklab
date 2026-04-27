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
let runningTaskId;
let blockerTaskId;
let blockedTaskId;
let completedTaskId;
let desktopReadyTaskId;
let desktopNeedsOwnerTaskId;
let desktopReviewTaskId;
let desktopDoneTaskId;
let desktopBlockerTaskId;
let desktopBlockedTaskId;
let desktopRunningTaskId;
let desktopErroredTaskId;
let providerId;
let skillName;

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

async function expectNoCriticalHorizontalClipping(page, selector, label = "") {
  const clipped = await page.evaluate((targetSelector) => {
    return [...document.querySelectorAll(targetSelector)]
      .filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Math.ceil(el.scrollWidth) > Math.ceil(el.clientWidth) + 1;
      })
      .map((el) => ({
        className: typeof el.className === "string" ? el.className : el.getAttribute("class") || "",
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
        clientWidth: Math.ceil(el.clientWidth),
        scrollWidth: Math.ceil(el.scrollWidth),
      }))
      .slice(0, 8);
  }, selector);
  expect(clipped, `${label}: critical UI clipped`).toEqual([]);
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-ui-data-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worklab-ui-workspace-"));
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

  const seedDb = new Database(join(dataDir, "worklab.db"));
  const agentSeededAt = Date.now();
  seedDb.prepare(
    `INSERT OR IGNORE INTO agents
      (name, display_name, sdk, model, created_at, updated_at)
     VALUES (?, ?, 'codex', 'test-model', ?, ?)`,
  ).run("regression-agent", "Regression Agent", agentSeededAt, agentSeededAt);
  seedDb.prepare(
    `INSERT OR IGNORE INTO agents
      (name, display_name, sdk, model, created_at, updated_at)
     VALUES (?, ?, 'codex', 'test-model', ?, ?)`,
  ).run("reviewer-agent", "Reviewer Agent", agentSeededAt, agentSeededAt);
  seedDb.close();

  taskId = await createTask("UI regression task", {
    owner_agent: "regression-agent",
    reviewer_agent: "reviewer-agent",
    stage: "execute",
  });
  completedTaskId = await createTask("Completed detail task", {
    owner_agent: "regression-agent",
    stage: "execute",
  });
  await requestJson(`/api/tasks/${completedTaskId}`, {
    method: "PATCH",
    body: { stage: "done" },
    ok: [200],
  });
  await createTask("Running task", { stage: "execute" });
  runningTaskId = await createTask("Running detail task", { stage: "execute", owner_agent: "regression-agent" });
  blockerTaskId = await createTask("Dependency blocker");
  blockedTaskId = await createTask("Blocked detail task", { blocked_by_ids: [blockerTaskId] });
  desktopReadyTaskId = await createTask("Desktop ready task", {
    owner_agent: "regression-agent",
    reviewer_agent: "reviewer-agent",
    stage: "execute",
  });
  desktopNeedsOwnerTaskId = await createTask("Desktop needs owner task");
  desktopReviewTaskId = await createTask("Desktop review task", {
    stage: "review",
    owner_agent: "regression-agent",
    reviewer_agent: "reviewer-agent",
  });
  desktopDoneTaskId = await createTask("Desktop done task", {
    owner_agent: "regression-agent",
    stage: "execute",
  });
  await requestJson(`/api/tasks/${desktopDoneTaskId}`, {
    method: "PATCH",
    body: { stage: "done" },
    ok: [200],
  });
  desktopBlockerTaskId = await createTask("Desktop blocker task", {
    owner_agent: "regression-agent",
    stage: "execute",
  });
  desktopBlockedTaskId = await createTask("Desktop blocked task", {
    blocked_by_ids: [desktopBlockerTaskId],
    owner_agent: "regression-agent",
    stage: "execute",
  });
  desktopRunningTaskId = await createTask("Desktop running task", {
    stage: "execute",
    owner_agent: "regression-agent",
  });
  desktopErroredTaskId = await createTask("Desktop errored task", {
    owner_agent: "regression-agent",
    stage: "execute",
  });
  await requestJson(`/api/tasks/${taskId}/automations`, {
    method: "POST",
    body: {
      trigger: { type: "daily", hour: 9, minute: 15 },
      enabled: true,
    },
    ok: [201],
  });
  const provider = await requestJson("/api/providers", {
    method: "POST",
    body: {
      name: "Regression provider",
      provider_type: "ollama",
      base_url: "http://localhost:11434",
      enabled: true,
    },
    ok: [201],
  });
  providerId = provider.provider.id;
  const skill = await requestJson("/api/skills", {
    method: "POST",
    body: {
      name: "regression-skill",
      meta: {
        display_name: "Regression Skill",
        trigger: "when regression coverage is needed",
        enabled: true,
      },
      body: "Keep edit-route action disclosure behavior covered.",
    },
    ok: [201],
  });
  skillName = skill.skill.name;

  const db = new Database(join(dataDir, "worklab.db"));
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_comments
      (id, task_id, author_type, author_id, body, created_at)
     VALUES (?, ?, 'human', NULL, ?, ?)`,
  ).run("comment-old-existing", taskId, "Older seeded comment", now - 20_000);
  db.prepare(
    `INSERT INTO task_comments
      (id, task_id, author_type, author_id, body, created_at)
     VALUES (?, ?, 'human', NULL, ?, ?)`,
  ).run("comment-newest-existing", taskId, "Newest seeded comment", now - 1_000);
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, mode, agent_name, worker_pid, status, started_at, ended_at, exit_code, error_text)
     VALUES (?, ?, 'execute', 'regression-agent', NULL, 'complete', ?, ?, 0, NULL)`,
  ).run("run-complete-existing", taskId, now - 18_000, now - 12_000);
  db.prepare(
    `INSERT INTO agent_logs
      (id, task_run_id, events, model, effort, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, num_turns, status, created_at)
     VALUES (?, ?, ?, 'test-model', 'medium', 1200, 800, 0, 0, 0.0123, 6000, 3, 'complete', ?)`,
  ).run(
    "log-complete-existing",
    "run-complete-existing",
    JSON.stringify([{ type: "text", text: "Completed seeded run", ts: now - 12_000 }]),
    now - 12_000,
  );
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, mode, agent_name, worker_pid, status, started_at, ended_at, exit_code, error_text)
     VALUES (?, ?, 'execute', 'regression-agent', ?, 'running', ?, NULL, NULL, NULL)`,
  ).run("run-live-existing", runningTaskId, process.pid, now - 10_000);
  db.prepare(
    `INSERT INTO agent_logs
      (id, task_run_id, events, model, effort, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, num_turns, status, created_at)
     VALUES (?, ?, ?, 'test-model', 'medium', 1, 1, 0, 0, 0, NULL, 1, 'running', ?)`,
  ).run(
    "log-live-existing",
    "run-live-existing",
    JSON.stringify([{ type: "text", text: "Existing streamed event", ts: now - 5_000 }]),
    now - 5_000,
  );
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, mode, agent_name, worker_pid, status, started_at, ended_at, exit_code, error_text)
     VALUES (?, ?, 'execute', 'regression-agent', ?, 'running', ?, NULL, NULL, NULL)`,
  ).run("run-desktop-running-existing", desktopRunningTaskId, process.pid, now - 9_000);
  db.prepare(
    `INSERT INTO agent_logs
      (id, task_run_id, events, model, effort, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, num_turns, status, created_at)
     VALUES (?, ?, ?, 'test-model', 'medium', 40, 20, 0, 0, 0.001, NULL, 1, 'running', ?)`,
  ).run(
    "log-desktop-running-existing",
    "run-desktop-running-existing",
    JSON.stringify([{ type: "text", text: "Desktop running event", ts: now - 4_000 }]),
    now - 4_000,
  );
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, mode, agent_name, worker_pid, status, started_at, ended_at, exit_code, error_text)
     VALUES (?, ?, 'execute', 'regression-agent', NULL, 'error', ?, ?, 1, ?)`,
  ).run(
    "run-desktop-error-existing",
    desktopErroredTaskId,
    now - 14_000,
    now - 11_000,
    "Seeded desktop failure",
  );
  db.close();

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
  const commanderFont = await page.locator(".commander").evaluate((node) => getComputedStyle(node).fontFamily);
  expect(commanderFont).toContain("Manrope");
});

test("desktop task list keeps every task state legible without clipped controls", async ({ page }) => {
  const viewports = [
    { width: 1440, height: 900, label: "desktop-1440" },
    { width: 1024, height: 768, label: "laptop-1024" },
  ];
  const stateRows = [
    { title: "Desktop ready task", text: "Execute" },
    { title: "Desktop needs owner task", text: "Needs owner" },
    { title: "Desktop review task", text: "Review" },
    { title: "Desktop done task", text: "Done" },
    { title: "Desktop blocked task", text: "Blocked by 1" },
    { title: "Desktop running task", text: "Running" },
    { title: "Desktop running task", text: "Desktop running event" },
    { title: "Desktop errored task", text: "Error" },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/#/tasks`);
    await expect(page.locator(".commander-row").first()).toBeVisible();

    for (const label of ["Review", "Execute", "Blocked", "Done"]) {
      await expect(page.locator(".commander-group-header", { hasText: label })).toBeVisible();
    }
    for (const row of stateRows) {
      await expect(page.locator(".commander-row", { hasText: row.title })).toContainText(row.text);
    }

    const stateDotMetrics = await page.evaluate(() => {
      const cells = [...document.querySelectorAll(".commander-row .commander-cell-state")];
      const dots = [...document.querySelectorAll(".commander-state-dot, .commander-cell-state .live-pulse")];
      return {
        visibleCells: cells.filter((cell) => getComputedStyle(cell).display !== "none").length,
        dotCount: dots.length,
        minDotSize: Math.min(...dots.map((dot) => Math.round(dot.getBoundingClientRect().width))),
      };
    });
    expect(stateDotMetrics.visibleCells).toBeGreaterThanOrEqual(stateRows.length);
    expect(stateDotMetrics.dotCount).toBeGreaterThanOrEqual(stateRows.length);
    expect(stateDotMetrics.minDotSize).toBeGreaterThanOrEqual(7);

    await expectNoHorizontalOverflow(page, `${viewport.label} task list states`);
    await expectNoCriticalHorizontalClipping(
      page,
      [
        ".commander-group-header",
        ".commander-title",
        ".status-pill-label",
        ".blocked-chip",
        ".chip",
        ".commander-cell-age",
        ".tab",
        ".app-header .button",
      ].join(", "),
      `${viewport.label} task list states`,
    );

    const metrics = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".commander-row")]
        .map((row) => Math.round(row.getBoundingClientRect().height));
      return {
        rowCount: rows.length,
        rowHeightMin: Math.min(...rows),
        rowHeightMax: Math.max(...rows),
      };
    });
    expect(metrics.rowCount).toBeGreaterThanOrEqual(stateRows.length);
    expect(metrics.rowHeightMin).toBeGreaterThanOrEqual(44);
    expect(metrics.rowHeightMax).toBeLessThanOrEqual(72);
  }
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

test("creating a task is single-save and does not show a false unsaved warning", async ({ page }) => {
  const title = `Create once ${Date.now()}`;
  await page.goto(`${baseUrl}/#/tasks/new`);
  await page.locator('input[placeholder*="actionable"]').fill(title);
  await page.locator(".task-edit-toolbar .button", { hasText: "Create task" }).evaluate((button) => {
    button.click();
    button.click();
    button.click();
  });

  await expect(page).toHaveURL(/#\/tasks\/[a-zA-Z0-9]+/);
  await expect(page.locator(".task-hero-title", { hasText: title })).toBeVisible();
  await expect(page.locator(".modal", { hasText: "unsaved" })).toHaveCount(0);

  const { tasks } = await requestJson("/api/tasks");
  expect(tasks.filter((task) => task.title === title)).toHaveLength(1);
});

test("task detail renders two-column layout", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-hero-title", { hasText: "UI regression task" })).toBeVisible();
  await expect(page.locator(".task-detail-rail")).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Agents" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Context" })).toBeVisible();
});

test("task detail polish keeps details, agent picker, and newest-first comments clear", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-detail-tile")).toHaveCount(0);
  await expect(page.locator(".task-context-row")).toHaveCount(4);
  await expect(page.locator(".task-context-row", { hasText: "Completed" })).toHaveCount(0);
  await expect(page.locator(".task-context-row", { hasText: "Run mode" })).toBeVisible();
  await expect(page.locator(".task-context-row", { hasText: "Next scheduled run" })).toBeVisible();
  await expect(page.locator(".task-detail-rail")).not.toContainText("Not done");
  await expect(page.locator(".rail-agent-picker .select-trigger")).toHaveCount(2);
  await expect(page.locator(".rail-agent-picker .select-trigger").first()).toContainText("Regression Agent");
  await expect(page.locator(".activity-composer")).toBeVisible();
  await expect(page.locator(".activity-feed .activity-item").first()).toContainText("Newest seeded comment");
  await expect(page.locator(".run-summary-metrics").first()).toBeVisible();
  await expect(page.locator(".activity-feed-entry")).toHaveCount(3);

  const order = await page.evaluate(() => {
    const composer = document.querySelector(".activity-composer");
    const feed = document.querySelector(".activity-feed");
    return composer && feed
      ? composer.getBoundingClientRect().top < feed.getBoundingClientRect().top
      : false;
  });
  expect(order).toBe(true);

  const fontFamily = await page.locator(".task-detail").evaluate((node) => getComputedStyle(node).fontFamily);
  expect(fontFamily).toContain("Manrope");

  await page.locator(".activity-composer textarea").fill("Fresh comment from regression test.");
  await page.locator(".activity-composer button", { hasText: "Post" }).click();
  await expect(page.locator(".activity-feed .activity-item").first()).toContainText("Fresh comment from regression test.");
});

test("desktop task detail states keep actions and context obvious without clipped controls", async ({ page }) => {
  const viewports = [
    { width: 1440, height: 900, label: "desktop-1440" },
    { width: 1024, height: 768, label: "laptop-1024" },
  ];
  const states = [
    {
      label: "ready",
      id: desktopReadyTaskId,
      title: "Desktop ready task",
      status: "Execute",
      actions: [{ label: "Run work", enabled: true }],
    },
    {
      label: "needs-owner",
      id: desktopNeedsOwnerTaskId,
      title: "Desktop needs owner task",
      status: "Plan",
      actions: [{ label: "Run plan", enabled: false }],
    },
    {
      label: "review",
      id: desktopReviewTaskId,
      title: "Desktop review task",
      status: "Review",
      actions: [
        { label: "Run review", enabled: true },
        { label: "Approve", enabled: true },
        { label: "Request changes", enabled: true },
      ],
    },
    {
      label: "done",
      id: desktopDoneTaskId,
      title: "Desktop done task",
      status: "Done",
      actions: [{ label: "Reopen", enabled: true }],
      contextText: "Completed",
    },
    {
      label: "blocked",
      id: desktopBlockedTaskId,
      title: "Desktop blocked task",
      status: "Execute",
      actions: [{ label: "Run work", enabled: false }],
      contextText: "Dependencies",
    },
    {
      label: "running",
      id: desktopRunningTaskId,
      title: "Desktop running task",
      status: "Running",
      actions: [{ label: "Cancel", enabled: true }],
      contextText: "Desktop running event",
    },
    {
      label: "error",
      id: desktopErroredTaskId,
      title: "Desktop errored task",
      status: "Execute",
      actions: [{ label: "Run work", enabled: true }],
      contextText: "Error",
    },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const state of states) {
      await page.goto(`${baseUrl}/#/tasks/${state.id}`);
      await expect(page.locator(".task-hero-title", { hasText: state.title })).toBeVisible();
      await expect(page.locator(".status-menu-trigger")).toContainText(state.status);
      await expect(page.locator(".card-title", { hasText: "Activity" })).toBeVisible();
      await expect(page.locator(".card-title", { hasText: "Agents" })).toBeVisible();
      await expect(page.locator(".card-title", { hasText: "Context" })).toBeVisible();
      await expect(page.locator(".task-detail-rail")).not.toContainText("Not done");

      for (const action of state.actions) {
        const button = page.locator(".app-header .button", { hasText: action.label }).first();
        await expect(button).toBeVisible();
        if (action.enabled) await expect(button).toBeEnabled();
        else await expect(button).toBeDisabled();
      }
      if (state.contextText) await expect(page.locator(".task-detail")).toContainText(state.contextText);

      const columnCount = await page.locator(".task-detail").evaluate((node) => {
        return getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length;
      });
      expect(columnCount, `${viewport.label} ${state.label} should stay two-column`).toBe(2);
      await expectNoHorizontalOverflow(page, `${viewport.label} task detail ${state.label}`);
      await expectNoCriticalHorizontalClipping(
        page,
        [
          ".task-hero-status-row .status-pill-label",
          ".task-hero-status-row .chip",
          ".app-header .button",
          ".activity-composer-actions .button",
          ".card-title",
          ".task-context-label",
          ".task-context-value",
          ".rail-agent-picker .select-trigger",
          ".blocked-link .status-pill-label",
          ".run-summary-title",
          ".run-metric-label",
          ".run-metric-value",
        ].join(", "),
        `${viewport.label} task detail ${state.label}`,
      );
    }
  }
});

test("task detail context shows completion and run mode", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${completedTaskId}`);
  await expect(page.locator(".task-context-row", { hasText: "Completed" })).toBeVisible();
  await expect(page.locator(".task-context-row", { hasText: "Run mode" })).toBeVisible();
});

test("task detail shows linked dependencies when the graph exists", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${blockedTaskId}`);
  await expect(page.locator(".card-title", { hasText: "Dependencies" })).toBeVisible();
  await expect(page.locator(".blocked-link", { hasText: "Dependency blocker" })).toBeVisible();
});

test("task detail live panel hydrates existing run events", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${runningTaskId}`);
  await expect(page.locator(".task-live-panel", { hasText: "Existing streamed event" })).toBeVisible();
  await expect(page.locator(".task-live-events")).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Activity" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Live run" })).toHaveCount(0);

  const bottomPadding = await page.locator(".task-live-events").evaluate((node) => {
    return parseFloat(getComputedStyle(node).paddingBottom);
  });
  expect(bottomPadding).toBeGreaterThan(0);
});

test("task detail deep-linked run opens highlighted history", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}?run=run-complete-existing`);
  const run = page.locator(".run-card.highlighted").first();
  await expect(run).toBeVisible();
  await expect(run.locator(".run-card-events")).toBeVisible();
  await expect(run).toContainText("Completed seeded run");
});

test("task detail mounts the automations card with scheduled markers", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-hero-status-row .chip", { hasText: "Scheduled" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Automations" })).toBeVisible();
  await expect(page.locator(".task-automation-row", { hasText: "Daily" })).toBeVisible();
});

test("destructive pane actions stay behind disclosure", async ({ page }) => {
	  for (const hash of [
	    "#/agents/regression-agent",
	    "#/knowledge/welcome",
	    `#/providers/${providerId}`,
	    `#/skills/${skillName}`,
	  ]) {
    await page.goto(`${baseUrl}/${hash}`);
    await expect(page.locator(".pane-detail-head")).toBeVisible();
    await expect(page.locator(".pane-detail-head .button.destructive")).toHaveCount(0);
    const disclosure = page.locator(".card-collapsible").filter({ hasText: "More actions" }).first();
    await expect(disclosure.locator(".card-collapsible-summary")).toBeVisible();
    await expect(disclosure.locator(".button.destructive").first()).toBeHidden();
    await disclosure.locator(".card-collapsible-summary").click();
    await expect(disclosure.locator(".button.destructive").first()).toBeVisible();
  }
});

test("agents skills and knowledge panes keep polished rows and detail headers legible", async ({ page }) => {
  const routes = [
    {
      hash: "#/agents/regression-agent",
      title: "Regression Agent",
      rowText: "Regression Agent",
      detailText: "regression-agent",
    },
    {
      hash: `#/skills/${skillName}`,
      title: "Regression Skill",
      rowText: "Regression Skill",
      detailText: "On demand",
    },
    {
      hash: "#/knowledge/mobile-layout-reference",
      title: "Mobile layout reference",
      rowText: "Mobile layout reference",
      detailText: "mobile-layout-reference",
    },
  ];

  for (const viewport of [
    { width: 1440, height: 900, label: "desktop-1440" },
    { width: 1024, height: 768, label: "laptop-1024" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of routes) {
      await page.goto(`${baseUrl}/${route.hash}`);
      await expect(page.locator(".pane-detail-head h2", { hasText: route.title })).toBeVisible();
      await expect(page.locator(".pane-detail-subline", { hasText: route.detailText })).toBeVisible();
      await expect(page.locator(".pane-row.active", { hasText: route.rowText })).toBeVisible();
      await expect(page.locator(".pane-detail-body > .form-section").first()).toBeVisible();

      const paneMetrics = await page.evaluate(() => {
        const row = document.querySelector(".pane-row.active");
        const detailHead = document.querySelector(".pane-detail-head");
        const body = document.querySelector(".pane-detail-body");
        const list = document.querySelector(".pane-list");
        return {
          rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
          headHeight: detailHead ? Math.round(detailHead.getBoundingClientRect().height) : 0,
          bodyWidth: body ? Math.round(body.getBoundingClientRect().width) : 0,
          listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0,
        };
      });
      expect(paneMetrics.rowHeight, `${viewport.label} ${route.hash} row height`).toBeGreaterThanOrEqual(56);
      expect(paneMetrics.headHeight, `${viewport.label} ${route.hash} head height`).toBeGreaterThanOrEqual(68);
      expect(paneMetrics.bodyWidth, `${viewport.label} ${route.hash} body width`).toBeGreaterThan(0);
      expect(paneMetrics.listWidth, `${viewport.label} ${route.hash} list width`).toBeGreaterThanOrEqual(300);

      await expectNoHorizontalOverflow(page, `${viewport.label} ${route.hash} polished panes`);
      await expectNoCriticalHorizontalClipping(
        page,
        [
          ".pane-detail-head h2",
          ".pane-detail-subline",
          ".pane-detail-head .button",
          ".pane-list-head .button",
          ".pane-row-title",
          ".pane-row-meta",
          ".kb-category-badge",
          ".chip",
        ].join(", "),
        `${viewport.label} ${route.hash} polished panes`,
      );
    }
  }
});

test("mobile agents skills and knowledge panes preserve compact premium detail structure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    { hash: "#/agents/regression-agent", title: "Regression Agent", back: "All agents" },
    { hash: `#/skills/${skillName}`, title: "Regression Skill", back: "All skills" },
    { hash: "#/knowledge/mobile-layout-reference", title: "Mobile layout reference", back: "All entries" },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(page.locator(".pane-mobile-back .button", { hasText: route.back })).toBeVisible();
    await expect(page.locator(".pane-detail-head h2", { hasText: route.title })).toBeVisible();
    await expect(page.locator(".pane-detail-subline")).toBeVisible();
    await expect(page.locator(".pane-detail-body > .form-section").first()).toBeVisible();

    const mobileMetrics = await page.evaluate(() => {
      const head = document.querySelector(".pane-detail-head");
      const toolbar = document.querySelector(".pane-detail-head .toolbar");
      const formSection = document.querySelector(".pane-detail-body > .form-section");
      const icon = document.querySelector(".pane-detail-icon, .agent-avatar");
      return {
        headWidth: head ? Math.round(head.getBoundingClientRect().width) : 0,
        toolbarTop: toolbar ? Math.round(toolbar.getBoundingClientRect().top) : 0,
        headTop: head ? Math.round(head.getBoundingClientRect().top) : 0,
        sectionRadius: formSection ? parseFloat(getComputedStyle(formSection).borderRadius) : 0,
        iconWidth: icon ? Math.round(icon.getBoundingClientRect().width) : 0,
      };
    });
    expect(mobileMetrics.headWidth).toBeLessThanOrEqual(390);
    expect(mobileMetrics.toolbarTop).toBeGreaterThanOrEqual(mobileMetrics.headTop);
    expect(mobileMetrics.sectionRadius).toBeGreaterThanOrEqual(6);
    expect(mobileMetrics.iconWidth).toBeGreaterThanOrEqual(28);

    await expectNoHorizontalOverflow(page, `mobile polished pane ${route.hash}`);
    await expectNoCriticalHorizontalClipping(
      page,
      [
        ".pane-mobile-back .button",
        ".pane-detail-head h2",
        ".pane-detail-subline",
        ".pane-detail-head .button",
        ".form-section-title",
        ".form-field-label",
        ".kb-category-badge",
        ".chip",
      ].join(", "),
      `mobile polished pane ${route.hash}`,
    );
  }
});

// Responsive breakpoints from ui-design-system.md §7.5. Spec mandates no
// horizontal overflow on any route at any of these four widths.
const RESPONSIVE_VIEWPORTS = [
  { w: 360,  h: 800,  label: "mobile-360" },
  { w: 390,  h: 844,  label: "mobile-390" },
  { w: 430,  h: 932,  label: "mobile-430" },
  { w: 768,  h: 1024, label: "tablet-768" },
  { w: 860,  h: 900,  label: "tablet-860" },
  { w: 1024, h: 768,  label: "laptop-1024" },
  { w: 1440, h: 900,  label: "desktop-1440" },
];

function responsiveRoutes(page, ids) {
  const { taskId, providerId, skillName } = ids;
  return [
    { hash: "#/tasks", ready: () => page.locator(".commander-row").first() },
    { hash: `#/tasks/${taskId}`, ready: () => page.locator(".task-hero-title", { hasText: "UI regression task" }) },
    { hash: "#/tasks/new", ready: () => page.locator(".task-edit-head").first() },
    { hash: "#/agents", ready: () => page.locator('h1.app-title', { hasText: "Agents" }) },
    { hash: "#/agents/regression-agent", ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Agent" }) },
    { hash: "#/agents/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New agent" }) },
    { hash: "#/skills", ready: () => page.locator('h1.app-title', { hasText: "Skills" }) },
    { hash: `#/skills/${skillName}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Skill" }) },
    { hash: "#/skills/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New skill" }) },
    { hash: "#/knowledge", ready: () => page.locator('h1.app-title', { hasText: "Knowledge" }) },
    { hash: "#/knowledge/welcome", ready: () => page.locator(".pane-detail-head h2", { hasText: "Welcome guide" }) },
    { hash: "#/knowledge/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New entry" }) },
    { hash: "#/providers", ready: () => page.locator('h1.app-title', { hasText: "Providers" }) },
    { hash: `#/providers/${providerId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression provider" }) },
    { hash: "#/providers/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New provider" }) },
    { hash: "#/activity", ready: () => page.locator('h1.app-title', { hasText: "Activity" }) },
    { hash: "#/settings", ready: () => page.locator('h1.app-title', { hasText: "Settings" }) },
  ];
}

for (const vp of RESPONSIVE_VIEWPORTS) {
  test(`no horizontal overflow at ${vp.label} (${vp.w}x${vp.h})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    const routes = responsiveRoutes(page, { taskId, providerId, skillName });
    for (const route of routes) {
      await page.goto("about:blank");
      await page.goto(`${baseUrl}/${route.hash}`);
      await expect(route.ready()).toBeVisible({ timeout: 5000 });
      await expectNoHorizontalOverflow(page, `${vp.label} ${route.hash}`);
    }
  });
}

test("mobile commander uses deliberate row density without exposing task ids", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();

  const metrics = await page.evaluate(() => {
    const row = document.querySelector(".commander-row");
    const id = row?.querySelector(".commander-cell-id");
    const state = row?.querySelector(".commander-cell-state");
    const filter = document.querySelector(".commander-filter");
    const pill = row?.querySelector(".status-pill");
    const navWidths = [...document.querySelectorAll(".app-nav a")]
      .map((entry) => Math.round(entry.getBoundingClientRect().width));
    const tabHeights = [...document.querySelectorAll(".commander-filter .tab")]
      .map((entry) => Math.round(entry.getBoundingClientRect().height));
    return {
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
      filterHeight: filter ? Math.round(filter.getBoundingClientRect().height) : 0,
      idDisplay: id ? getComputedStyle(id).display : "",
      stateDisplay: state ? getComputedStyle(state).display : "",
      pillVisible: pill ? getComputedStyle(pill).display !== "none" : false,
      navMinWidth: Math.min(...navWidths),
      tabMinHeight: Math.min(...tabHeights),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.idDisplay).toBe("none");
  expect(metrics.stateDisplay).toBe("none");
  expect(metrics.pillVisible).toBe(true);
  expect(metrics.rowHeight).toBeGreaterThanOrEqual(60);
  expect(metrics.rowHeight).toBeLessThanOrEqual(88);
  expect(metrics.filterHeight).toBeLessThanOrEqual(92);
  expect(metrics.navMinWidth).toBeGreaterThanOrEqual(44);
  expect(metrics.tabMinHeight).toBeGreaterThanOrEqual(44);
});

test("mobile task detail keeps activity first with a compact premium composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-hero-title", { hasText: "UI regression task" })).toBeVisible();

  const beforeFocus = await page.evaluate(() => {
    const activity = document.querySelector(".activity-card");
    const agents = document.querySelector(".rail-agents-card");
    const context = document.querySelector(".task-context-card");
    const composer = document.querySelector(".activity-composer-form");
    const input = document.querySelector(".activity-composer-input");
    const shortcut = document.querySelector(".activity-composer-shortcut");
    const dock = document.querySelector(".app-mobile-action-dock");
    const headerToolbar = document.querySelector(".app-header > .toolbar");
    const nav = document.querySelector(".app-rail");
    const rail = document.querySelector(".activity-feed-entry:not(:last-child) .activity-feed-rail");
    const dot = document.querySelector(".activity-feed-dot:not(.avatar)") || document.querySelector(".activity-feed-dot");
    const line = rail ? getComputedStyle(rail, "::after") : null;
    return {
      activityBeforeAgents: activity && agents
        ? activity.getBoundingClientRect().top < agents.getBoundingClientRect().top
        : false,
      activityBeforeContext: activity && context
        ? activity.getBoundingClientRect().top < context.getBoundingClientRect().top
        : false,
      activityBorder: activity ? parseFloat(getComputedStyle(activity).borderTopWidth) : -1,
      composerHeight: composer ? Math.round(composer.getBoundingClientRect().height) : 0,
      inputHeight: input ? Math.round(input.getBoundingClientRect().height) : 0,
      shortcutDisplay: shortcut ? getComputedStyle(shortcut).display : "",
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      dockMinButtonHeight: dock
        ? Math.min(...[...dock.querySelectorAll(".button")].map((button) => Math.round(button.getBoundingClientRect().height)))
        : 0,
      dockBottomBeforeNav: dock && nav
        ? Math.round(dock.getBoundingClientRect().bottom) <= Math.round(nav.getBoundingClientRect().top) + 1
        : false,
      headerToolbarDisplay: headerToolbar ? getComputedStyle(headerToolbar).display : "",
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      dotWidth: dot ? Math.round(parseFloat(getComputedStyle(dot).getPropertyValue("--activity-dot-size")) || dot.getBoundingClientRect().width) : 0,
      lineWidth: line ? Math.round(parseFloat(line.width)) : 0,
    };
  });

  expect(beforeFocus.activityBeforeAgents).toBe(true);
  expect(beforeFocus.activityBeforeContext).toBe(true);
  expect(beforeFocus.activityBorder).toBe(0);
  expect(beforeFocus.composerHeight).toBeLessThanOrEqual(64);
  expect(beforeFocus.inputHeight).toBeLessThanOrEqual(48);
  expect(beforeFocus.shortcutDisplay).toBe("none");
  expect(beforeFocus.dockDisplay).toBe("flex");
  expect(beforeFocus.dockMinButtonHeight).toBeGreaterThanOrEqual(44);
  expect(beforeFocus.dockBottomBeforeNav).toBe(true);
  expect(beforeFocus.headerToolbarDisplay).toBe("none");
  expect(beforeFocus.railWidth).toBeLessThanOrEqual(24);
  expect(beforeFocus.dotWidth).toBeLessThanOrEqual(20);
  expect(beforeFocus.lineWidth).toBe(1);

  await page.locator(".activity-composer textarea").focus();
  const afterFocus = await page.evaluate(() => {
    const input = document.querySelector(".activity-composer-input");
    const rail = document.querySelector(".app-rail");
    const dock = document.querySelector(".app-mobile-action-dock");
    return {
      inputHeight: input ? Math.round(input.getBoundingClientRect().height) : 0,
      railTransform: rail ? getComputedStyle(rail).transform : "",
      dockTransform: dock ? getComputedStyle(dock).transform : "",
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(afterFocus.inputHeight).toBeGreaterThanOrEqual(84);
  expect(afterFocus.railTransform).not.toBe("none");
  expect(afterFocus.dockTransform).not.toBe("none");
  expect(afterFocus.overflow).toBeLessThanOrEqual(0);
});

test("mobile task edit uses compact header and sticky action dock", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`${baseUrl}/#/tasks/${taskId}/edit`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();
  await expect(page.locator(".app-mobile-action-dock .button", { hasText: "Save" })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const editHead = document.querySelector(".task-edit-head");
    const toolbar = document.querySelector(".task-edit-toolbar");
    const dock = document.querySelector(".app-mobile-action-dock");
    const nav = document.querySelector(".app-rail");
    const grid = document.querySelector(".task-edit-grid");
    const rail = document.querySelector(".task-edit-rail");
    const statusButtons = [...document.querySelectorAll(".status-grid-btn")];
    const dockButtons = [...document.querySelectorAll(".app-mobile-action-dock .button")];
    const body = document.querySelector(".task-edit-body");
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      editHeadHeight: editHead ? Math.round(editHead.getBoundingClientRect().height) : 0,
      toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : "",
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      dockMinButtonHeight: Math.min(...dockButtons.map((button) => Math.round(button.getBoundingClientRect().height))),
      dockBottomBeforeNav: dock && nav
        ? Math.round(dock.getBoundingClientRect().bottom) <= Math.round(nav.getBoundingClientRect().top) + 1
        : false,
      gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      railPosition: rail ? getComputedStyle(rail).position : "",
      statusMinHeight: Math.min(...statusButtons.map((button) => Math.round(button.getBoundingClientRect().height))),
      bodyPaddingBottom: body ? Math.round(parseFloat(getComputedStyle(body).paddingBottom)) : 0,
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.editHeadHeight).toBeLessThanOrEqual(72);
  expect(metrics.toolbarDisplay).toBe("none");
  expect(metrics.dockDisplay).toBe("flex");
  expect(metrics.dockMinButtonHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.dockBottomBeforeNav).toBe(true);
  expect(metrics.gridColumns).toBe(1);
  expect(metrics.railPosition).toBe("static");
  expect(metrics.statusMinHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.bodyPaddingBottom).toBeGreaterThanOrEqual(120);
  await expectNoHorizontalOverflow(page, "mobile task edit action dock");
});

test("mobile create editors keep headers, actions, and forms usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    { hash: "#/agents/new", title: "New agent", back: "All agents" },
    { hash: "#/skills/new", title: "New skill", back: "All skills" },
    { hash: "#/knowledge/new", title: "New entry", back: "All entries" },
    { hash: "#/providers/new", title: "New provider", back: "All providers" },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(page.locator(".pane-mobile-back .button", { hasText: route.back })).toBeVisible();
    await expect(page.locator(".pane-detail-head h2", { hasText: route.title })).toBeVisible();
    await expect(page.locator(".pane-detail-head .toolbar .button").first()).toBeVisible();
    await expect(page.locator(".pane-detail-body > .form-section").first()).toBeVisible();

    const metrics = await page.evaluate(() => {
      const head = document.querySelector(".pane-detail-head");
      const toolbar = document.querySelector(".pane-detail-head .toolbar");
      const buttons = [...document.querySelectorAll(".pane-detail-head .toolbar .button")];
      const sections = [...document.querySelectorAll(".pane-detail-body > .form-section")];
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        headWidth: head ? Math.round(head.getBoundingClientRect().width) : 0,
        toolbarWidth: toolbar ? Math.round(toolbar.getBoundingClientRect().width) : 0,
        minButtonHeight: buttons.length
          ? Math.min(...buttons.map((button) => Math.round(button.getBoundingClientRect().height)))
          : 0,
        sectionCount: sections.length,
        minSectionWidth: sections.length
          ? Math.min(...sections.map((section) => Math.round(section.getBoundingClientRect().width)))
          : 0,
      };
    });
    expect(metrics.overflow, `${route.hash} overflow`).toBeLessThanOrEqual(0);
    expect(metrics.headWidth, `${route.hash} head width`).toBeLessThanOrEqual(390);
    expect(metrics.toolbarWidth, `${route.hash} toolbar width`).toBeLessThanOrEqual(390);
    expect(metrics.minButtonHeight, `${route.hash} button height`).toBeGreaterThanOrEqual(44);
    expect(metrics.sectionCount, `${route.hash} sections`).toBeGreaterThan(0);
    expect(metrics.minSectionWidth, `${route.hash} section width`).toBeGreaterThan(0);

    await expectNoHorizontalOverflow(page, `mobile create editor ${route.hash}`);
    await expectNoCriticalHorizontalClipping(
      page,
      [
        ".pane-mobile-back .button",
        ".pane-detail-head h2",
        ".pane-detail-subline",
        ".pane-detail-head .button",
        ".form-section-title",
        ".form-field-label",
        ".kb-category-badge",
        ".chip",
      ].join(", "),
      `mobile create editor ${route.hash}`,
    );
  }
});

test("mobile activity screen uses stacked readable rows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/activity`);
  await expect(page.locator(".activity-row").first()).toBeVisible();

  const metrics = await page.evaluate(() => {
    const filters = document.querySelector(".activity-filters");
    const row = document.querySelector(".activity-row");
    const status = row?.querySelector(".status-pill");
    const time = row?.querySelector(".activity-time");
    const tiles = [...document.querySelectorAll(".summary-tiles .metric")];
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      filterColumns: filters ? getComputedStyle(filters).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      rowColumns: row ? getComputedStyle(row).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      rowWidth: row ? Math.round(row.getBoundingClientRect().width) : 0,
      rowRadius: row ? parseFloat(getComputedStyle(row).borderRadius) : 0,
      statusColumn: status ? getComputedStyle(status).gridColumnStart : "",
      timeColumn: time ? getComputedStyle(time).gridColumnStart : "",
      tileCount: tiles.length,
      tileColumns: tiles.length
        ? getComputedStyle(tiles[0].parentElement).gridTemplateColumns.split(" ").filter(Boolean).length
        : 0,
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.filterColumns).toBe(1);
  expect(metrics.rowColumns).toBe(2);
  expect(metrics.rowWidth).toBeLessThanOrEqual(390);
  expect(metrics.rowRadius).toBeGreaterThanOrEqual(6);
  expect(metrics.statusColumn).toBe("2");
  expect(metrics.timeColumn).toBe("2");
  expect(metrics.tileCount).toBe(3);
  expect(metrics.tileColumns).toBe(3);
  await expectNoHorizontalOverflow(page, "mobile activity rows");
  await expectNoCriticalHorizontalClipping(
    page,
    [
      ".summary-tiles .metric .label",
      ".summary-tiles .metric .value",
      ".activity-title",
      ".activity-meta",
      ".activity-time",
      ".status-pill-label",
    ].join(", "),
    "mobile activity rows",
  );
});

test("mobile overlays keep drawer and modal controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.locator(".drawer", { hasText: "Keyboard shortcuts" })).toBeVisible();

  const drawerMetrics = await page.evaluate(() => {
    const drawer = document.querySelector(".drawer");
    const body = document.querySelector(".drawer-body");
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      width: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
      bodyPaddingBottom: body ? Math.round(parseFloat(getComputedStyle(body).paddingBottom)) : 0,
    };
  });
  expect(drawerMetrics.overflow).toBeLessThanOrEqual(0);
  expect(drawerMetrics.width).toBeLessThanOrEqual(390);
  expect(drawerMetrics.bodyPaddingBottom).toBeGreaterThan(0);
  await expectNoCriticalHorizontalClipping(
    page,
    [".drawer-head h2", ".kbd-help-keys", ".kbd-help-label"].join(", "),
    "mobile keyboard drawer",
  );

  await page.keyboard.press("Escape");
  await expect(page.locator(".drawer")).toHaveCount(0);

  await page.goto(`${baseUrl}/#/tasks/${taskId}/edit`);
  await page.locator('input[placeholder*="actionable"]').fill("UI regression task with unsaved mobile edit");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal", { hasText: "You have unsaved changes" })).toBeVisible();

  const modalMetrics = await page.evaluate(() => {
    const modal = document.querySelector(".modal");
    const footer = document.querySelector(".modal-foot");
    const buttons = [...document.querySelectorAll(".modal-foot .button")];
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      width: modal ? Math.round(modal.getBoundingClientRect().width) : 0,
      footerDisplay: footer ? getComputedStyle(footer).display : "",
      minButtonHeight: buttons.length
        ? Math.min(...buttons.map((button) => Math.round(button.getBoundingClientRect().height)))
        : 0,
      maxButtonWidth: buttons.length
        ? Math.max(...buttons.map((button) => Math.round(button.getBoundingClientRect().width)))
        : 0,
    };
  });
  expect(modalMetrics.overflow).toBeLessThanOrEqual(0);
  expect(modalMetrics.width).toBeLessThanOrEqual(390);
  expect(modalMetrics.footerDisplay).toBe("grid");
  expect(modalMetrics.minButtonHeight).toBeGreaterThanOrEqual(44);
  expect(modalMetrics.maxButtonWidth).toBeLessThanOrEqual(390);
  await expectNoCriticalHorizontalClipping(
    page,
    [".modal-head h2", ".modal-body", ".modal-foot .button"].join(", "),
    "mobile unsaved modal",
  );
});

test("pressing N opens new-task form from the commander", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks`);
  await page.locator(".commander-row").first().waitFor();
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#\/tasks\/new/);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();
});

test("provider creation uses a simple mobile provider-type select", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/providers/new`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "New provider" })).toBeVisible();
  await expect(page.locator(".provider-type-segmented")).toBeHidden();
  await expect(page.locator(".provider-type-select select")).toBeVisible();
  await expectNoHorizontalOverflow(page, "mobile provider new");
});
