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
  seedDb.prepare(
    `INSERT OR IGNORE INTO agents
      (name, display_name, sdk, model, created_at, updated_at)
     VALUES (?, ?, 'codex', 'test-model', ?, ?)`,
  ).run("planner-agent", "Planner Agent", agentSeededAt, agentSeededAt);
  seedDb.close();

  taskId = await createTask("UI regression task", {
    owner_agent: "regression-agent",
    reviewer_agent: "reviewer-agent",
    stage: "execute",
    run_policy: "manual",
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
    planner_agent: "planner-agent",
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
    `INSERT INTO task_comments
      (id, task_id, author_type, author_id, body, created_at)
     VALUES (?, ?, 'system', NULL, ?, ?)`,
  ).run("comment-system-existing", taskId, "System seeded comment", now - 15_000);
  const completeRunResult = {
    schema: "worklab.v2",
    stage: "execute",
    decision: "advance",
    summary: "Implemented regression run summary.",
    details: "Changed seeded data and verified the summary card layout.",
  };
  db.prepare(
    `INSERT INTO task_runs
      (id, task_id, mode, agent_name, worker_pid, status, started_at, ended_at,
       exit_code, error_text, decision, summary, details, result_json)
     VALUES (?, ?, 'execute', 'regression-agent', NULL, 'complete', ?, ?,
       0, NULL, ?, ?, ?, ?)`,
  ).run(
    "run-complete-existing",
    taskId,
    now - 18_000,
    now - 12_000,
    completeRunResult.decision,
    completeRunResult.summary,
    completeRunResult.details,
    JSON.stringify(completeRunResult),
  );
  db.prepare(
    `INSERT INTO agent_logs
      (id, task_run_id, events, model, effort, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, num_turns, status, created_at)
     VALUES (?, ?, ?, 'test-model', 'medium', 1200, 800, 0, 0, 0.0123, 6000, 3, 'complete', ?)`,
  ).run(
    "log-complete-existing",
    "run-complete-existing",
    JSON.stringify([
      { type: "text", text: "Completed seeded run", ts: now - 12_000 },
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "file-seed",
            name: "file_edit",
            input: {
              status: "in_progress",
              changes: [{ path: "src/ui/TaskDetail.jsx", kind: "update" }],
            },
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "file-seed",
            content: {
              status: "completed",
              changes: [{
                path: "src/ui/TaskDetail.jsx",
                kind: "update",
                line_stats: {
                  before_lines: 100,
                  after_lines: 108,
                  added_lines: 10,
                  removed_lines: 2,
                  changed_lines: 12,
                },
              }],
              summary: { files: 1, added_lines: 10, removed_lines: 2, changed_lines: 12, unavailable_count: 0 },
            },
            is_error: false,
          }],
        },
      },
    ]),
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
    JSON.stringify([
      { type: "text", text: "Existing streamed event", ts: now - 5_000 },
      { type: "tool_use", tool_use_id: "tool-live-existing", name: "shell", input: { cmd: "npm test" } },
    ]),
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

    for (const label of ["Review", "Execute", "Done"]) {
      await expect(page.locator(".commander-group-header", { hasText: label })).toBeVisible();
    }
    for (const row of stateRows) {
      await expect(page.locator(".commander-row", { hasText: row.title })).toContainText(row.text);
    }

    const rowLayoutMetrics = await page.evaluate(() => {
      const reviewRow = [...document.querySelectorAll(".commander-row")]
        .find((row) => row.textContent?.includes("Desktop review task"));
      const cells = [...document.querySelectorAll(".commander-row .commander-cell-state")];
      const assignees = reviewRow?.querySelector(".commander-cell-assignees");
      const arrows = [...(assignees?.querySelectorAll(".commander-cell-arrow") || [])];
      const avatars = [...(assignees?.querySelectorAll(".agent-avatar") || [])];
      const assigneeRect = assignees?.getBoundingClientRect();
      const avatarBounds = avatars.map((avatar) => avatar.getBoundingClientRect());
      const stage = reviewRow?.querySelector(".commander-cell-pill .stage-token")?.getBoundingClientRect();
      const title = reviewRow?.querySelector(".commander-cell-title")?.getBoundingClientRect();
      return {
        visibleStateCells: cells.filter((cell) => getComputedStyle(cell).display !== "none").length,
        assigneeDisplay: assignees ? getComputedStyle(assignees).display : "",
        avatarCount: avatars.length,
        arrowCount: arrows.length,
        assigneeWidth: assigneeRect ? Math.round(assigneeRect.width) : 0,
        avatarLeft: avatarBounds.length ? Math.round(Math.min(...avatarBounds.map((rect) => rect.left))) : 0,
        avatarRight: avatarBounds.length ? Math.round(Math.max(...avatarBounds.map((rect) => rect.right))) : 0,
        stageLeft: stage ? Math.round(stage.left) : 0,
        titleRight: title ? Math.round(title.right) : 0,
      };
    });
    expect(rowLayoutMetrics.visibleStateCells).toBe(0);
    expect(rowLayoutMetrics.assigneeDisplay).toBe("flex");
    expect(rowLayoutMetrics.avatarCount).toBe(3);
    expect(rowLayoutMetrics.arrowCount).toBe(2);
    expect(rowLayoutMetrics.assigneeWidth).toBeGreaterThanOrEqual(84);
    expect(rowLayoutMetrics.avatarLeft).toBeGreaterThanOrEqual(rowLayoutMetrics.titleRight);
    expect(rowLayoutMetrics.avatarRight).toBeLessThanOrEqual(rowLayoutMetrics.stageLeft);

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
        ".commander-filter .button",
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
    expect(metrics.rowHeightMax).toBeLessThanOrEqual(88);
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

test("agent profile availability stays inline after identity fields", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/#/agents/new`);
  await expect(page.locator(".agent-profile-grid")).toBeVisible();

  const fields = await page.locator(".agent-profile-grid").evaluate((grid) => {
    return Array.from(grid.children).map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        text: (child.textContent || "").replace(/\s+/g, " ").trim(),
        left: Math.round(rect.left),
        bottom: Math.round(rect.bottom),
      };
    });
  });

  expect(fields).toHaveLength(3);
  expect(fields[0].text).toContain("Display name");
  expect(fields[1].text).toContain("Description");
  expect(fields[2].text).toContain("Available for assignment");
  expect(fields[0].left).toBeLessThan(fields[1].left);
  expect(fields[1].left).toBeLessThan(fields[2].left);
  expect(Math.abs(fields[0].bottom - fields[2].bottom)).toBeLessThanOrEqual(6);
});

test("task edit is reachable via #/tasks/new and shows a full-page form", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/#/tasks/new`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();
  await expect(page.locator('input[placeholder*="actionable"]')).toBeVisible();

  const metrics = await page.evaluate(() => {
    const body = document.querySelector(".task-edit-body");
    const grid = document.querySelector(".task-edit-grid");
    if (!body || !grid) return null;
    const bodyStyle = getComputedStyle(body);
    const gridStyle = getComputedStyle(grid);
    const bodyContentWidth = body.clientWidth
      - parseFloat(bodyStyle.paddingLeft)
      - parseFloat(bodyStyle.paddingRight);
    const columns = gridStyle.gridTemplateColumns.split(" ").filter(Boolean);
    return {
      bodyWidth: Math.round(body.getBoundingClientRect().width),
      bodyContentWidth: Math.round(bodyContentWidth),
      gridWidth: Math.round(grid.getBoundingClientRect().width),
      columnCount: columns.length,
      railWidth: Math.round(parseFloat(columns.at(-1) || "0")),
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics.bodyWidth).toBeLessThanOrEqual(1180);
  expect(Math.abs(metrics.gridWidth - metrics.bodyContentWidth)).toBeLessThanOrEqual(2);
  expect(metrics.columnCount).toBe(2);
  expect(metrics.railWidth).toBeGreaterThanOrEqual(300);
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
  await expect(page.locator(".task-detail-rail .card-title", { hasText: "Roles" })).toBeVisible();
  await expect(page.locator(".task-detail-rail .card-title", { hasText: "Metadata" })).toBeVisible();
  await expect(page.locator(".task-detail-rail .card-title", { hasText: "Maintenance" })).toBeVisible();
});

test("task detail polish keeps details, agent picker, and newest-first comments clear", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-detail-tile")).toHaveCount(0);
  await expect(page.locator(".task-context-row")).toHaveCount(4);
  await expect(page.locator(".task-context-row", { hasText: "Completed" })).toHaveCount(0);
  await expect(page.locator(".task-context-row", { hasText: "Run mode" })).toBeVisible();
  await expect(page.locator(".task-context-row", { hasText: "Next scheduled run" })).toBeVisible();
  await expect(page.locator(".task-detail-rail")).not.toContainText("Not done");
  await expect(page.locator(".task-metadata-card")).toContainText("Artifacts");
  await expect(page.locator(".task-metadata-card")).toContainText("TaskDetail.jsx");
  await expect(page.locator(".task-metadata-card")).toContainText("+10 -2");
  await expect(page.locator(".run-artifacts-card")).toHaveCount(0);
  await expect(page.locator(".rail-agent-picker .select-trigger")).toHaveCount(3);
  await expect(page.locator(".rail-agent-picker .select-trigger").first()).toContainText("Regression Agent");
  await expect(page.locator(".activity-composer")).toBeVisible();
  await expect(page.locator(".activity-rerun-checkbox input")).toBeChecked();
  await expect(page.locator(".activity-feed .activity-item").first()).toContainText("Newest seeded comment");
  await expect(page.locator(".run-summary-metrics").first()).toBeVisible();
  await expect(page.locator(".activity-feed-entry")).toHaveCount(4);
  const runCard = page.locator(".activity-feed-entry.run .run-card").first();
  await expect(runCard.locator(".run-result-decision")).toContainText("advance");
  await expect(runCard.locator(".run-result-summary")).toContainText("Implemented regression run summary.");
  await expect(runCard.locator(".run-result-details")).toContainText("Changed seeded data");
  await expect(runCard.locator(".run-summary-side .run-summary-time")).toBeVisible();
  await expect(runCard.locator(".run-summary-status .status-pill")).toHaveCount(0);
  await expect(runCard.locator(".run-summary-title")).toHaveCount(0);
  await expect(runCard.locator(".run-card-summary")).not.toContainText("Execute ·");
  await expect(page.locator(".activity-feed-entry.comment.system")).toContainText("System seeded comment");
  const systemDot = await page.locator(".activity-feed-entry.comment.system .activity-feed-dot").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      className: node.className,
      classList: [...node.classList],
      width: Math.round(node.getBoundingClientRect().width),
      height: Math.round(node.getBoundingClientRect().height),
      paddingTop: style.paddingTop,
      borderRadius: style.borderRadius,
    };
  });
  expect(systemDot.className).toContain("comment-dot");
  expect(systemDot.classList).not.toContain("comment");
  expect(systemDot.width).toBe(systemDot.height);
  expect(systemDot.width).toBeLessThanOrEqual(18);
  expect(systemDot.paddingTop).toBe("0px");
  expect(systemDot.borderRadius).toBe("50%");

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

  await page.locator(".activity-rerun-checkbox").click();
  await expect(page.locator(".activity-rerun-checkbox input")).not.toBeChecked();
  await page.locator(".activity-composer textarea").fill("Fresh comment from regression test.");
  await page.locator(".activity-composer button", { hasText: "Post" }).click();
  const freshComment = page.locator(".activity-feed-entry.comment.human", { hasText: "Fresh comment from regression test." });
  await expect(freshComment).toBeVisible();
  await expect(page.locator(".activity-feed .activity-item").first()).toContainText("Fresh comment from regression test.");
  await expect(page.locator(".activity-feed-entry.comment.system").getByLabel("Delete comment")).toHaveCount(0);
  const deleteButton = freshComment.getByLabel("Delete comment");
  await expect(deleteButton).toHaveCSS("opacity", "0");
  await expect(deleteButton).toHaveCSS("pointer-events", "none");
  await freshComment.hover();
  await expect(deleteButton).toHaveCSS("opacity", "0.72");
  await expect(deleteButton).toHaveCSS("pointer-events", "auto");
  await deleteButton.click();
  const deleteCommentModal = page.locator(".modal", { hasText: "Delete comment?" });
  await expect(deleteCommentModal).toBeVisible();
  await deleteCommentModal.getByRole("button", { name: "Delete" }).click();
  await expect(freshComment).toHaveCount(0);
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
      contextText: "Blocked by",
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
      await expect(page.locator(".task-detail-rail .card-title", { hasText: "Roles" })).toBeVisible();
      await expect(page.locator(".task-detail-rail .card-title", { hasText: "Metadata" })).toBeVisible();
      await expect(page.locator(".task-detail-rail .card-title", { hasText: "Maintenance" })).toBeVisible();
      await expect(page.locator(".task-detail-rail")).not.toContainText("Not done");

      for (const action of state.actions) {
        const button = page.locator(".task-hero-actions .button", { hasText: action.label }).first();
        await expect(button).toBeVisible();
        if (action.enabled) await expect(button).toBeEnabled();
        else await expect(button).toBeDisabled();
      }
      if (state.contextText) await expect(page.locator(".task-detail-shell")).toContainText(state.contextText);

      const columnCount = await page.locator(".task-detail").evaluate((node) => {
        return getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length;
      });
      const expectedColumns = viewport.width >= 1180 ? 2 : 1;
      expect(columnCount, `${viewport.label} ${state.label} responsive detail columns`).toBe(expectedColumns);
      const detailWidth = await page.locator(".task-detail").evaluate((node) => Math.round(node.getBoundingClientRect().width));
      expect(detailWidth, `${viewport.label} ${state.label} detail max width`).toBeLessThanOrEqual(1180);
      const headerToBriefGap = await page.locator(".task-detail-shell").evaluate((node) => {
        const head = node.querySelector(".detail-head");
        const brief = node.querySelector("#task-brief");
        if (!head || !brief) return 0;
        return Math.round(brief.getBoundingClientRect().top - head.getBoundingClientRect().bottom);
      });
      expect(headerToBriefGap, `${viewport.label} ${state.label} header-to-brief gap`).toBeGreaterThanOrEqual(48);
      await expectNoHorizontalOverflow(page, `${viewport.label} task detail ${state.label}`);
      await expectNoCriticalHorizontalClipping(
        page,
        [
          ".task-hero-status-row .status-pill-label",
          ".task-hero-status-row .chip",
          ".task-hero-actions .button",
          ".activity-composer-actions .button",
          ".card-title",
          ".task-context-label",
          ".task-context-value",
          ".rail-agent-picker .select-trigger",
          ".blocked-link .status-pill-label",
          ".run-summary-title",
          ".run-result-summary",
          ".run-summary-time",
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
  await expect(page.locator(".task-context-row", { hasText: "Run mode" })).toContainText("Auto");
});

test("task detail shows linked dependencies when the graph exists", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${blockedTaskId}`);
  await expect(page.locator(".task-metadata-card")).toContainText("Blocked by");
  await expect(page.locator(".blocked-link", { hasText: "Dependency blocker" })).toBeVisible();
});

test("task detail live panel hydrates existing run events", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${runningTaskId}`);
  await expect(page.locator(".task-live-panel", { hasText: "Existing streamed event" })).toBeVisible();
  await expect(page.locator(".task-live-panel .tool-call", { hasText: "shell" })).toBeVisible();
  await expect(page.locator(".task-live-panel .tool-call-progress")).toBeVisible();
  const toolCallAnimation = await page.locator(".task-live-panel .tool-call-progress").evaluate((node) => {
    return getComputedStyle(node).animationName;
  });
  expect(toolCallAnimation).toBe("wl-shimmer");
  const toolCallSpinnerAnimation = await page.locator(".task-live-panel .tool-call-spinner").evaluate((node) => {
    return getComputedStyle(node).animationName;
  });
  expect(toolCallSpinnerAnimation).toBe("wl-rotate");
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

test("activity open link scrolls to targeted task run", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto(`${baseUrl}/#/activity`);
  const row = page.locator(".activity-row", { hasText: "UI regression task" }).first();
  await expect(row).toBeVisible();

  await row.locator("a", { hasText: "open" }).click();
  await expect(page).toHaveURL(/#\/tasks\/[^?]+\?run=run-complete-existing$/);

  const run = page.locator(".run-card.highlighted").first();
  await expect(run).toBeVisible();
  await expect(run.locator(".run-card-events")).toBeVisible();

  await expect.poll(async () => {
    return page.locator(".app-main").evaluate((container) => {
      const target = container.querySelector(".run-card.highlighted");
      if (!target) return false;
      const targetBox = target.getBoundingClientRect();
      const scrollTop = container.scrollTop || document.documentElement.scrollTop || window.scrollY;
      return scrollTop > 0
        && targetBox.top >= 0
        && targetBox.bottom <= window.innerHeight;
    });
  }).toBe(true);
});

test("task detail run expansion only changes border color", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  const run = page.locator(".activity-feed-entry.run .run-card").first();
  await expect(run).toBeVisible();

  const before = await run.evaluate((node) => {
    const summary = node.querySelector(".run-summary");
    const cardStyle = getComputedStyle(node);
    const summaryStyle = summary ? getComputedStyle(summary) : null;
    return {
      borderLeftWidth: cardStyle.borderLeftWidth,
      borderRightWidth: cardStyle.borderRightWidth,
      paddingLeft: summaryStyle?.paddingLeft || "",
      paddingRight: summaryStyle?.paddingRight || "",
    };
  });

  await run.locator(".run-card-summary").click();
  await expect(run.locator(".run-card-events")).toBeVisible();

  const after = await run.evaluate((node) => {
    const summary = node.querySelector(".run-summary");
    const cardStyle = getComputedStyle(node);
    const summaryStyle = summary ? getComputedStyle(summary) : null;
    return {
      borderLeftWidth: cardStyle.borderLeftWidth,
      borderRightWidth: cardStyle.borderRightWidth,
      paddingLeft: summaryStyle?.paddingLeft || "",
      paddingRight: summaryStyle?.paddingRight || "",
    };
  });

  expect(after.borderLeftWidth).toBe(before.borderLeftWidth);
  expect(after.borderRightWidth).toBe(before.borderRightWidth);
  expect(after.paddingLeft).toBe(before.paddingLeft);
  expect(after.paddingRight).toBe(before.paddingRight);
});

test("task detail mounts the automations card with scheduled markers", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-hero-status-row .chip", { hasText: "Scheduled" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Automations" })).toBeVisible();
  await expect(page.locator(".task-automation-row", { hasText: "Daily" })).toBeVisible();
});

test("task detail inline checkboxes align with their labels", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-subtasks-add .checkbox", { hasText: "Required" })).toBeVisible();
  await page.locator(".task-automations-card").getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".task-automation-form .checkbox", { hasText: "Enabled" })).toBeVisible();

  const deltas = await page.evaluate(() => {
    function centerDelta(selector) {
      const box = document.querySelector(`${selector} .checkbox-box`);
      const label = document.querySelector(`${selector} .checkbox-label`);
      if (!box || !label) return 99;
      const boxRect = box.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return Math.abs((boxRect.top + boxRect.height / 2) - (labelRect.top + labelRect.height / 2));
    }
    return {
      required: centerDelta(".task-subtasks-add .checkbox"),
      enabled: centerDelta(".task-automation-form .checkbox"),
    };
  });

  expect(deltas.required).toBeLessThanOrEqual(2);
  expect(deltas.enabled).toBeLessThanOrEqual(2);
});

test("multi-line selection controls center against their copy", async ({ page }) => {
  await page.goto(`${baseUrl}/#/settings`);
  await expect(page.locator(".settings-sections")).toBeVisible();
  await expect(page.locator(".switch", { hasText: "Nightly consolidation" })).toBeVisible();

  const deltas = await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.innerHTML = `
      <label class="checkbox checkbox-alignment-fixture">
        <input class="checkbox-input" type="checkbox">
        <span class="checkbox-box"></span>
        <span class="checkbox-copy">
          <span class="checkbox-label">Fixture checkbox</span>
          <span class="checkbox-description">Description text below.</span>
        </span>
      </label>
    `;
    document.body.appendChild(fixture);

    function centerDelta(rootSelector, markerSelector, copySelector) {
      const marker = document.querySelector(`${rootSelector} ${markerSelector}`);
      const copy = document.querySelector(`${rootSelector} ${copySelector}`);
      if (!marker || !copy) return 99;
      const markerRect = marker.getBoundingClientRect();
      const copyRect = copy.getBoundingClientRect();
      return Math.abs((markerRect.top + markerRect.height / 2) - (copyRect.top + copyRect.height / 2));
    }

    return {
      settingsSwitch: centerDelta(".settings-sections .switch", ".switch-track", ".switch-copy"),
      checkbox: centerDelta(".checkbox-alignment-fixture", ".checkbox-box", ".checkbox-copy"),
    };
  });

  expect(deltas.settingsSwitch).toBeLessThanOrEqual(1);
  expect(deltas.checkbox).toBeLessThanOrEqual(1);
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

test("skill editor clears priority and keeps availability on its own row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/#/skills/${skillName}`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Regression Skill" })).toBeVisible();

  const layout = await page.evaluate(() => {
    const grid = document.querySelector(".skill-detail-body .form-grid");
    const fields = grid ? [...grid.children] : [];
    const priority = fields.find((field) => (field.textContent || "").includes("Priority"));
    const availability = grid?.querySelector(".form-field-switch");
    const gridRect = grid?.getBoundingClientRect();
    const priorityRect = priority?.getBoundingClientRect();
    const availabilityRect = availability?.getBoundingClientRect();
    return {
      gridWidth: gridRect?.width || 0,
      availabilityWidth: availabilityRect?.width || 0,
      availabilityTop: availabilityRect?.top || 0,
      priorityBottom: priorityRect?.bottom || 0,
    };
  });
  expect(layout.availabilityWidth).toBeGreaterThan(layout.gridWidth * 0.9);
  expect(layout.availabilityTop).toBeGreaterThan(layout.priorityBottom);

  const priorityField = page.locator(".skill-detail-body .form-field", { hasText: "Priority" });
  const priorityTrigger = priorityField.locator(".select-trigger");
  await priorityTrigger.click();
  await page.getByRole("option", { name: "Always inline full body" }).click();
  await expect(priorityTrigger).toContainText("Always inline full body");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith(`/api/skills/${skillName}`) && res.request().method() === "PATCH"),
    page.getByRole("button", { name: "Save" }).click(),
  ]);

  await priorityTrigger.click();
  await page.getByRole("option", { name: "On demand" }).click();
  await expect(priorityTrigger).toContainText("On demand");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith(`/api/skills/${skillName}`) && res.request().method() === "PATCH"),
    page.getByRole("button", { name: "Save" }).click(),
  ]);

  await page.reload();
  await expect(page.locator(".pane-detail-head h2", { hasText: "Regression Skill" })).toBeVisible();
  await expect(priorityTrigger).toContainText("On demand");
});

test("agents skills and knowledge panes keep polished rows and detail headers legible", async ({ page }) => {
  const routes = [
    {
      hash: "#/agents/regression-agent",
      title: "Regression Agent",
      rowText: "Regression Agent",
      detailText: "regression-agent",
      entityEditor: true,
      flatBody: true,
    },
    {
      hash: `#/skills/${skillName}`,
      title: "Regression Skill",
      rowText: "Regression Skill",
      detailText: "On demand",
      entityEditor: true,
    },
    {
      hash: "#/knowledge/mobile-layout-reference",
      title: "Mobile layout reference",
      rowText: "Mobile layout reference",
      detailText: "mobile-layout-reference",
      entityEditor: true,
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
      if (route.entityEditor) {
        await expect(page.locator(".entity-editor-layout")).toBeVisible();
        await expect(page.locator(".entity-editor-main > .form-section").first()).toBeVisible();
        await expect(page.locator(".entity-editor-rail .card-title").first()).toBeVisible();
      } else {
        await expect(page.locator(".pane-detail-body > .form-section").first()).toBeVisible();
      }

      const paneMetrics = await page.evaluate(({ entityEditor, flatBody }) => {
        const row = document.querySelector(".pane-row.active");
        const detailHead = document.querySelector(".pane-detail-head");
        const body = document.querySelector(".pane-detail-body");
        const list = document.querySelector(".pane-list");
        const formSection = entityEditor
          ? document.querySelector(".entity-editor-main > .form-section")
          : document.querySelector(".pane-detail-body > .form-section");
        const editor = document.querySelector(".entity-editor-layout");
        const sectionStyle = formSection ? getComputedStyle(formSection) : null;
        const capabilityPanel = flatBody ? document.querySelector(".agent-editor-layout .capability-panel") : null;
        const capabilityStyle = capabilityPanel ? getComputedStyle(capabilityPanel) : null;
        return {
          rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
          headHeight: detailHead ? Math.round(detailHead.getBoundingClientRect().height) : 0,
          bodyWidth: body ? Math.round(body.getBoundingClientRect().width) : 0,
          listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0,
          sectionRadius: sectionStyle ? parseFloat(sectionStyle.borderRadius) : 0,
          sectionBorderWidth: sectionStyle ? parseFloat(sectionStyle.borderTopWidth) : 0,
          sectionBackground: sectionStyle?.backgroundColor || "",
          capabilityRadius: capabilityStyle ? parseFloat(capabilityStyle.borderRadius) : 0,
          capabilityBackground: capabilityStyle?.backgroundColor || "",
          editorColumns: editor ? getComputedStyle(editor).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
        };
      }, { entityEditor: !!route.entityEditor, flatBody: !!route.flatBody });
      expect(paneMetrics.rowHeight, `${viewport.label} ${route.hash} row height`).toBeGreaterThanOrEqual(56);
      expect(paneMetrics.headHeight, `${viewport.label} ${route.hash} head height`).toBeGreaterThanOrEqual(68);
      expect(paneMetrics.bodyWidth, `${viewport.label} ${route.hash} body width`).toBeGreaterThan(0);
      expect(paneMetrics.listWidth, `${viewport.label} ${route.hash} list width`).toBeGreaterThanOrEqual(300);
      if (route.flatBody) {
        expect(paneMetrics.sectionRadius, `${viewport.label} ${route.hash} flat section radius`).toBe(0);
        expect(paneMetrics.sectionBorderWidth, `${viewport.label} ${route.hash} flat section border`).toBe(0);
        expect(paneMetrics.sectionBackground, `${viewport.label} ${route.hash} flat section background`).toBe("rgba(0, 0, 0, 0)");
        expect(paneMetrics.capabilityRadius, `${viewport.label} ${route.hash} flat capability radius`).toBe(0);
        expect(paneMetrics.capabilityBackground, `${viewport.label} ${route.hash} flat capability background`).toBe("rgba(0, 0, 0, 0)");
      } else {
        expect(paneMetrics.sectionRadius, `${viewport.label} ${route.hash} section radius`).toBeGreaterThanOrEqual(6);
      }
      if (route.entityEditor) {
        expect(paneMetrics.editorColumns, `${viewport.label} ${route.hash} editor columns`).toBeGreaterThanOrEqual(1);
      }

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
          ".entity-meta-row dt",
          ".entity-meta-row dd",
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
    { hash: "#/agents/regression-agent", title: "Regression Agent", back: "All agents", entityEditor: true, flatBody: true },
    { hash: `#/skills/${skillName}`, title: "Regression Skill", back: "All skills", entityEditor: true },
    { hash: "#/knowledge/mobile-layout-reference", title: "Mobile layout reference", back: "Knowledge", entityEditor: true },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    if (route.entityEditor) {
      await expect(page.locator(".pane-mobile-back")).toHaveCount(0);
      await expect(page.locator(".mobile-topbar-back").first()).toBeVisible();
      await expect(page.locator(".entity-edit-mobile-dock .button", { hasText: "Save" })).toBeVisible();
    } else {
      await expect(page.locator(".pane-mobile-back .button", { hasText: route.back })).toBeVisible();
    }
    await expect(page.locator(".pane-detail-head h2", { hasText: route.title })).toBeVisible();
    await expect(page.locator(".pane-detail-subline")).toBeVisible();
    if (route.entityEditor) {
      await expect(page.locator(".entity-editor-layout")).toBeVisible();
      await expect(page.locator(".entity-editor-main > .form-section").first()).toBeVisible();
      await expect(page.locator(".entity-editor-rail.is-mobile-drawer-source").first()).toBeHidden();
      await expect(page.locator(".rail-summary-pill").first()).toBeVisible();
    } else {
      await expect(page.locator(".pane-detail-body > .form-section").first()).toBeVisible();
    }

    const mobileMetrics = await page.evaluate((entityEditor) => {
      const head = document.querySelector(".pane-detail-head");
      const toolbar = document.querySelector(".pane-detail-head .toolbar");
      const dock = document.querySelector(".entity-edit-mobile-dock");
      const tabbar = document.querySelector(".app-tabbar");
      const formSection = entityEditor
        ? document.querySelector(".entity-editor-main > .form-section")
        : document.querySelector(".pane-detail-body > .form-section");
      const icon = document.querySelector(".pane-detail-icon, .agent-avatar");
      const rail = document.querySelector(".entity-editor-rail");
      return {
        headWidth: head ? Math.round(head.getBoundingClientRect().width) : 0,
        toolbarTop: toolbar ? Math.round(toolbar.getBoundingClientRect().top) : 0,
        toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : "",
        dockDisplay: dock ? getComputedStyle(dock).display : "",
        tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
        dockBottomBeforeNav: dock
          ? Math.round(dock.getBoundingClientRect().bottom) <= window.innerHeight + 1
          : false,
        headTop: head ? Math.round(head.getBoundingClientRect().top) : 0,
        sectionRadius: formSection ? parseFloat(getComputedStyle(formSection).borderRadius) : 0,
        iconWidth: icon ? Math.round(icon.getBoundingClientRect().width) : 0,
        railPosition: rail ? getComputedStyle(rail).position : "",
      };
    }, !!route.entityEditor);
    expect(mobileMetrics.headWidth).toBeLessThanOrEqual(390);
    expect(mobileMetrics.toolbarTop === 0 || mobileMetrics.toolbarTop >= mobileMetrics.headTop).toBe(true);
    if (route.flatBody) expect(mobileMetrics.sectionRadius).toBe(0);
    else expect(mobileMetrics.sectionRadius).toBeGreaterThanOrEqual(6);
    expect(mobileMetrics.iconWidth === 0 || mobileMetrics.iconWidth >= 28).toBe(true);
    if (route.entityEditor) {
      expect(mobileMetrics.railPosition).toBe("static");
      expect(mobileMetrics.toolbarDisplay).toBe("none");
      expect(mobileMetrics.dockDisplay).toBe("flex");
      expect(mobileMetrics.dockBottomBeforeNav).toBe(true);
      expect(mobileMetrics.tabbarDisplay).toBe("none");
    }

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
    { hash: "#/agents", ready: () => page.locator(".pane-list") },
    { hash: "#/agents/regression-agent", ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Agent" }) },
    { hash: "#/agents/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New agent" }) },
    { hash: "#/skills", ready: () => page.locator(".pane-list") },
    { hash: `#/skills/${skillName}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Skill" }) },
    { hash: "#/skills/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New skill" }) },
    { hash: "#/knowledge", ready: () => page.locator(".pane-list") },
    { hash: "#/knowledge/welcome", ready: () => page.locator(".pane-detail-head h2", { hasText: "Welcome guide" }) },
    { hash: "#/knowledge/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New entry" }) },
    { hash: "#/providers", ready: () => page.locator(".pane-list") },
    { hash: `#/providers/${providerId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression provider" }) },
    { hash: "#/providers/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New provider" }) },
    { hash: "#/activity", ready: () => page.locator(".summary-tiles") },
    { hash: "#/settings", ready: () => page.locator(".settings-sections") },
    { hash: "#/design-system", ready: () => page.locator(".ds-catalog") },
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
  await expect(page.locator(".commander-row.selected").first()).toBeVisible();
  const touchTargetRow = page.locator(".commander-row").nth(1);
  await touchTargetRow.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await expect(touchTargetRow).toHaveClass(/selected/);

  const metrics = await page.evaluate(() => {
    const row = document.querySelector(".commander-row");
    const selectedRow = document.querySelector(".commander-row.selected");
    const baseRow = document.querySelector(".commander-row:not(.selected)");
    const id = row?.querySelector(".commander-cell-id");
    const state = row?.querySelector(".commander-cell-state");
    const filter = document.querySelector(".commander-filter");
    const search = document.querySelector(".commander-filter .search-field");
    const tabs = document.querySelector(".commander-filter .tabs");
    const pill = row?.querySelector(".status-pill");
    const inlineNewTask = document.querySelector(".commander-new-task-inline");
    const fab = document.querySelector(".commander-new-task-fab");
    const nav = document.querySelector(".app-tabbar");
    const selectedStyles = selectedRow ? getComputedStyle(selectedRow) : null;
    const baseStyles = baseRow ? getComputedStyle(baseRow) : null;
    const fabStyles = fab ? getComputedStyle(fab) : null;
    const fabRect = fab?.getBoundingClientRect();
    const navRect = nav?.getBoundingClientRect();
    const navElement = document.querySelector(".app-tabbar");
    const activeNav = document.querySelector(".app-tabbar a.active");
    const railStyles = nav ? getComputedStyle(nav) : null;
    const navStyles = navElement ? getComputedStyle(navElement) : null;
    const activeNavBefore = activeNav ? getComputedStyle(activeNav, "::before") : null;
    const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
    const bodyStyles = getComputedStyle(document.body);
    const rowStyles = row ? getComputedStyle(row) : null;
    const navWidths = [...document.querySelectorAll(".app-tabbar a")]
      .map((entry) => Math.round(entry.getBoundingClientRect().width));
    const tabHeights = [...document.querySelectorAll(".commander-filter .tab")]
      .map((entry) => Math.round(entry.getBoundingClientRect().height));
    return {
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
      filterHeight: filter ? Math.round(filter.getBoundingClientRect().height) : 0,
      searchWidth: search ? Math.round(search.getBoundingClientRect().width) : 0,
      searchTop: search ? Math.round(search.getBoundingClientRect().top) : 0,
      tabsTop: tabs ? Math.round(tabs.getBoundingClientRect().top) : 0,
      idDisplay: id ? getComputedStyle(id).display : "",
      stateDisplay: state ? getComputedStyle(state).display : "",
      pillVisible: pill ? getComputedStyle(pill).display !== "none" : false,
      navMinWidth: Math.min(...navWidths),
      navMaxWidth: Math.max(...navWidths),
      navOverflow: navElement ? Math.round(navElement.scrollWidth - navElement.clientWidth) : 0,
      railOverflow: nav ? Math.round(nav.scrollWidth - nav.clientWidth) : 0,
      railOverflowX: railStyles?.overflowX || "",
      navDisplay: navStyles?.display || "",
      navOverflowX: navStyles?.overflowX || "",
      activeNavBeforeDisplay: activeNavBefore?.display || "",
      activeNavBeforeContent: activeNavBefore?.content || "",
      tabMinHeight: Math.min(...tabHeights),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      viewportMeta,
      bodyTouchAction: bodyStyles.touchAction,
      rowTouchAction: rowStyles?.touchAction || "",
      inlineNewTaskDisplay: inlineNewTask ? getComputedStyle(inlineNewTask).display : "",
      selectedBorderLeftWidth: selectedStyles ? Math.round(parseFloat(selectedStyles.borderLeftWidth)) : 0,
      selectedBorderTopColor: selectedStyles?.borderTopColor || "",
      selectedBorderRightColor: selectedStyles?.borderRightColor || "",
      selectedBorderBottomWidth: selectedStyles ? Math.round(parseFloat(selectedStyles.borderBottomWidth)) : -1,
      selectedPaddingLeft: selectedStyles ? Math.round(parseFloat(selectedStyles.paddingLeft)) : -1,
      basePaddingLeft: baseStyles ? Math.round(parseFloat(baseStyles.paddingLeft)) : -1,
      selectedTopLeftRadius: selectedStyles ? Math.round(parseFloat(selectedStyles.borderTopLeftRadius)) : -1,
      selectedBottomLeftRadius: selectedStyles ? Math.round(parseFloat(selectedStyles.borderBottomLeftRadius)) : -1,
      fabDisplay: fabStyles?.display || "",
      fabLabel: fab?.getAttribute("aria-label") || "",
      fabWidth: fabRect ? Math.round(fabRect.width) : 0,
      fabHeight: fabRect ? Math.round(fabRect.height) : 0,
      fabRadius: fabStyles ? Math.round(parseFloat(fabStyles.borderRadius)) : 0,
      fabBottomBeforeNav: fabRect && navRect ? Math.round(fabRect.bottom) <= Math.round(navRect.top) + 1 : false,
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.idDisplay).toBe("none");
  expect(metrics.stateDisplay).toBe("none");
  expect(metrics.pillVisible).toBe(true);
  expect(metrics.rowHeight).toBeGreaterThanOrEqual(60);
  expect(metrics.rowHeight).toBeLessThanOrEqual(88);
  expect(metrics.filterHeight).toBeLessThanOrEqual(104);
  expect(metrics.searchWidth).toBeGreaterThanOrEqual(360);
  expect(metrics.tabsTop).toBeGreaterThan(metrics.searchTop);
  expect(metrics.navMinWidth).toBeGreaterThanOrEqual(44);
  expect(metrics.navMaxWidth - metrics.navMinWidth).toBeLessThanOrEqual(1);
  expect(metrics.navOverflow).toBeLessThanOrEqual(0);
  expect(metrics.railOverflow).toBeLessThanOrEqual(0);
  expect(["clip", "hidden"]).toContain(metrics.railOverflowX);
  expect(metrics.navDisplay).toBe("grid");
  expect(["clip", "hidden"]).toContain(metrics.navOverflowX);
  expect(metrics.activeNavBeforeContent).toBe("none");
  expect(metrics.viewportMeta).toContain("maximum-scale=1");
  expect(metrics.viewportMeta).toContain("user-scalable=no");
  expect(metrics.bodyTouchAction).toBe("manipulation");
  expect(metrics.rowTouchAction).toBe("manipulation");
  expect(metrics.tabMinHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.inlineNewTaskDisplay).toBe("none");
  expect(metrics.selectedBorderLeftWidth).toBe(2);
  expect(metrics.selectedBorderTopColor).toBe("rgba(0, 0, 0, 0)");
  expect(metrics.selectedBorderRightColor).toBe("rgba(0, 0, 0, 0)");
  expect(metrics.selectedBorderBottomWidth).toBe(0);
  expect(metrics.selectedPaddingLeft).toBe(metrics.basePaddingLeft);
  expect(metrics.selectedTopLeftRadius).toBe(0);
  expect(metrics.selectedBottomLeftRadius).toBe(0);
  expect(metrics.fabDisplay).toBe("flex");
  expect(metrics.fabLabel).toBe("New task");
  expect(metrics.fabWidth).toBe(56);
  expect(metrics.fabHeight).toBe(56);
  expect(metrics.fabRadius).toBeGreaterThanOrEqual(28);
  expect(metrics.fabBottomBeforeNav).toBe(true);

  await page.locator(".commander-new-task-fab").click();
  await expect(page).toHaveURL(/#\/tasks\/new/);
});

test("mobile task detail keeps activity first with a compact premium composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-hero-title", { hasText: "UI regression task" })).toBeVisible();

  const beforeFocus = await page.evaluate(() => {
    const activity = document.querySelector(".activity-card");
    const agents = document.querySelector(".rail-agents-card");
    const context = document.querySelector(".task-metadata-card");
    const composer = document.querySelector(".activity-composer-form");
    const input = document.querySelector(".activity-composer-input");
    const shortcut = document.querySelector(".activity-composer-shortcut");
    const rerun = document.querySelector(".activity-rerun-checkbox input");
    const dock = document.querySelector(".app-mobile-action-dock");
    const heroActions = document.querySelector(".task-hero-actions");
    const tabbar = document.querySelector(".app-tabbar");
    const head = document.querySelector(".task-detail-shell .detail-head");
    const brief = document.querySelector("#task-brief");
    const rail = document.querySelector(".activity-feed-entry:not(:last-child) .activity-feed-rail");
    const dot = document.querySelector(".activity-feed-dot:not(.avatar)") || document.querySelector(".activity-feed-dot");
    const line = rail ? getComputedStyle(rail, "::after") : null;
    const isRendered = (element) => element && element.getClientRects().length > 0;
    return {
      activityBeforeAgents: activity && agents
        ? !isRendered(agents) || activity.getBoundingClientRect().top < agents.getBoundingClientRect().top
        : false,
      activityBeforeContext: activity && context
        ? !isRendered(context) || activity.getBoundingClientRect().top < context.getBoundingClientRect().top
        : false,
      activityBorder: activity ? parseFloat(getComputedStyle(activity).borderTopWidth) : -1,
      composerHeight: composer ? Math.round(composer.getBoundingClientRect().height) : 0,
      inputHeight: input ? Math.round(input.getBoundingClientRect().height) : 0,
      shortcutDisplay: shortcut ? getComputedStyle(shortcut).display : "",
      rerunChecked: rerun ? rerun.checked : false,
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      dockMinButtonHeight: dock
        ? Math.min(...[...dock.querySelectorAll(".button")].map((button) => Math.round(button.getBoundingClientRect().height)))
        : 0,
      tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
      dockBottomBeforeNav: dock
        ? Math.round(dock.getBoundingClientRect().bottom) <= window.innerHeight + 1
        : false,
      headerToBriefGap: head && brief
        ? Math.round(brief.getBoundingClientRect().top - head.getBoundingClientRect().bottom)
        : 0,
      heroActionsDisplay: heroActions ? getComputedStyle(heroActions).display : "",
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      dotWidth: dot ? Math.round(parseFloat(getComputedStyle(dot).getPropertyValue("--activity-dot-size")) || dot.getBoundingClientRect().width) : 0,
      lineWidth: line ? Math.round(parseFloat(line.width)) : 0,
    };
  });

  expect(beforeFocus.activityBeforeAgents).toBe(true);
  expect(beforeFocus.activityBeforeContext).toBe(true);
  expect(beforeFocus.activityBorder).toBe(0);
  expect(beforeFocus.composerHeight).toBeLessThanOrEqual(112);
  expect(beforeFocus.inputHeight).toBeLessThanOrEqual(48);
  expect(beforeFocus.shortcutDisplay).toBe("none");
  expect(beforeFocus.rerunChecked).toBe(true);
  expect(beforeFocus.dockDisplay).toBe("flex");
  expect(beforeFocus.dockMinButtonHeight).toBeGreaterThanOrEqual(44);
  expect(beforeFocus.dockBottomBeforeNav).toBe(true);
  expect(beforeFocus.headerToBriefGap).toBeGreaterThanOrEqual(40);
  expect(beforeFocus.tabbarDisplay).toBe("none");
  expect(beforeFocus.heroActionsDisplay).toBe("none");
  expect(beforeFocus.railWidth).toBeLessThanOrEqual(24);
  expect(beforeFocus.dotWidth).toBeLessThanOrEqual(20);
  expect(beforeFocus.lineWidth).toBe(1);

  await page.locator(".activity-composer textarea").focus();
  const afterFocus = await page.evaluate(() => {
    const input = document.querySelector(".activity-composer-input");
    const tabbar = document.querySelector(".app-tabbar");
    const dock = document.querySelector(".app-mobile-action-dock");
    return {
      inputHeight: input ? Math.round(input.getBoundingClientRect().height) : 0,
      tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
      dockTransform: dock ? getComputedStyle(dock).transform : "",
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(afterFocus.inputHeight).toBeGreaterThanOrEqual(84);
  expect(afterFocus.tabbarDisplay).toBe("none");
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
    const tabbar = document.querySelector(".app-tabbar");
    const grid = document.querySelector(".task-edit-grid");
    const rail = document.querySelector(".task-edit-rail");
    const settingsPill = document.querySelector(".rail-summary-pill");
    const dockButtons = [...document.querySelectorAll(".app-mobile-action-dock .button")];
    const body = document.querySelector(".task-edit-body");
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      editHeadHeight: editHead ? Math.round(editHead.getBoundingClientRect().height) : 0,
      toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : "",
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      dockMinButtonHeight: Math.min(...dockButtons.map((button) => Math.round(button.getBoundingClientRect().height))),
      tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
      dockBottomBeforeNav: dock
        ? Math.round(dock.getBoundingClientRect().bottom) <= window.innerHeight + 1
        : false,
      gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      railPosition: rail ? getComputedStyle(rail).position : "",
      railDisplay: rail ? getComputedStyle(rail).display : "",
      settingsPillDisplay: settingsPill ? getComputedStyle(settingsPill).display : "",
      bodyPaddingBottom: body ? Math.round(parseFloat(getComputedStyle(body).paddingBottom)) : 0,
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.editHeadHeight).toBeLessThanOrEqual(72);
  expect(metrics.toolbarDisplay).toBe("none");
  expect(metrics.dockDisplay).toBe("flex");
  expect(metrics.dockMinButtonHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.dockBottomBeforeNav).toBe(true);
  expect(metrics.tabbarDisplay).toBe("none");
  expect(metrics.gridColumns).toBe(1);
  expect(metrics.railPosition).toBe("static");
  expect(metrics.railDisplay).toBe("none");
  expect(["flex", "inline-flex"]).toContain(metrics.settingsPillDisplay);
  expect(metrics.bodyPaddingBottom).toBeGreaterThanOrEqual(120);
  await expectNoHorizontalOverflow(page, "mobile task edit action dock");
});

test("mobile create editors keep headers, actions, and forms usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    { hash: "#/agents/new", title: "New agent", back: "All agents", entityEditor: true },
    { hash: "#/skills/new", title: "New skill", back: "All skills", entityEditor: true },
    { hash: "#/knowledge/new", title: "New entry", back: "Knowledge", entityEditor: true },
    { hash: "#/providers/new", title: "New provider", back: "Providers", entityEditor: true },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    if (route.entityEditor) {
      await expect(page.locator(".pane-mobile-back")).toHaveCount(0);
      await expect(page.locator(".mobile-topbar-back").first()).toBeVisible();
      await expect(page.locator(".entity-edit-mobile-dock .button", { hasText: "Create" })).toBeVisible();
    } else {
      await expect(page.locator(".pane-mobile-back .button", { hasText: route.back })).toBeVisible();
    }
    await expect(page.locator(".pane-detail-head h2", { hasText: route.title })).toBeVisible();
    if (!route.entityEditor) {
      await expect(page.locator(".pane-detail-head .toolbar .button").first()).toBeVisible();
    }
    if (route.entityEditor) {
      await expect(page.locator(".entity-editor-main > .form-section").first()).toBeVisible();
    } else {
      await expect(page.locator(".pane-detail-body > .form-section").first()).toBeVisible();
    }

    const metrics = await page.evaluate((entityEditor) => {
      const head = document.querySelector(".pane-detail-head");
      const toolbar = document.querySelector(".pane-detail-head .toolbar");
      const dock = document.querySelector(".entity-edit-mobile-dock");
      const tabbar = document.querySelector(".app-tabbar");
      const buttons = [...document.querySelectorAll(entityEditor ? ".entity-edit-mobile-dock .button" : ".pane-detail-head .toolbar .button")];
      const sections = [...document.querySelectorAll(entityEditor ? ".entity-editor-main > .form-section" : ".pane-detail-body > .form-section")];
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        headWidth: head ? Math.round(head.getBoundingClientRect().width) : 0,
        toolbarWidth: toolbar ? Math.round(toolbar.getBoundingClientRect().width) : 0,
        toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : "",
        dockDisplay: dock ? getComputedStyle(dock).display : "",
        tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
        dockBottomBeforeNav: dock
          ? Math.round(dock.getBoundingClientRect().bottom) <= window.innerHeight + 1
          : false,
        minButtonHeight: buttons.length
          ? Math.min(...buttons.map((button) => Math.round(button.getBoundingClientRect().height)))
          : 0,
        sectionCount: sections.length,
        minSectionWidth: sections.length
          ? Math.min(...sections.map((section) => Math.round(section.getBoundingClientRect().width)))
          : 0,
      };
    }, !!route.entityEditor);
    expect(metrics.overflow, `${route.hash} overflow`).toBeLessThanOrEqual(0);
    expect(metrics.headWidth, `${route.hash} head width`).toBeLessThanOrEqual(390);
    expect(metrics.toolbarWidth, `${route.hash} toolbar width`).toBeLessThanOrEqual(390);
    expect(metrics.minButtonHeight, `${route.hash} button height`).toBeGreaterThanOrEqual(44);
    if (route.entityEditor) {
      expect(metrics.toolbarDisplay, `${route.hash} toolbar`).toBe("none");
      expect(metrics.dockDisplay, `${route.hash} dock`).toBe("flex");
      expect(metrics.dockBottomBeforeNav, `${route.hash} dock before nav`).toBe(true);
      expect(metrics.tabbarDisplay, `${route.hash} tabbar`).toBe("none");
    }
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
  const titleInput = page.locator('input[placeholder*="actionable"]');
  await titleInput.fill("UI regression task with unsaved mobile edit");
  await expect(page.locator(".app-mobile-action-dock .button.primary", { hasText: "Save" })).toBeVisible();
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
