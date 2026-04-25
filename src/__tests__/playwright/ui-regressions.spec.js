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
let scheduleId;
let scheduledTaskId;
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
    executor_agent: "regression-agent",
    reviewer_agent: "reviewer-agent",
  });
  completedTaskId = await createTask("Completed detail task", {
    executor_agent: "regression-agent",
  });
  await requestJson(`/api/tasks/${completedTaskId}`, {
    method: "PATCH",
    body: { status: "done" },
    ok: [200],
  });
  await createTask("In progress task", { status: "in_progress" });
  runningTaskId = await createTask("Running detail task", { status: "in_progress" });
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
  const scheduleRun = await requestJson(`/api/schedules/${scheduleId}/run`, { method: "POST", ok: [201] });
  scheduledTaskId = scheduleRun.task.id;
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
  await expect(page.locator(".card-title", { hasText: "Context" })).toBeVisible();
});

test("task detail polish keeps details, agent picker, and newest-first comments clear", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-detail-tile")).toHaveCount(0);
  await expect(page.locator(".task-context-row")).toHaveCount(2);
  await expect(page.locator(".task-context-row", { hasText: "Completed" })).toHaveCount(0);
  await expect(page.locator(".task-context-row", { hasText: "Schedule" })).toHaveCount(0);
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

test("task detail context only shows completion and schedule when present", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${completedTaskId}`);
  await expect(page.locator(".task-context-row", { hasText: "Completed" })).toBeVisible();

  await page.goto(`${baseUrl}/#/tasks/${scheduledTaskId}`);
  const scheduleRow = page.locator(".task-context-row", { hasText: "Schedule" });
  await expect(scheduleRow).toBeVisible();
  await expect(scheduleRow.locator("a")).toHaveAttribute("href", `#/schedules/${scheduleId}`);
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

test("schedules route mounts the pane editor with upcoming and recent sections", async ({ page }) => {
  await page.goto(`${baseUrl}/#/schedules/${scheduleId}`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Regression schedule" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Upcoming fires" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "Recent spawned tasks" })).toBeVisible();
});

test("destructive pane actions stay behind disclosure", async ({ page }) => {
  for (const hash of [
    "#/agents/regression-agent",
    "#/knowledge/welcome",
    `#/providers/${providerId}`,
    `#/schedules/${scheduleId}`,
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
  const { taskId, scheduleId, providerId, skillName } = ids;
  return [
    { hash: "#/tasks", ready: () => page.locator(".commander-row").first() },
    { hash: `#/tasks/${taskId}`, ready: () => page.locator(".task-hero-title", { hasText: "UI regression task" }) },
    { hash: "#/tasks/new", ready: () => page.locator(".task-edit-head").first() },
    { hash: "#/agents", ready: () => page.locator('h1.app-title', { hasText: "Agents" }) },
    { hash: "#/agents/regression-agent", ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Agent" }) },
    { hash: "#/agents/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New agent" }) },
    { hash: "#/skills", ready: () => page.locator('h1.app-title', { hasText: "Skills" }) },
    { hash: `#/skills/${skillName}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Skill" }) },
    { hash: "#/knowledge", ready: () => page.locator('h1.app-title', { hasText: "Knowledge" }) },
    { hash: "#/knowledge/welcome", ready: () => page.locator(".pane-detail-head h2", { hasText: "Welcome guide" }) },
    { hash: "#/providers", ready: () => page.locator('h1.app-title', { hasText: "Providers" }) },
    { hash: `#/providers/${providerId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression provider" }) },
    { hash: "#/providers/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New provider" }) },
    { hash: "#/activity", ready: () => page.locator('h1.app-title', { hasText: "Activity" }) },
    { hash: "#/schedules", ready: () => page.locator('h1.app-title', { hasText: "Schedules" }) },
    { hash: `#/schedules/${scheduleId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression schedule" }) },
    { hash: "#/settings", ready: () => page.locator('h1.app-title', { hasText: "Settings" }) },
  ];
}

for (const vp of RESPONSIVE_VIEWPORTS) {
  test(`no horizontal overflow at ${vp.label} (${vp.w}x${vp.h})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    const routes = responsiveRoutes(page, { taskId, scheduleId, providerId, skillName });
    for (const route of routes) {
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
    const filter = document.querySelector(".commander-filter");
    const pill = row?.querySelector(".status-pill");
    return {
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
      filterHeight: filter ? Math.round(filter.getBoundingClientRect().height) : 0,
      idDisplay: id ? getComputedStyle(id).display : "",
      pillVisible: pill ? getComputedStyle(pill).display !== "none" : false,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.idDisplay).toBe("none");
  expect(metrics.pillVisible).toBe(true);
  expect(metrics.rowHeight).toBeGreaterThanOrEqual(60);
  expect(metrics.rowHeight).toBeLessThanOrEqual(88);
  expect(metrics.filterHeight).toBeLessThanOrEqual(92);
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
    };
  });

  expect(beforeFocus.activityBeforeAgents).toBe(true);
  expect(beforeFocus.activityBeforeContext).toBe(true);
  expect(beforeFocus.activityBorder).toBe(0);
  expect(beforeFocus.composerHeight).toBeLessThanOrEqual(64);
  expect(beforeFocus.inputHeight).toBeLessThanOrEqual(48);
  expect(beforeFocus.shortcutDisplay).toBe("none");

  await page.locator(".activity-composer textarea").focus();
  const afterFocus = await page.evaluate(() => {
    const input = document.querySelector(".activity-composer-input");
    const rail = document.querySelector(".app-rail");
    return {
      inputHeight: input ? Math.round(input.getBoundingClientRect().height) : 0,
      railTransform: rail ? getComputedStyle(rail).transform : "",
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(afterFocus.inputHeight).toBeGreaterThanOrEqual(84);
  expect(afterFocus.railTransform).not.toBe("none");
  expect(afterFocus.overflow).toBeLessThanOrEqual(0);
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
