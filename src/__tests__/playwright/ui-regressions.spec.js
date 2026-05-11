import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let parentWithChildTaskId;
let childTaskId;
let providerId;
let skillName;
let projectSlug;
let teamSlug;
let goalId;

const liveLongToken = `live-unbroken-${"x".repeat(180)}`;
const childLongToken = `child-unbroken-${"y".repeat(150)}`;
const errorLongToken = `error-unbroken-${"z".repeat(180)}`;

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

async function modalLayoutMetrics(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector(".modal");
    const body = document.querySelector(".modal-body");
    const footer = document.querySelector(".modal-foot");
    const buttons = [...document.querySelectorAll(".modal-foot .button")];
    const modalRect = modal?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    const buttonRects = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        text: (button.textContent || "").trim(),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollWidth: button.scrollWidth,
        clientWidth: button.clientWidth,
      };
    });
    const inside = (child, parent) => !!child && !!parent
      && child.left >= parent.left - 1
      && child.right <= parent.right + 1
      && child.top >= parent.top - 1
      && child.bottom <= parent.bottom + 1;
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      width: modalRect ? Math.round(modalRect.width) : 0,
      bodyText: (body?.textContent || "").replace(/\s+/g, " ").trim(),
      bodyVisible: !!bodyRect && bodyRect.width > 0 && bodyRect.height > 0,
      footerDisplay: footer ? getComputedStyle(footer).display : "",
      minButtonHeight: buttonRects.length ? Math.min(...buttonRects.map((button) => button.height)) : 0,
      maxButtonWidth: buttonRects.length ? Math.max(...buttonRects.map((button) => button.width)) : 0,
      buttonOverflow: buttonRects.some((button) => button.scrollWidth > button.clientWidth + 1),
      buttonsInsideFooter: footerRect ? buttons.every((button) => inside(button.getBoundingClientRect(), footerRect)) : false,
      buttonsInsideModal: modalRect ? buttons.every((button) => inside(button.getBoundingClientRect(), modalRect)) : false,
      buttonLabels: buttonRects.map((button) => button.text),
    };
  });
}

async function mobileConfigSheetMetrics(page, sheetSelector = ".mobile-config-sheet.open") {
  return await page.evaluate((selector) => {
    const sheet = document.querySelector(selector);
    const panel = sheet?.querySelector(".mobile-config-sheet-panel");
    const body = sheet?.querySelector(".mobile-config-sheet-body");
    const panelRect = panel?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const childRects = body
      ? [...body.children]
        .map((child) => child.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
      : [];
    const lastChildBottom = childRects.length ? Math.max(...childRects.map((rect) => rect.bottom)) : 0;
    return {
      viewportHeight: window.innerHeight,
      previousFixedHeight: Math.round(window.innerHeight * 0.76),
      panelHeight: panelRect ? Math.round(panelRect.height) : 0,
      panelBottom: panelRect ? Math.round(window.innerHeight - panelRect.bottom) : 0,
      bodyHeight: bodyRect ? Math.round(bodyRect.height) : 0,
      bodyScrollHeight: body ? Math.round(body.scrollHeight) : 0,
      bodyBottomGap: bodyRect && lastChildBottom ? Math.round(bodyRect.bottom - lastChildBottom) : 0,
      visibleChildren: childRects.length,
    };
  }, sheetSelector);
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
  parentWithChildTaskId = await createTask("Parent with child task", {
    owner_agent: "regression-agent",
    stage: "execute",
  });
  const childResult = await requestJson(`/api/tasks/${parentWithChildTaskId}/subtasks`, {
    method: "POST",
    body: {
      title: `Nested child task ${childLongToken}`,
      owner_agent: "regression-agent",
      required: false,
    },
    ok: [201],
  });
  childTaskId = childResult.task.id;
  const futureDailyAutomation = new Date(Date.now() + 60 * 60_000);
  await requestJson(`/api/tasks/${taskId}/automations`, {
    method: "POST",
    body: {
      trigger: {
        type: "daily",
        hour: futureDailyAutomation.getUTCHours(),
        minute: futureDailyAutomation.getUTCMinutes(),
      },
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
  const projectWorkdir = join(workspaceDir, "mobile-layout-project");
  mkdirSync(projectWorkdir, { recursive: true });
  writeFileSync(join(projectWorkdir, "AGENTS.md"), "Use AGENTS.md guidance in task prompts.\n");
  const project = await requestJson("/api/projects", {
    method: "POST",
    body: {
      name: "Mobile Layout Project",
      slug: "mobile-layout-project",
      description: "Seeded project for mobile read actions.",
      context: "This seeded project keeps the project read page populated for mobile chrome tests.",
      workdir: projectWorkdir,
      tags: ["mobile", "layout"],
    },
    ok: [201],
  });
  projectSlug = project.project.slug;
  const team = await requestJson("/api/teams", {
    method: "POST",
    body: {
      name: "Regression Team",
      slug: "regression-team",
      description: "Seeded team for route coverage.",
      goal: "Keep routed resources connected.",
      lead_agent: "regression-agent",
      members: [{ agent_name: "regression-agent", role_description: "Lead" }],
    },
    ok: [201],
  });
  teamSlug = team.team.slug;
  const goal = await requestJson("/api/goals", {
    method: "POST",
    body: {
      team_id: teamSlug,
      project_id: projectSlug,
      objective: "Keep the native Goals workspace usable with an intentionally long objective that should clamp instead of widening the list row or hiding page actions on a narrow viewport.",
      stopping_condition: "Mobile, tablet, and desktop route checks can inspect the same goal without horizontal overflow.",
      validation_loop: "Run the responsive UI regression suite and confirm goal actions stay reachable.",
      constraints: [
        "No hidden primary controls on mobile",
        "Long contract text wraps inside the detail surface",
      ],
    },
    ok: [201],
  });
  goalId = goal.goal.goal_id;

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
      (id, task_id, mode, agent_name, worker_pid, status, process_status, started_at, ended_at,
       exit_code, error_text, decision, summary, details, result_json)
     VALUES (?, ?, 'execute', 'regression-agent', NULL, 'complete', 'complete', ?, ?,
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
  const liveExistingEvents = [
    { type: "text", text: "Oldest preserved event", ts: now - 9_000, _event_seq: 1 },
    ...Array.from({ length: 25 }, (_, index) => ({
      type: "text",
      text: `Intermediate live event ${index + 2}`,
      ts: now - 8_900 + index,
      _event_seq: index + 2,
    })),
    { type: "text", text: "Existing streamed event", ts: now - 5_000, _event_seq: 27 },
    { type: "text", text: `Live unbroken token ${liveLongToken}`, ts: now - 4_950, _event_seq: 28 },
    { type: "tool_use", tool_use_id: "tool-live-existing", name: "shell", input: { cmd: "npm test" }, _event_seq: 29 },
    {
      type: "tool_use",
      tool_use_id: "tool-live-mobile-existing",
      name: "mcp__worklab__journal_append",
      input: { bullet: "confirming a mobile live preview value with enough text to require truncation" },
      _event_seq: 30,
    },
  ];
  db.prepare(
    `INSERT INTO agent_logs
      (id, task_run_id, events, model, effort, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, num_turns, status, created_at)
     VALUES (?, ?, ?, 'test-model', 'medium', 1, 1, 0, 0, 0, NULL, 1, 'running', ?)`,
  ).run(
    "log-live-existing",
    "run-live-existing",
    JSON.stringify(liveExistingEvents),
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
      (id, task_id, mode, agent_name, worker_pid, status, process_status, failure_kind,
       started_at, ended_at, exit_code, error_text, warnings_json, diagnostics_json)
     VALUES (?, ?, 'execute', 'regression-agent', NULL, 'error', 'failed', 'provider_error',
       ?, ?, 1, ?, ?, ?)`,
  ).run(
    "run-desktop-error-existing",
    desktopErroredTaskId,
    now - 14_000,
    now - 11_000,
    `Seeded desktop failure ${errorLongToken}`,
    JSON.stringify([{
      kind: "runtime_warning_long",
      source: errorLongToken,
      message: `Runtime warning carried a long provider payload ${errorLongToken}`,
    }]),
    JSON.stringify({
      provider_error_subkind: `subkind_${errorLongToken}`,
      error_details: {
        last_text_excerpt: `Provider returned a long unbroken failure excerpt ${errorLongToken}`,
        last_tool_name: `tool_${errorLongToken}`,
        stderr_tail: `stderr tail ${errorLongToken}`,
      },
    }),
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

test("commander lists tasks grouped by runtime state", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();
  await expect(page.locator(".commander-row", { hasText: "Desktop done task" })).toHaveCount(0);
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

test("commander toggles completed tasks inline", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();
  await expect(page.locator(".commander-row", { hasText: "Desktop done task" })).toHaveCount(0);

  await expect(page.locator(".commander-topbar .commander-hidden-completed")).toHaveCount(0);
  const showCompleted = page.locator(".commander-list-footer .commander-hidden-completed", { hasText: "Show completed" });
  await expect(showCompleted).toBeVisible();
  await showCompleted.click();

  await expect(page).toHaveURL(/show_completed=1/);
  await expect(page.locator(".commander-group-header", { hasText: "Completed" })).toBeVisible();
  await expect(page.locator(".commander-row", { hasText: "Desktop done task" })).toBeVisible();

  const hideCompleted = page.locator(".commander-list-footer .commander-hidden-completed", { hasText: "Hide completed" });
  await expect(hideCompleted).toBeVisible();
  await hideCompleted.click();

  await expect(page).not.toHaveURL(/show_completed=1/);
  await expect(page.locator(".commander-row", { hasText: "Desktop done task" })).toHaveCount(0);
});

test("commander returns from task detail without getting stuck on loading", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${baseUrl}/#/tasks`, { waitUntil: "domcontentloaded" });
  const row = page.locator(".commander-row", { hasText: "UI regression task" }).first();
  await expect(row).toBeVisible();

  await row.click();
  await expect(page).toHaveURL(/#\/tasks\/[^/?#]+$/);
  await expect(page.locator(".task-hero-title", { hasText: "UI regression task" })).toBeVisible();

  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.getByText("Loading tasks…")).toHaveCount(0);
  await expect(page.locator(".commander-row", { hasText: "UI regression task" }).first()).toBeVisible();

  expect(pageErrors).toEqual([]);
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
    { title: "Desktop blocked task", text: "Waiting on 1" },
    { title: "Desktop running task", text: "Execute" },
    { title: "Desktop running task", text: "Desktop running event" },
    { title: "Desktop errored task", text: "Error" },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/#/tasks`);
    await expect(page.locator(".commander-row").first()).toBeVisible();

    for (const label of ["Running", "Needs attention", "Ready", "Waiting"]) {
      await expect(page.locator(".commander-group-header", { hasText: label })).toBeVisible();
    }
    await expect(page.locator(".commander-group-header", { hasText: "Completed" })).toHaveCount(0);
    for (const row of stateRows) {
      await expect(page.locator(".commander-row", { hasText: row.title })).toContainText(row.text);
    }
    const rowLayoutMetrics = await page.evaluate(() => {
      const reviewRow = [...document.querySelectorAll(".commander-row")]
        .find((row) => row.textContent?.includes("Desktop review task"));
      const runningRow = [...document.querySelectorAll(".commander-row")]
        .find((row) => row.textContent?.includes("Desktop running task"));
      const blockedRow = [...document.querySelectorAll(".commander-row")]
        .find((row) => row.textContent?.includes("Desktop blocked task"));
      const cells = [...document.querySelectorAll(".commander-row .commander-cell-state")];
      const assignees = reviewRow?.querySelector(".commander-cell-assignees");
      const arrows = [...(assignees?.querySelectorAll(".commander-cell-arrow") || [])];
      const avatars = [...(assignees?.querySelectorAll(".agent-avatar") || [])];
      const assigneeRect = assignees?.getBoundingClientRect();
      const avatarBounds = avatars.map((avatar) => avatar.getBoundingClientRect());
      const title = reviewRow?.querySelector(".commander-cell-title")?.getBoundingClientRect();
      const runningStage = runningRow?.querySelector(".commander-cell-pill .stage-token");
      const blockedDeps = blockedRow?.querySelector(".commander-cell-deps");
      const runningAge = runningRow?.querySelector(".commander-cell-age")?.getBoundingClientRect();
      const blockedAge = blockedRow?.querySelector(".commander-cell-age")?.getBoundingClientRect();
      const runningStageRect = runningStage?.getBoundingClientRect();
      return {
        visibleStateCells: cells.filter((cell) => getComputedStyle(cell).display !== "none").length,
        assigneeDisplay: assignees ? getComputedStyle(assignees).display : "",
        avatarCount: avatars.length,
        arrowCount: arrows.length,
        assigneeWidth: assigneeRect ? Math.round(assigneeRect.width) : 0,
        avatarLeft: avatarBounds.length ? Math.round(Math.min(...avatarBounds.map((rect) => rect.left))) : 0,
        avatarRight: avatarBounds.length ? Math.round(Math.max(...avatarBounds.map((rect) => rect.right))) : 0,
        titleRight: title ? Math.round(title.right) : 0,
        runningStageText: (runningStage?.textContent || "").replace(/\s+/g, " ").trim(),
        blockedDepsText: (blockedDeps?.textContent || "").replace(/\s+/g, " ").trim(),
        runningStageLeft: runningStageRect ? Math.round(runningStageRect.left) : 0,
        runningAgeRight: runningAge ? Math.round(runningAge.right) : 0,
        blockedAgeRight: blockedAge ? Math.round(blockedAge.right) : 0,
      };
    });
    expect(rowLayoutMetrics.visibleStateCells).toBe(0);
    expect(rowLayoutMetrics.assigneeDisplay).toBe("flex");
    expect(rowLayoutMetrics.avatarCount).toBe(3);
    expect(rowLayoutMetrics.arrowCount).toBe(2);
    expect(rowLayoutMetrics.assigneeWidth).toBeGreaterThanOrEqual(84);
    expect(rowLayoutMetrics.avatarLeft).toBeGreaterThanOrEqual(rowLayoutMetrics.titleRight);
    expect(rowLayoutMetrics.avatarRight).toBeLessThanOrEqual(rowLayoutMetrics.runningStageLeft);
    expect(rowLayoutMetrics.runningStageText).toContain("Execute");
    expect(rowLayoutMetrics.blockedDepsText).toContain("Waiting on 1");
    expect(Math.abs(rowLayoutMetrics.runningAgeRight - rowLayoutMetrics.blockedAgeRight)).toBeLessThanOrEqual(2);

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
  await page.goto(`${baseUrl}/#/library/knowledge/welcome`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Welcome guide" })).toBeVisible();
  await expect(page.locator(".knowledge-read-markdown h1", { hasText: "Welcome" })).toBeVisible();
  await expect(page.locator(".knowledge-detail-body textarea")).toHaveCount(0);

  await page.locator(".pane-detail-head .button", { hasText: "Edit" }).click();
  await expect(page).toHaveURL(/#\/knowledge\/welcome\/edit$/);
  await expect(page.locator(".knowledge-detail-body textarea")).toHaveValue(/nested KB route shape/);
});

test("agents two-pane: clicking a list row selects inline editor via URL", async ({ page }) => {
  await page.goto(`${baseUrl}/#/library/agents/new`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "New agent" })).toBeVisible();
});

test("agent profile availability stays grouped after identity fields", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/#/library/agents/new`);
  await expect(page.locator(".agent-profile-grid")).toBeVisible();

  const fields = await page.locator(".agent-profile-grid").evaluate((grid) => {
    return Array.from(grid.children).map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        text: (child.textContent || "").replace(/\s+/g, " ").trim(),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      };
    });
  });

  expect(fields).toHaveLength(3);
  expect(fields[0].text).toContain("Display name");
  expect(fields[1].text).toContain("Description");
  expect(fields[2].text).toContain("Available for assignment");
  expect(fields[1].top).toBeGreaterThanOrEqual(fields[0].top);
  expect(fields[2].top).toBeGreaterThan(fields[1].top);
  expect(fields[2].left).toBe(fields[0].left);
  expect(fields[2].right).toBeGreaterThanOrEqual(Math.max(fields[0].right, fields[1].right));
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
  expect(metrics.railWidth).toBeGreaterThanOrEqual(340);
});

test("new task creation keeps title, project, owner, and instructions in the primary form", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(`${baseUrl}/#/tasks/new`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();

  const metrics = await page.evaluate(() => {
    const main = document.querySelector(".task-edit-main");
    const rail = document.querySelector(".task-edit-rail");
    const mainLabels = [...(main?.querySelectorAll(".form-field-label") || [])]
      .map((label) => (label.textContent || "").replace("*", "").trim());
    const railLabels = [...(rail?.querySelectorAll(".form-field-label") || [])]
      .map((label) => (label.textContent || "").replace("*", "").trim());
    const labelRects = Object.fromEntries(
      [...(main?.querySelectorAll(".form-field-label") || [])].map((label) => {
        const text = (label.textContent || "").replace("*", "").trim();
        const rect = label.getBoundingClientRect();
        return [text, { top: Math.round(rect.top), left: Math.round(rect.left) }];
      }),
    );
    return {
      mainLabels,
      railLabels,
      titleBeforeProject: labelRects.Title && labelRects.Project
        ? labelRects.Title.top <= labelRects.Project.top
        : false,
      projectBeforeOwner: labelRects.Project && labelRects.Owner
        ? labelRects.Project.top <= labelRects.Owner.top
        : false,
      ownerBeforeInstructions: labelRects.Owner && labelRects.Instructions
        ? labelRects.Owner.top <= labelRects.Instructions.top
        : false,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(metrics.mainLabels.slice(0, 4)).toEqual(["Title", "Project", "Owner", "Instructions"]);
  expect(metrics.mainLabels).not.toContain("Depends on");
  expect(metrics.railLabels).not.toContain("Project");
  expect(metrics.railLabels).not.toContain("Owner");
  expect(metrics.railLabels).toContain("Initial stage");
  expect(metrics.railLabels).toContain("Depends on");
  expect(metrics.titleBeforeProject).toBe(true);
  expect(metrics.projectBeforeOwner).toBe(true);
  expect(metrics.ownerBeforeInstructions).toBe(true);
  expect(metrics.overflow).toBeLessThanOrEqual(0);
});

test("mobile new task shows primary creation fields without opening settings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks/new`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();

  const metrics = await page.evaluate(() => {
    const main = document.querySelector(".task-edit-main");
    const labels = [...(main?.querySelectorAll(".form-field-label") || [])]
      .map((label) => {
        const rect = label.getBoundingClientRect();
        return {
          text: (label.textContent || "").replace("*", "").trim(),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          display: getComputedStyle(label).display,
        };
      });
    const byText = Object.fromEntries(labels.map((label) => [label.text, label]));
    const rail = document.querySelector(".task-edit-rail");
    const dock = document.querySelector(".app-mobile-action-dock");
    return {
      labels: labels.map((label) => label.text),
      railDisplay: rail ? getComputedStyle(rail).display : "",
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      ordered:
        byText.Title?.top <= byText.Project?.top
        && byText.Project?.top <= byText.Owner?.top
        && byText.Owner?.top <= byText.Instructions?.top,
      primaryFieldsVisible: ["Title", "Project", "Owner", "Instructions"].every((label) => byText[label]?.display !== "none"),
      instructionsStartsBeforeDock: byText.Instructions && dock
        ? byText.Instructions.top < dock.getBoundingClientRect().top
        : false,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(metrics.labels.slice(0, 4)).toEqual(["Title", "Project", "Owner", "Instructions"]);
  expect(metrics.primaryFieldsVisible).toBe(true);
  expect(metrics.ordered).toBe(true);
  expect(metrics.instructionsStartsBeforeDock).toBe(true);
  expect(metrics.railDisplay).toBe("none");
  expect(metrics.dockDisplay).toBe("flex");
  expect(metrics.overflow).toBeLessThanOrEqual(0);
});

test("new task can prefill project from route query without a dirty-leave prompt", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/new?project=${projectSlug}`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();
  await expect(page.locator(".task-edit-main .select-trigger", { hasText: "Mobile Layout Project" })).toBeVisible();

  await page.locator(".task-edit-toolbar .button", { hasText: "Cancel" }).click();
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.locator(".modal", { hasText: "unsaved" })).toHaveCount(0);
});

test("project-filtered task creation opens a project-prefilled task form", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(`${baseUrl}/#/tasks?project=${projectSlug}`);
  await expect(page.locator(".commander-new-task-inline")).toBeVisible();
  await page.locator(".commander-new-task-inline").click();

  await expect(page).toHaveURL(new RegExp(`#\\/tasks\\/new\\?project=${projectSlug}`));
  await expect(page.locator(".task-edit-main .select-trigger", { hasText: "Mobile Layout Project" })).toBeVisible();
});

test("project detail new task action opens a project-prefilled task form", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(`${baseUrl}/#/projects/${projectSlug}`);
  await expect(page.locator(".project-detail-head h2", { hasText: "Mobile Layout Project" })).toBeVisible();
  await page.locator(".project-detail-head .button", { hasText: "New task" }).click();

  await expect(page).toHaveURL(new RegExp(`#\\/tasks\\/new\\?project=${projectSlug}`));
  await expect(page.locator(".task-edit-main .select-trigger", { hasText: "Mobile Layout Project" })).toBeVisible();
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
  const railWidth = await page.locator(".task-detail").evaluate((node) => {
    const columns = getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean);
    return Math.round(parseFloat(columns.at(-1) || "0"));
  });
  expect(railWidth).toBeGreaterThanOrEqual(340);
});

test("task detail polish keeps details, agent picker, and newest-first comments clear", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-detail-tile")).toHaveCount(0);
  await expect(page.locator(".task-metadata-card .task-meta-list dt")).toHaveCount(5);
  await expect(page.locator(".task-metadata-card .task-meta-list dt", { hasText: "Completed" })).toHaveCount(0);
  await expect(page.locator(".task-metadata-card .task-meta-list dt", { hasText: "Workdir" })).toBeVisible();
  await expect(page.locator(".task-metadata-card .task-meta-list dt", { hasText: "Run mode" })).toBeVisible();
  await expect(page.locator(".task-metadata-card .task-meta-list dt", { hasText: "Next scheduled run" })).toBeVisible();
  const metadata = await page.locator(".task-metadata-card .task-meta-list").evaluate((list) => {
    const entries = {};
    const nodes = Array.from(list.children);
    for (let i = 0; i < nodes.length; i += 2) {
      entries[(nodes[i].textContent || "").trim()] = (nodes[i + 1]?.textContent || "").replace(/\s+/g, " ").trim();
    }
    return entries;
  });
  expect(metadata.Updated).toMatch(/^(now|\d+[mhd] ago)$/);
  expect(metadata.Created).toMatch(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})? · (now|\d+[mhd] ago)$/);
  expect(metadata["Next scheduled run"]).toMatch(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})? · (soon|in \d+[mhd]|\d+[mhd] ago|now)$/);
  expect(metadata["Run mode"]).toBe("Manual");
  await expect(page.locator(".task-detail-rail")).not.toContainText("Not done");
  await expect(page.locator(".task-metadata-card")).toContainText("Edited files");
  await expect(page.locator(".task-metadata-card")).toContainText("TaskDetail.jsx");
  await expect(page.locator(".task-metadata-card")).toContainText("+10 -2");
  await expect(page.locator(".run-artifacts-card")).toHaveCount(0);
  await expect(page.locator(".rail-agent-row")).toHaveCount(3);
  const railAgentBorderWidths = await page.locator(".rail-agent-row").evaluateAll((rows) => (
    rows.map((row) => {
      const style = getComputedStyle(row);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    })
  ));
  expect(railAgentBorderWidths.flat()).toEqual(Array(12).fill("0px"));
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

test("agent references in messages and avatars navigate to agent editor", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const db = new Database(join(dataDir, "worklab.db"));
  db.prepare(
    `INSERT OR REPLACE INTO task_comments
      (id, task_id, author_type, author_id, body, created_at)
     VALUES (?, ?, 'system', NULL, ?, ?)`,
  ).run(
    "comment-agent-budget-link",
    taskId,
    "ERROR: Parent resume failed: Daily budget for Regression Agent reached ($59.7195 of $50.00).",
    Date.now(),
  );
  db.close();

  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  const messageLink = page
    .locator(".activity-feed-entry.comment.system", { hasText: "Daily budget" })
    .locator("a[href='#/library/agents/regression-agent']", { hasText: "Regression Agent" })
    .first();
  await expect(messageLink).toHaveAttribute("href", "#/library/agents/regression-agent");
  await messageLink.click();
  await expect(page).toHaveURL(/#\/agents\/regression-agent$/);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Regression Agent" })).toBeVisible();

  await page.goto(`${baseUrl}/#/tasks`);
  const taskRow = page.locator(".commander-row", { hasText: "UI regression task" }).first();
  await expect(taskRow).toBeVisible();
  const avatarLink = taskRow.locator(".commander-cell-assignees .agent-link[aria-label='Regression Agent']").first();
  await expect(avatarLink).toHaveAttribute("href", "#/library/agents/regression-agent");
  await avatarLink.click();
  await expect(page).toHaveURL(/#\/agents\/regression-agent$/);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Regression Agent" })).toBeVisible();
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
      status: "Execute",
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
      const widthMetrics = await page.locator(".task-detail-shell").evaluate((node) => {
        const detail = node.querySelector(".task-detail");
        const main = node.querySelector(".task-detail-main");
        return {
          shellWidth: Math.round(node.getBoundingClientRect().width),
          detailWidth: Math.round(detail?.getBoundingClientRect().width || 0),
          mainBorderRight: main ? getComputedStyle(main).borderRightWidth : null,
        };
      });
      expect(widthMetrics.detailWidth, `${viewport.label} ${state.label} detail uses available width`).toBeGreaterThan(0);
      expect(Math.abs(widthMetrics.detailWidth - widthMetrics.shellWidth), `${viewport.label} ${state.label} detail full width`).toBeLessThanOrEqual(2);
      expect(widthMetrics.mainBorderRight, `${viewport.label} ${state.label} editor main divider`).toBe("0px");
      const shellLayout = await page.locator(".task-detail-shell").evaluate((node) => {
        const head = node.querySelector(".detail-head");
        const detail = node.querySelector(".task-detail");
        const brief = node.querySelector("#task-brief");
        const briefContent = node.querySelector(".task-hero-instructions");
        const plan = node.querySelector("#task-plan");
        const planContent = node.querySelector(".task-plan-card");
        const status = node.querySelector(".task-hero-status-row");
        if (!head || !detail || !brief || !briefContent || !plan || !planContent || !status) return { missing: true };
        const headRect = head.getBoundingClientRect();
        const detailRect = detail.getBoundingClientRect();
        const briefRect = brief.getBoundingClientRect();
        const briefContentRect = briefContent.getBoundingClientRect();
        const planRect = plan.getBoundingClientRect();
        const planContentRect = planContent.getBoundingClientRect();
        const statusRect = status.getBoundingClientRect();
        return {
          missing: false,
          detailStartsAfterHeader: Math.round(detailRect.top - headRect.bottom),
          headerToBriefGap: Math.round(briefRect.top - headRect.bottom),
          briefMarkerToContentGap: Math.round(briefContentRect.top - briefRect.bottom),
          planMarkerToContentGap: Math.round(planContentRect.top - planRect.bottom),
          statusBottomDelta: Math.ceil(statusRect.bottom - headRect.bottom),
        };
      });
      expect(shellLayout.missing, `${viewport.label} ${state.label} shell layout nodes`).toBe(false);
      expect(shellLayout.detailStartsAfterHeader, `${viewport.label} ${state.label} detail starts after header`).toBeGreaterThanOrEqual(0);
      expect(shellLayout.statusBottomDelta, `${viewport.label} ${state.label} status row stays inside header`).toBeLessThanOrEqual(0);
      expect(shellLayout.headerToBriefGap, `${viewport.label} ${state.label} header-to-brief gap`).toBeGreaterThanOrEqual(48);
      expect(shellLayout.briefMarkerToContentGap, `${viewport.label} ${state.label} brief content gap`).toBe(shellLayout.planMarkerToContentGap);
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

test("task detail wraps long run warning and failure details", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${baseUrl}/#/tasks/${desktopErroredTaskId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".task-hero-title", { hasText: "Desktop errored task" })).toBeVisible();
  await expect(page.locator(".run-warning-badge", { hasText: "1" })).toBeVisible();
  await page.locator(".run-card-summary").first().click();
  await expect(page.locator(".run-warnings-list", { hasText: errorLongToken })).toBeVisible();
  await expect(page.locator(".run-failure-details", { hasText: errorLongToken })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const bounded = [
      ".run-warning-message",
      ".run-failure-row dd",
      ".run-failure-snippet",
      ".run-failure-stderr",
    ].flatMap((selector) => [...document.querySelectorAll(selector)].map((node) => {
      const style = getComputedStyle(node);
      return {
        selector,
        overflowWrap: style.overflowWrap,
        right: Math.ceil(node.getBoundingClientRect().right),
        clientWidth: Math.ceil(node.clientWidth),
        scrollWidth: Math.ceil(node.scrollWidth),
      };
    }));
    const warningSources = [...document.querySelectorAll(".run-warning-source")].map((node) => {
      const style = getComputedStyle(node);
      return {
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
        right: Math.ceil(node.getBoundingClientRect().right),
      };
    });
    const badge = document.querySelector(".run-warning-badge");
    const badgeStyle = badge ? getComputedStyle(badge) : null;
    return {
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      viewportWidth: window.innerWidth,
      bounded,
      warningSources,
      badge: badge ? {
        overflow: badgeStyle.overflow,
        textOverflow: badgeStyle.textOverflow,
        right: Math.ceil(badge.getBoundingClientRect().right),
      } : null,
    };
  });

  expect(metrics.pageOverflow).toBeLessThanOrEqual(0);
  expect(metrics.badge).toMatchObject({ overflow: "hidden", textOverflow: "ellipsis" });
  expect(metrics.badge.right).toBeLessThanOrEqual(metrics.viewportWidth);
  for (const item of metrics.warningSources) {
    expect(item).toMatchObject({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    expect(item.right).toBeLessThanOrEqual(metrics.viewportWidth);
  }
  for (const item of metrics.bounded) {
    expect(item.overflowWrap, item.selector).toBe("anywhere");
    expect(item.right, item.selector).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(item.scrollWidth, item.selector).toBeLessThanOrEqual(item.clientWidth + 1);
  }
});

test("task detail context shows completion and run mode", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${completedTaskId}`);
  await expect(page.locator(".task-metadata-card .task-meta-list dt", { hasText: "Completed" })).toBeVisible();
  await expect(page.locator(".task-metadata-card .task-meta-list")).toContainText("Auto");
});

test("task detail shows linked dependencies when the graph exists", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${blockedTaskId}`);
  await expect(page.locator(".task-metadata-card")).toContainText("Dependencies");
  await expect(page.locator(".task-metadata-card")).toContainText("Blocked by");
  await expect(page.locator(".blocked-link", { hasText: "Dependency blocker" })).toBeVisible();
});

test("task detail live panel hydrates existing run events", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${runningTaskId}`);
  await expect(page.locator(".task-hero-status-row .live-pulse")).toHaveCount(0);
  await expect(page.locator(".task-hero-status-row .status-menu-trigger")).toContainText("Execute");
  await expect(page.locator(".task-hero-status-row .stage-token")).toHaveClass(/stage-token-pulse/);
  const stageTokenAnimation = await page.locator(".task-hero-status-row .stage-token-glyph").evaluate((node) => {
    return getComputedStyle(node).animationName;
  });
  expect(stageTokenAnimation).toBe("wl-stage-token-pulse");
  await expect(page.locator(".task-live-panel", { hasText: "Existing streamed event" })).toBeVisible();
  const longLiveEvent = page.locator(".task-live-panel .agentlog-event-text", { hasText: liveLongToken });
  await expect(longLiveEvent).toBeVisible();
  const longLiveMetrics = await longLiveEvent.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      clientWidth: Math.ceil(node.clientWidth),
      scrollWidth: Math.ceil(node.scrollWidth),
      overflowWrap: style.overflowWrap,
    };
  });
  expect(longLiveMetrics.overflowWrap).toBe("anywhere");
  expect(longLiveMetrics.scrollWidth).toBeLessThanOrEqual(longLiveMetrics.clientWidth + 1);
  await expect(page.locator(".task-live-header .live-pulse")).toHaveCount(0);
  await expect(page.locator(".task-live-header .status-pill")).toHaveCount(1);
  await expect(page.locator(".task-live-header .status-pill")).toContainText("Running");
  await expect(page.locator(".task-live-panel .tool-call", { hasText: "shell" })).toBeVisible();
  const toolCallProgress = page.locator(".task-live-panel .tool-call-progress").first();
  await expect(toolCallProgress).toBeVisible();
  const toolCallAnimation = await toolCallProgress.evaluate((node) => {
    return getComputedStyle(node).animationName;
  });
  expect(toolCallAnimation).toBe("wl-shimmer");
  const toolCallSpinnerAnimation = await page.locator(".task-live-panel .tool-call-spinner").first().evaluate((node) => {
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

test("running task detail can load full history after compact live hydration", async ({ page }) => {
  const runRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/runs/run-live-existing") {
      runRequests.push(`${url.pathname}${url.search}`);
    }
  });

  await page.goto(`${baseUrl}/#/tasks/${runningTaskId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading task…")).toHaveCount(0);
  await expect(page.locator(".task-live-panel", { hasText: "Existing streamed event" })).toBeVisible();
  await expect(page.locator(".task-live-panel", { hasText: "Showing latest logs" })).toBeVisible();
  await expect(page.locator(".task-live-panel", { hasText: /Showing latest \d+ of \d+ events/ })).toHaveCount(0);
  await expect(page.locator(".task-live-panel", { hasText: "Oldest preserved event" })).toHaveCount(0);

  await page.getByRole("button", { name: "Load full history" }).click();
  await expect(page.locator(".task-live-panel", { hasText: "Oldest preserved event" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load full history" })).toHaveCount(0);

  expect(runRequests).toEqual([
    "/api/runs/run-live-existing?events=tail&limit=10",
    "/api/runs/run-live-existing",
  ]);
});

test("task detail shows an optimistic running state while start-run reload is pending", async ({ page }) => {
  const mockedTaskId = "mock-start-task";
  const now = Date.now();
  const idleDetail = {
    task: {
      id: mockedTaskId,
      task_key: "T-MOCK",
      title: "Mock start task",
      description: "Mocked detail for start transition",
      stage: "execute",
      owner_agent: "regression-agent",
      reviewer_agent: "reviewer-agent",
      planner_agent: null,
      run_policy: "manual",
      running_run_id: null,
      running_run_started_at: null,
      running_run: null,
      plan_body: "",
      tags: [],
      dependency_ids: [],
      blocked_by: [],
      blocks: [],
      children: [],
      automations: [],
      automation_summary: { count: 0, enabled_count: 0, paused_count: 0, next_fire_at: null, last_trigger: null },
      artifacts: [],
      artifact_summary: {},
      created_at: now,
      updated_at: now,
    },
    comments: [],
    runs: [],
  };
  const startedAt = Date.now();
  const runningRun = {
    id: "run-optimistic-start",
    task_id: idleDetail.task.id,
    task_key: idleDetail.task.task_key,
    mode: "execute",
    stage: "execute",
    status: "running",
    process_status: "running",
    started_at: startedAt,
    agent_name: "regression-agent",
    live_input: { supported: false, active: false, reason: "unsupported_provider" },
  };
  const authoritativeDetail = {
    ...idleDetail,
    task: {
      ...idleDetail.task,
      running_run_id: runningRun.id,
      running_run_started_at: startedAt,
      running_run: runningRun,
    },
    runs: [runningRun],
  };
  let releaseDetailReload;
  let detailReloadRequested = false;
  let delayDetailReload = false;
  const detailReloadGate = new Promise((resolveGate) => { releaseDetailReload = resolveGate; });

  await page.route(`**/api/tasks/${mockedTaskId}/automations`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ automations: [] }),
    });
  });
  await page.route(`**/api/tasks/${mockedTaskId}/run`, async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ runId: runningRun.id }),
    });
  });
  await page.route(`**/api/tasks/${mockedTaskId}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (!delayDetailReload) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(idleDetail),
      });
      return;
    }
    detailReloadRequested = true;
    await detailReloadGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(authoritativeDetail),
    });
  });
  await page.route(`**/api/runs/${runningRun.id}?**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: runningRun,
        log: { events: [], event_count: 0, events_truncated: false },
      }),
    });
  });
  await page.route(`**/api/runs/${runningRun.id}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: ": connected\n\n",
    });
  });

  await page.goto(`${baseUrl}/#/tasks/${mockedTaskId}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".task-hero-title", { hasText: "Mock start task" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run work" })).toBeVisible();
  delayDetailReload = true;

  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((node) => (node.textContent || "").trim() === "Run work");
    if (!button) throw new Error("Run work button not found");
    button.click();
  });
  await expect.poll(() => detailReloadRequested).toBe(true);
  await expect(page.getByText("Loading task…")).toHaveCount(0);
  const statusTrigger = page.locator(".task-hero-status-row .status-menu-trigger");
  await expect(statusTrigger).toContainText("Execute");
  await expect(statusTrigger.locator(".stage-token-pulse")).toBeVisible();
  await expect(page.locator(".task-live-panel")).toBeVisible();

  releaseDetailReload();
  await expect(page.locator(".task-live-panel")).toBeVisible();
});

test("multi-tab task detail shares live streams and keeps task list navigation responsive", async ({ page, context }) => {
  const activeStreams = new Map();
  const maxActiveByPath = new Map();
  function streamPath(request) {
    const url = new URL(request.url());
    if (url.pathname === "/api/events/stream") return url.pathname;
    if (url.pathname === "/api/runs/run-live-existing/stream") return url.pathname;
    return null;
  }
  function updateMax() {
    const counts = new Map();
    for (const path of activeStreams.values()) counts.set(path, (counts.get(path) || 0) + 1);
    for (const [path, count] of counts.entries()) {
      maxActiveByPath.set(path, Math.max(maxActiveByPath.get(path) || 0, count));
    }
  }
  context.on("request", (request) => {
    const path = streamPath(request);
    if (!path) return;
    activeStreams.set(request, path);
    updateMax();
  });
  const clearRequest = (request) => {
    if (!activeStreams.delete(request)) return;
    updateMax();
  };
  context.on("requestfailed", clearRequest);
  context.on("requestfinished", clearRequest);

  const pages = [page];
  for (let i = 0; i < 4; i += 1) {
    const current = i === 0 ? page : await context.newPage();
    if (i > 0) pages.push(current);
    await current.goto(`${baseUrl}/#/tasks/${runningTaskId}`, { waitUntil: "domcontentloaded" });
    await expect(current.locator(".task-live-panel")).toBeVisible();
  }

  const listPage = await context.newPage();
  pages.push(listPage);
  await listPage.goto(`${baseUrl}/#/tasks`, { waitUntil: "domcontentloaded", timeout: 8_000 });
  await expect(listPage.getByText("Loading tasks…")).toHaveCount(0, { timeout: 5_000 });

  expect(maxActiveByPath.get("/api/events/stream") || 0).toBeLessThanOrEqual(1);
  expect(maxActiveByPath.get("/api/runs/run-live-existing/stream") || 0).toBeLessThanOrEqual(1);

  for (const extraPage of pages.slice(1)) await extraPage.close();
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
  await page.goto(`${baseUrl}/#/runs`);
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

test("task detail hides empty subtask controls and keeps automation checkboxes aligned", async ({ page }) => {
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-subtasks-card")).toHaveCount(0);
  await expect(page.locator(".task-subtasks-add")).toHaveCount(0);
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
      enabled: centerDelta(".task-automation-form .checkbox"),
    };
  });

  expect(deltas.enabled).toBeLessThanOrEqual(2);
});

test("task detail shows existing child tasks without manual add controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${baseUrl}/#/tasks/${parentWithChildTaskId}`);
  await expect(page.locator(".task-subtasks-card")).toBeVisible();
  await expect(page.locator(".task-subtask-link", { hasText: "Nested child task" })).toBeVisible();
  const childLinkMetrics = await page.locator(".task-subtask-link", { hasText: "Nested child task" }).evaluate((node) => {
    const title = node.querySelector(".task-subtask-title");
    const meta = node.querySelector(".task-subtask-meta");
    const titleStyle = title ? getComputedStyle(title) : null;
    const metaStyle = meta ? getComputedStyle(meta) : null;
    return {
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      linkRight: Math.ceil(node.getBoundingClientRect().right),
      viewportWidth: window.innerWidth,
      titleWhiteSpace: titleStyle?.whiteSpace || "",
      titleScrollHeight: title ? Math.ceil(title.scrollHeight) : 0,
      titleHeight: title ? Math.ceil(title.getBoundingClientRect().height) : 0,
      metaWhiteSpace: metaStyle?.whiteSpace || "",
      metaFlexWrap: metaStyle?.flexWrap || "",
    };
  });
  expect(childLinkMetrics.pageOverflow).toBeLessThanOrEqual(0);
  expect(childLinkMetrics.linkRight).toBeLessThanOrEqual(childLinkMetrics.viewportWidth);
  expect(childLinkMetrics.titleWhiteSpace).toBe("nowrap");
  expect(childLinkMetrics.titleScrollHeight).toBeLessThanOrEqual(childLinkMetrics.titleHeight + 1);
  expect(childLinkMetrics.metaWhiteSpace).toBe("normal");
  expect(childLinkMetrics.metaFlexWrap).toBe("wrap");
  await expect(page.locator(".task-subtasks-add")).toHaveCount(0);
  await expect(page.locator(".task-subtasks-empty")).toHaveCount(0);
});

test("child task detail pins parent reference below the header", async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${baseUrl}/#/tasks/${childTaskId}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".task-hero-title", { hasText: "Nested child task" })).toBeVisible();
    await expect(page.locator(".task-parent-reference", { hasText: "Parent" })).toBeVisible();
    await expect(page.locator(".task-parent-reference", { hasText: "Parent with child task" })).toBeVisible();
    await expect(page.locator(".task-workflow-parent")).toHaveCount(0);

    const metrics = await page.locator(".task-detail-shell").evaluate((node) => {
      const head = node.querySelector(".detail-head");
      const parent = node.querySelector(".task-parent-reference");
      const brief = node.querySelector(".task-brief-section");
      const label = parent?.querySelector(".task-parent-reference-label");
      const key = parent?.querySelector(".task-parent-reference-key");
      const title = parent?.querySelector(".task-parent-reference-title");
      const status = parent?.querySelector(".status-pill");
      const item = (el) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          flexShrink: style.flexShrink,
          whiteSpace: style.whiteSpace,
          height: Math.round(rect.height),
          lineHeight: Number.parseFloat(style.lineHeight) || 0,
          webkitLineClamp: style.webkitLineClamp || "",
        };
      };
      const parentRect = parent?.getBoundingClientRect();
      const briefRect = brief?.getBoundingClientRect();
      return {
        missing: !head || !parent || !brief || !label || !key || !title || !status,
        parentAfterHeader: head && parent ? Math.round(parent.getBoundingClientRect().top - head.getBoundingClientRect().bottom) : -999,
        briefAfterParent: parent && brief ? Math.round(brief.getBoundingClientRect().top - parent.getBoundingClientRect().bottom) : -999,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        parentHeight: parentRect ? Math.round(parentRect.height) : 0,
        parentLeft: parentRect ? Math.round(parentRect.left) : 0,
        parentRight: parentRect ? Math.ceil(parentRect.right) : 0,
        briefLeft: briefRect ? Math.round(briefRect.left) : 0,
        briefRight: briefRect ? Math.ceil(briefRect.right) : 0,
        viewportWidth: window.innerWidth,
        label: item(label),
        key: item(key),
        title: item(title),
        status: item(status),
      };
    });

    expect(metrics.missing).toBe(false);
    expect(metrics.parentAfterHeader).toBeGreaterThanOrEqual(0);
    expect(metrics.parentAfterHeader).toBeLessThanOrEqual(16);
    expect(metrics.briefAfterParent).toBeGreaterThanOrEqual(0);
    expect(metrics.briefAfterParent).toBeLessThanOrEqual(28);
    expect(metrics.pageOverflow).toBeLessThanOrEqual(0);
    expect(metrics.parentHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.parentRight).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(Math.abs(metrics.parentLeft - metrics.briefLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.parentRight - metrics.briefRight)).toBeLessThanOrEqual(1);
    expect(metrics.label).toMatchObject({ flexShrink: "0", whiteSpace: "nowrap" });
    expect(metrics.key).toMatchObject({ flexShrink: "0", whiteSpace: "nowrap" });
    expect(metrics.status).toMatchObject({ flexShrink: "0", whiteSpace: "nowrap" });
    expect(metrics.title.whiteSpace).toBe("normal");
    expect(metrics.title.webkitLineClamp).toBe("2");
    expect(metrics.title.height).toBeLessThanOrEqual((metrics.title.lineHeight * 2) + 2);
  }

  await page.locator(".task-parent-reference").click();
  await expect(page.locator(".task-hero-title", { hasText: "Parent with child task" })).toBeVisible();
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

test("settings overview cards, section nav, and sections stay connected", async ({ page }) => {
  const labels = ["Service", "Agent runs", "Notifications", "Assistant", "Slack", "Search", "MCP tools"];

  await page.goto(`${baseUrl}/#/settings`);
  await expect(page.locator(".settings-sections")).toBeVisible();
  await expect(page.locator(".settings-overview-card")).toHaveCount(labels.length);
  await expect(page.locator(".settings-section-nav button")).toHaveCount(labels.length);
  for (const label of labels) {
    await expect(page.locator(".settings-overview-card", { hasText: label })).toBeVisible();
    await expect(page.locator(".settings-section-nav button", { hasText: label })).toBeVisible();
  }

  await page.locator(".settings-overview-card", { hasText: "MCP tools" }).click();
  await expect(page.locator('.settings-overview-card[aria-current="location"]')).toContainText("MCP tools");
  await expect(page.locator('.settings-section-nav button[aria-current="location"]')).toContainText("MCP tools");
  await page.waitForFunction((id) => {
    const section = document.getElementById(id);
    if (!section) return false;
    const rect = section.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  }, "settings-tools");

  await page.locator(".settings-section-nav button", { hasText: "Agent runs" }).click();
  await expect(page.locator('.settings-overview-card[aria-current="location"]')).toContainText("Agent runs");
  await expect(page.locator('.settings-section-nav button[aria-current="location"]')).toContainText("Agent runs");
  await page.waitForFunction((id) => {
    const section = document.getElementById(id);
    if (!section) return false;
    const rect = section.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  }, "settings-execution");
  await expectNoHorizontalOverflow(page, "settings connected nav desktop");

  const collapseAssistant = page.getByRole("button", { name: "Collapse assistant" });
  if (await collapseAssistant.count()) await collapseAssistant.first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/settings`);
  await expect(page.locator(".settings-sections")).toBeVisible();
  await expect(page.locator(".settings-overview-card")).toHaveCount(labels.length);
  await page.locator(".settings-overview-card", { hasText: "Search" }).click();
  await expect(page.locator('.settings-overview-card[aria-current="location"]')).toContainText("Search");
  await expect(page.locator('.settings-section-nav button[aria-current="location"]')).toContainText("Search");
  await expectNoHorizontalOverflow(page, "settings connected nav mobile");
});

test("settings dense layout controls stay grouped and unclipped", async ({ page }) => {
  async function visibleClipOffenders(scope) {
    return await page.evaluate((selector) => {
      return [...document.querySelectorAll(`${selector} *`)]
        .filter((el) => {
          if (["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(el.tagName)) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && style.overflowX !== "hidden"
            && style.overflowX !== "clip"
            && Math.ceil(el.scrollWidth) > Math.ceil(el.clientWidth) + 1;
        })
        .map((el) => ({
          tag: el.tagName,
          className: typeof el.className === "string" ? el.className : el.getAttribute("class") || "",
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
          clientWidth: Math.ceil(el.clientWidth),
          scrollWidth: Math.ceil(el.scrollWidth),
        }))
        .slice(0, 8);
    }, scope);
  }

  await page.setViewportSize({ width: 1100, height: 820 });
  await page.goto(`${baseUrl}/#/settings`);
  await expect(page.locator(".settings-sections")).toBeVisible();
  await page.locator("#settings-assistant summary", { hasText: "Budgets and recovery" }).click();
  await expect(page.locator("#settings-assistant .ds-control-group")).toHaveCount(5);
  await expect(page.locator("#settings-runtime .settings-note-grid-paths .settings-note")).toHaveCount(3);
  expect(await visibleClipOffenders("#settings-runtime, #settings-execution, #settings-assistant")).toEqual([]);
  await expectNoHorizontalOverflow(page, "settings dense controls desktop");

  const collapseAssistant = page.getByRole("button", { name: "Collapse assistant" });
  if (await collapseAssistant.count()) await collapseAssistant.first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/settings`);
  await expect(page.locator(".settings-sections")).toBeVisible();
  await page.locator("#settings-assistant summary", { hasText: "Budgets and recovery" }).click();
  await expect(page.locator("#settings-assistant .ds-control-group")).toHaveCount(5);
  const mobileGridColumns = await page.locator("#settings-assistant .ds-control-grid").first().evaluate((node) => {
    return getComputedStyle(node).gridTemplateColumns.split(" ").length;
  });
  expect(mobileGridColumns).toBe(2);
  expect(await visibleClipOffenders("#settings-runtime, #settings-execution, #settings-assistant")).toEqual([]);
  await expectNoHorizontalOverflow(page, "settings dense controls mobile");
});

test("destructive pane actions stay behind disclosure", async ({ page }) => {
	  for (const hash of [
	    "#/library/agents/regression-agent",
	    "#/library/knowledge/welcome/edit",
	    `#/settings/providers/${providerId}`,
	    `#/library/skills/${skillName}`,
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
  await page.goto(`${baseUrl}/#/library/skills/${skillName}`);
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
      hash: "#/library/agents/regression-agent",
      title: "Regression Agent",
      rowText: "Regression Agent",
      detailText: "regression-agent",
      entityEditor: true,
      flatBody: true,
    },
    {
      hash: `#/library/skills/${skillName}`,
      title: "Regression Skill",
      rowText: "Regression Skill",
      detailText: "On demand",
      entityEditor: true,
    },
    {
      hash: "#/library/knowledge/mobile-layout-reference",
      title: "Mobile layout reference",
      rowText: "Mobile layout reference",
      detailText: "mobile-layout-reference",
      readArticle: true,
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
      } else if (route.readArticle) {
        await expect(page.locator(".knowledge-read-layout")).toBeVisible();
        await expect(page.locator(".knowledge-read-markdown")).toBeVisible();
        await expect(page.locator(".knowledge-read-rail .card-title").first()).toBeVisible();
      } else {
        await expect(page.locator(".pane-detail-body > .form-section").first()).toBeVisible();
      }

      const paneMetrics = await page.evaluate(({ entityEditor, flatBody, readArticle }) => {
        const row = document.querySelector(".pane-row.active");
        const detailHead = document.querySelector(".pane-detail-head");
        const body = document.querySelector(".pane-detail-body");
        const list = document.querySelector(".pane-list");
        const title = detailHead?.querySelector("h2");
        const formSection = readArticle
          ? document.querySelector(".knowledge-read-article")
          : entityEditor
          ? document.querySelector(".entity-editor-main > .form-section")
          : document.querySelector(".pane-detail-body > .form-section");
        const editor = readArticle
          ? document.querySelector(".knowledge-read-layout")
          : document.querySelector(".entity-editor-layout");
        const sectionStyle = formSection ? getComputedStyle(formSection) : null;
        const capabilityPanel = flatBody ? document.querySelector(".agent-editor-layout .capability-panel") : null;
        const capabilityStyle = capabilityPanel ? getComputedStyle(capabilityPanel) : null;
        return {
          rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
          headHeight: detailHead ? Math.round(detailHead.getBoundingClientRect().height) : 0,
          bodyStartsAfterHead: detailHead && body
            ? Math.round(body.getBoundingClientRect().top - detailHead.getBoundingClientRect().bottom)
            : 0,
          titleBottomDelta: detailHead && title
            ? Math.ceil(title.getBoundingClientRect().bottom - detailHead.getBoundingClientRect().bottom)
            : 0,
          bodyWidth: body ? Math.round(body.getBoundingClientRect().width) : 0,
          listWidth: list ? Math.round(list.getBoundingClientRect().width) : 0,
          sectionRadius: sectionStyle ? parseFloat(sectionStyle.borderRadius) : 0,
          sectionBorderWidth: sectionStyle ? parseFloat(sectionStyle.borderTopWidth) : 0,
          sectionBackground: sectionStyle?.backgroundColor || "",
          capabilityRadius: capabilityStyle ? parseFloat(capabilityStyle.borderRadius) : 0,
          capabilityBackground: capabilityStyle?.backgroundColor || "",
          editorColumns: editor ? getComputedStyle(editor).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
        };
      }, { entityEditor: !!route.entityEditor, flatBody: !!route.flatBody, readArticle: !!route.readArticle });
      expect(paneMetrics.rowHeight, `${viewport.label} ${route.hash} row height`).toBeGreaterThanOrEqual(56);
      expect(paneMetrics.headHeight, `${viewport.label} ${route.hash} head height`).toBeGreaterThanOrEqual(68);
      expect(paneMetrics.bodyStartsAfterHead, `${viewport.label} ${route.hash} body starts after head`).toBeGreaterThanOrEqual(0);
      expect(paneMetrics.titleBottomDelta, `${viewport.label} ${route.hash} title stays inside head`).toBeLessThanOrEqual(0);
      expect(paneMetrics.bodyWidth, `${viewport.label} ${route.hash} body width`).toBeGreaterThan(0);
      expect(paneMetrics.listWidth, `${viewport.label} ${route.hash} list width`).toBeGreaterThanOrEqual(300);
      if (route.readArticle) {
        expect(paneMetrics.editorColumns, `${viewport.label} ${route.hash} read columns`).toBeGreaterThanOrEqual(1);
      } else if (route.flatBody) {
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
      if (route.flatBody) {
        expect(paneMetrics.editorColumns, `${viewport.label} ${route.hash} agent editor columns`).toBe(1);
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
          ".knowledge-read-markdown",
          ".kb-category-badge",
          ".chip",
        ].join(", "),
        `${viewport.label} ${route.hash} polished panes`,
      );
    }
  }
});

test("mobile agents skills projects and knowledge panes preserve compact premium detail structure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    { hash: "#/library/agents/regression-agent", title: "Regression Agent", back: "All agents", entityEditor: true, flatBody: true },
    { hash: `#/library/skills/${skillName}`, title: "Regression Skill", back: "All skills", entityEditor: true },
    { hash: `#/projects/${projectSlug}`, title: "Mobile Layout Project", back: "Projects", readArticle: true, archiveAction: true },
    { hash: "#/library/knowledge/mobile-layout-reference", title: "Mobile layout reference", back: "Knowledge", readArticle: true },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    if (route.entityEditor || route.readArticle) {
      await expect(page.locator(".pane-mobile-back")).toHaveCount(0);
      await expect(page.locator(".mobile-topbar-back").first()).toBeVisible();
    }
    if (route.entityEditor) {
      await expect(page.locator(".entity-edit-mobile-dock .button", { hasText: "Save" })).toBeVisible();
    } else if (route.readArticle) {
      await expect(page.locator(".entity-edit-mobile-dock .button", { hasText: "Save" })).toHaveCount(0);
      await expect(page.locator(".entity-edit-mobile-dock .button", { hasText: "Edit" })).toBeVisible();
      if (route.archiveAction) {
        await expect(page.locator(".entity-edit-mobile-dock .button", { hasText: "Archive" })).toBeVisible();
      }
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
    } else if (route.readArticle) {
      await expect(page.locator(".knowledge-read-layout")).toBeVisible();
      await expect(page.locator(".knowledge-read-rail.is-mobile-drawer-source").first()).toBeHidden();
      await expect(page.locator(".rail-summary-pill").first()).toBeVisible();
    } else {
      await expect(page.locator(".pane-detail-body > .form-section").first()).toBeVisible();
    }

    const mobileMetrics = await page.evaluate(({ entityEditor, readArticle }) => {
      const head = document.querySelector(".pane-detail-head");
      const toolbar = document.querySelector(".pane-detail-head .toolbar");
      const body = document.querySelector(".pane-detail-body");
      const title = head?.querySelector("h2");
      const dock = document.querySelector(".entity-edit-mobile-dock");
      const tabbar = document.querySelector(".app-tabbar");
      const formSection = readArticle
        ? document.querySelector(".knowledge-read-article")
        : entityEditor
        ? document.querySelector(".entity-editor-main > .form-section")
        : document.querySelector(".pane-detail-body > .form-section");
      const icon = document.querySelector(".pane-detail-icon, .agent-avatar");
      const rail = document.querySelector(".entity-editor-rail");
      return {
        headWidth: head ? Math.round(head.getBoundingClientRect().width) : 0,
        bodyStartsAfterHead: head && body
          ? Math.round(body.getBoundingClientRect().top - head.getBoundingClientRect().bottom)
          : 0,
        titleBottomDelta: head && title
          ? Math.ceil(title.getBoundingClientRect().bottom - head.getBoundingClientRect().bottom)
          : 0,
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
    }, { entityEditor: !!route.entityEditor, readArticle: !!route.readArticle });
    expect(mobileMetrics.headWidth).toBeLessThanOrEqual(390);
    expect(mobileMetrics.bodyStartsAfterHead).toBeGreaterThanOrEqual(0);
    expect(mobileMetrics.titleBottomDelta).toBeLessThanOrEqual(0);
    expect(mobileMetrics.toolbarTop === 0 || mobileMetrics.toolbarTop >= mobileMetrics.headTop).toBe(true);
    if (route.readArticle) expect(mobileMetrics.sectionRadius).toBe(0);
    else if (route.flatBody) expect(mobileMetrics.sectionRadius).toBe(0);
    else expect(mobileMetrics.sectionRadius).toBeGreaterThanOrEqual(6);
    expect(mobileMetrics.iconWidth === 0 || mobileMetrics.iconWidth >= 28).toBe(true);
    if (route.entityEditor) {
      expect(mobileMetrics.railPosition).toBe("static");
      expect(mobileMetrics.toolbarDisplay).toBe("none");
      expect(mobileMetrics.dockDisplay).toBe("flex");
      expect(mobileMetrics.dockBottomBeforeNav).toBe(true);
      expect(mobileMetrics.tabbarDisplay).toBe("none");
    } else if (route.readArticle) {
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
        ".knowledge-read-markdown",
        ".kb-category-badge",
        ".chip",
      ].join(", "),
      `mobile polished pane ${route.hash}`,
    );
  }
});

test("project detail surfaces AGENTS.md prompt injection status", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/#/projects/${projectSlug}`);

  await expect(page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" })).toBeVisible();
  await expect(page.locator(".project-repository-status")).toContainText("AGENTS.md recognized");
  await expect(page.locator(".project-repository-status")).toContainText("Injected into task run prompts as Repository instructions.");
  await expect(page.locator(".entity-meta-row", { hasText: "Repository instructions" })).toContainText("AGENTS.md recognized");
  await expectNoHorizontalOverflow(page, "project AGENTS.md status");
});

test("mobile scroll containers keep final content above bottom chrome", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    { hash: "#/library/agents", target: ".pane-row:last-child", scroller: ".pane-list-body" },
    { hash: "#/library/knowledge/mobile-layout-reference", target: ".knowledge-read-section:last-child", scroller: ".pane-detail" },
    { hash: `#/projects/${projectSlug}`, target: ".knowledge-read-section:last-child", scroller: ".pane-detail" },
    { hash: "#/library/agents/regression-agent", target: ".entity-editor-main > .form-section:last-child", scroller: ".pane-detail" },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(page.locator(route.target).first()).toBeVisible();
    await page.evaluate(() => {
      for (const selector of [".app-main", ".pane-list-body", ".pane-detail", ".pane-detail-body"]) {
        for (const element of document.querySelectorAll(selector)) {
          element.scrollTop = element.scrollHeight;
        }
      }
    });
    await page.waitForTimeout(50);

    const metrics = await page.evaluate(({ targetSelector, scrollerSelector }) => {
      const parsePx = (value) => {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const targets = Array.from(document.querySelectorAll(targetSelector));
      const target = targets.at(-1) || null;
      const chrome = Array.from(document.querySelectorAll(".app-mobile-action-dock, .app-tabbar"))
        .find((element) => getComputedStyle(element).display !== "none");
      const appBody = document.querySelector(".app-body");
      const appMain = document.querySelector(".app-main");
      const scroller = document.querySelector(scrollerSelector);
      const targetRect = target?.getBoundingClientRect();
      const chromeRect = chrome?.getBoundingClientRect();
      const bodyStyles = appBody ? getComputedStyle(appBody) : null;
      const mainStyles = appMain ? getComputedStyle(appMain) : null;
      return {
        targetBottom: targetRect ? Math.round(targetRect.bottom) : 0,
        chromeTop: chromeRect ? Math.round(chromeRect.top) : window.innerHeight,
        chromeHeight: chromeRect ? Math.round(chromeRect.height) : 0,
        gapToChrome: targetRect && chromeRect ? Math.round(chromeRect.top - targetRect.bottom) : 0,
        bodyPaddingBottom: bodyStyles ? Math.round(parsePx(bodyStyles.paddingBottom)) : 0,
        mainPaddingBottom: mainStyles ? Math.round(parsePx(mainStyles.paddingBottom)) : 0,
        mainScrollPaddingBottom: mainStyles ? Math.round(parsePx(mainStyles.scrollPaddingBottom)) : 0,
        scrollerScrollable: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : false,
      };
    }, { targetSelector: route.target, scrollerSelector: route.scroller });

    expect(metrics.bodyPaddingBottom, `${route.hash} body padding`).toBeGreaterThanOrEqual(metrics.chromeHeight - 1);
    expect(metrics.bodyPaddingBottom, `${route.hash} body padding`).toBeLessThanOrEqual(metrics.chromeHeight + 2);
    expect(metrics.mainPaddingBottom, `${route.hash} main padding`).toBeLessThanOrEqual(1);
    expect(metrics.mainScrollPaddingBottom, `${route.hash} main scroll padding`).toBeLessThanOrEqual(1);
    expect(metrics.targetBottom, `${route.hash} target below chrome`).toBeLessThanOrEqual(metrics.chromeTop);
    if (metrics.scrollerScrollable) {
      expect(metrics.gapToChrome, `${route.hash} excessive bottom gap`).toBeLessThanOrEqual(96);
    }
  }
});

// Responsive breakpoints from docs/ui-design-system.md. Shared UI should not
// introduce horizontal overflow on any route at these widths.
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
  const { taskId, providerId, skillName, projectSlug, teamSlug, goalId } = ids;
  return [
    { hash: "#/tasks", ready: () => page.locator(".commander-row").first() },
    { hash: `#/tasks/${taskId}`, ready: () => page.locator(".task-hero-title", { hasText: "UI regression task" }) },
    { hash: "#/tasks/new", ready: () => page.locator(".task-edit-head").first() },
    { hash: "#/goals", ready: () => page.locator(".goal-resource-list") },
    { hash: `#/goals/${goalId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" }) },
    { hash: "#/goals/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New goal" }) },
    { hash: "#/projects", ready: () => page.locator(".pane-list") },
    { hash: `#/projects/${projectSlug}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" }) },
    { hash: "#/projects/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "Untitled project" }) },
    { hash: "#/library/teams", ready: () => page.locator(".pane-list") },
    { hash: `#/library/teams/${teamSlug}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Team" }) },
    { hash: "#/library/teams/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New team" }) },
    { hash: "#/library/agents", ready: () => page.locator(".pane-list") },
    { hash: "#/library/agents/regression-agent", ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Agent" }) },
    { hash: "#/library/agents/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New agent" }) },
    { hash: "#/library/skills", ready: () => page.locator(".pane-list") },
    { hash: `#/library/skills/${skillName}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Skill" }) },
    { hash: "#/library/skills/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New skill" }) },
    { hash: "#/library/knowledge", ready: () => page.locator(".pane-list") },
    { hash: "#/library/knowledge/welcome", ready: () => page.locator(".pane-detail-head h2", { hasText: "Welcome guide" }) },
    { hash: "#/library/knowledge/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New entry" }) },
    { hash: "#/settings/providers", ready: () => page.locator(".pane-list") },
    { hash: `#/settings/providers/${providerId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression provider" }) },
    { hash: "#/settings/providers/new", ready: () => page.locator(".pane-detail-head h2", { hasText: "New provider" }) },
    { hash: "#/runs", ready: () => page.locator(".activity-stats") },
    { hash: "#/settings", ready: () => page.locator(".settings-sections") },
    { hash: "#/design-system", ready: () => page.locator(".ds-catalog") },
  ];
}

for (const vp of RESPONSIVE_VIEWPORTS) {
  test(`no horizontal overflow at ${vp.label} (${vp.w}x${vp.h})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    const routes = responsiveRoutes(page, { taskId, providerId, skillName, projectSlug, teamSlug, goalId });
    for (const route of routes) {
      await page.goto("about:blank");
      await page.goto(`${baseUrl}/${route.hash}`);
      await expect(route.ready()).toBeVisible({ timeout: 5000 });
      await expectNoHorizontalOverflow(page, `${vp.label} ${route.hash}`);
    }
  });
}

test("browser back walks through mapped app routes without anchor hash remounts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(`${baseUrl}/#/projects/${projectSlug}`);
  const projectTitle = page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" });
  await expect(projectTitle).toBeVisible();
  await page.evaluate(() => { window.location.hash = "#project-details"; });
  await page.waitForFunction(() => window.location.hash === "#project-details");
  await expect(projectTitle).toBeVisible();
  await page.evaluate(() => window.history.back());
  await page.waitForFunction((expected) => window.location.hash === expected, `#/projects/${projectSlug}`);
  await expect(projectTitle).toBeVisible();

  const routes = [
    { hash: "#/tasks", ready: () => page.locator(".commander-row").first() },
    { hash: "#/goals", ready: () => page.locator(".goal-resource-list") },
    { hash: `#/goals/${goalId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" }) },
    { hash: "#/projects", ready: () => page.locator(".pane-list") },
    { hash: `#/projects/${projectSlug}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" }) },
    { hash: "#/library/teams", ready: () => page.locator(".pane-list") },
    { hash: `#/library/teams/${teamSlug}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Team" }) },
    { hash: "#/library/agents", ready: () => page.locator(".pane-list") },
    { hash: "#/library/agents/regression-agent", ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Agent" }) },
    { hash: "#/library/skills", ready: () => page.locator(".pane-list") },
    { hash: `#/library/skills/${skillName}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression Skill" }) },
    { hash: "#/library/knowledge", ready: () => page.locator(".pane-list") },
    { hash: "#/library/knowledge/welcome", ready: () => page.locator(".pane-detail-head h2", { hasText: "Welcome guide" }) },
    { hash: "#/settings/providers", ready: () => page.locator(".pane-list") },
    { hash: `#/settings/providers/${providerId}`, ready: () => page.locator(".pane-detail-head h2", { hasText: "Regression provider" }) },
    { hash: "#/runs", ready: () => page.locator(".activity-stats") },
    { hash: "#/settings", ready: () => page.locator(".settings-sections") },
  ];

  await page.goto(`${baseUrl}/${routes[0].hash}`);
  await expect(routes[0].ready()).toBeVisible();
  for (const route of routes.slice(1)) {
    await page.evaluate((hash) => { window.location.hash = hash; }, route.hash);
    await page.waitForFunction((expected) => window.location.hash === expected, route.hash);
    await expect(route.ready()).toBeVisible({ timeout: 5000 });
  }

  for (let index = routes.length - 2; index >= 0; index -= 1) {
    await page.evaluate(() => window.history.back());
    await page.waitForFunction((expected) => window.location.hash === expected, routes[index].hash);
    await expect(routes[index].ready()).toBeVisible({ timeout: 5000 });
  }
});

test("mobile More tab opens overflow navigation routes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();

  for (const label of ["Tasks", "Agents", "Projects", "Knowledge"]) {
    await expect(page.locator(".app-tabbar a", { hasText: label })).toBeVisible();
  }

  await page.locator(".app-tabbar a", { hasText: "Agents" }).click();
  await expect(page).toHaveURL(/#\/library\/agents$/);
  await expect(page.locator(".pane-list")).toBeVisible();

  await page.locator(".app-tabbar a", { hasText: "Projects" }).click();
  await expect(page).toHaveURL(/#\/projects$/);
  await expect(page.locator(".pane-list")).toBeVisible();

  await page.locator(".app-tabbar a", { hasText: "Knowledge" }).click();
  await expect(page).toHaveURL(/#\/library\/knowledge$/);
  await expect(page.locator(".pane-list")).toBeVisible();

  const more = page.locator(".app-tabbar button", { hasText: "More" });
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");

  await more.click();
  const sheet = page.locator(".app-more-sheet.open");
  await expect(sheet).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");

  for (const label of ["Teams", "Skills", "Goals", "Runs", "Settings"]) {
    await expect(sheet.getByRole("link", { name: label })).toBeVisible();
  }

  const metrics = await page.evaluate(() => {
    const nav = document.querySelector(".app-tabbar");
    const navItems = [...document.querySelectorAll(".app-tabbar > a, .app-tabbar > button")];
    const sheetLinks = [...document.querySelectorAll(".app-more-sheet-link")];
    return {
      navCount: navItems.length,
      navColumns: nav ? getComputedStyle(nav).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      navLabels: navItems.map((item) => (item.textContent || "").replace(/\s+/g, " ").trim()),
      navMinWidth: Math.min(...navItems.map((item) => Math.round(item.getBoundingClientRect().width))),
      navMaxWidth: Math.max(...navItems.map((item) => Math.round(item.getBoundingClientRect().width))),
      sheetLinkLabels: sheetLinks.map((link) => (link.textContent || "").replace(/\s+/g, " ").trim()),
      minSheetLinkHeight: Math.min(...sheetLinks.map((link) => Math.round(link.getBoundingClientRect().height))),
      sheetOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(metrics.navCount).toBe(5);
  expect(metrics.navColumns).toBe(5);
  expect(metrics.navLabels).toEqual(["Tasks", "Agents", "Projects", "Knowledge", "More"]);
  expect(metrics.navMinWidth).toBeGreaterThanOrEqual(44);
  expect(metrics.navMaxWidth - metrics.navMinWidth).toBeLessThanOrEqual(1);
  expect(metrics.sheetLinkLabels).toEqual(["Teams", "Skills", "Goals", "Runs", "Settings"]);
  expect(metrics.minSheetLinkHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.sheetOverflow).toBeLessThanOrEqual(0);
  await expectNoHorizontalOverflow(page, "mobile More sheet");

  await page.locator(".app-more-sheet.open").getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator(".settings-route-shell")).toBeVisible();

  await page.goto(`${baseUrl}/#/settings/providers`);
  await expect(page.locator(".pane-list")).toBeVisible();
  await expect(page.locator(".app-tabbar button", { hasText: "More" })).toHaveClass(/active/);
});

test("mobile settings routes share aligned shell geometry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    { hash: "#/settings", ready: () => page.locator(".settings-sections"), label: "settings" },
    { hash: "#/settings/providers", ready: () => page.locator(".pane-list"), label: "providers" },
    { hash: "#/settings/about", ready: () => page.locator(".settings-about"), label: "about" },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(route.ready()).toBeVisible();

    const metrics = await page.evaluate(() => {
      const shell = document.querySelector(".settings-route-shell");
      const tabs = document.querySelector(".settings-tabs");
      const tabButtons = [...document.querySelectorAll(".settings-tabs .tab")];
      const content = document.querySelector(".settings-route-content");
      const head = document.querySelector(".settings-route-shell > .ds-page-head");
      const title = document.querySelector(".settings-route-shell > .ds-page-head .ds-page-title");
      const shellRect = shell?.getBoundingClientRect();
      const tabsRect = tabs?.getBoundingClientRect();
      const tabRects = tabButtons.map((tab) => tab.getBoundingClientRect());
      const contentRect = content?.getBoundingClientRect();
      const headRect = head?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      const headStyles = head ? getComputedStyle(head) : null;
      const parsePx = (value) => Math.round(parseFloat(value) || 0);
      return {
        shellClass: shell?.className || "",
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        shellLeft: shellRect ? Math.round(shellRect.left) : -1,
        shellRight: shellRect ? Math.round(shellRect.right) : -1,
        headLeft: headRect ? Math.round(headRect.left) : -1,
        headContentLeft: headRect && headStyles ? Math.round(headRect.left + parsePx(headStyles.paddingLeft)) : -1,
        tabsLeft: tabsRect ? Math.round(tabsRect.left) : -1,
        tabsTop: tabsRect ? Math.round(tabsRect.top) : -1,
        tabsWidth: tabsRect ? Math.round(tabsRect.width) : 0,
        tabsInsideHeader: !!tabs && !!tabs.closest(".ds-page-head"),
        titleBottom: titleRect ? Math.round(titleRect.bottom) : -1,
        tabWidths: tabRects.map((rect) => Math.round(rect.width)),
        contentLeft: contentRect ? Math.round(contentRect.left) : -1,
        contentTopAfterTabs: tabsRect && contentRect ? Math.round(contentRect.top) > Math.round(tabsRect.bottom) : false,
        contentWidth: contentRect ? Math.round(contentRect.width) : 0,
      };
    });

    expect(metrics.shellClass, `${route.label} shell`).toContain("settings-route-shell");
    expect(metrics.overflow, `${route.label} overflow`).toBeLessThanOrEqual(0);
    expect(metrics.shellLeft, `${route.label} shell left`).toBe(0);
    expect(metrics.shellRight, `${route.label} shell right`).toBe(390);
    expect(Math.abs(metrics.headLeft - metrics.contentLeft), `${route.label} head/content alignment`).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.headContentLeft - metrics.tabsLeft), `${route.label} head/tabs alignment`).toBeLessThanOrEqual(1);
    expect(metrics.tabsInsideHeader, `${route.label} tabs inside header`).toBe(true);
    expect(metrics.tabsTop, `${route.label} tabs below title`).toBeGreaterThan(metrics.titleBottom);
    expect(metrics.tabsWidth, `${route.label} tabs width`).toBeGreaterThanOrEqual(350);
    expect(Math.max(...metrics.tabWidths) - Math.min(...metrics.tabWidths), `${route.label} equal tab widths`).toBeLessThanOrEqual(1);
    expect(metrics.contentTopAfterTabs, `${route.label} content below tabs`).toBe(true);
    expect(metrics.contentWidth, `${route.label} content width`).toBeGreaterThanOrEqual(350);
  }
});

test("mobile route tabs are condensed into the owning header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/library/agents`);
  await expect(page.locator(".pane-list")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--worklab-safe-area-top", "31px");
  });
  await page.waitForTimeout(50);

  const libraryMetrics = await page.evaluate(() => {
    const outerTabs = document.querySelector(".library-page > .library-tabs");
    const header = document.querySelector(".pane-list-head");
    const headerTabs = document.querySelector(".pane-list-head .library-tabs");
    const toolbar = document.querySelector(".pane-list-head .resource-toolbar");
    const search = document.querySelector(".pane-list-head .search-field");
    const headerRect = header?.getBoundingClientRect();
    const tabsRect = headerTabs?.getBoundingClientRect();
    const toolbarRect = toolbar?.getBoundingClientRect();
    const searchRect = search?.getBoundingClientRect();
    const headerStyles = header ? getComputedStyle(header) : null;
    const parsePx = (value) => Math.round(parseFloat(value) || 0);
    return {
      outerTabsDisplay: outerTabs ? getComputedStyle(outerTabs).display : "none",
      headerTop: headerRect ? Math.round(headerRect.top) : -1,
      headerHeight: headerRect ? Math.round(headerRect.height) : 0,
      headerPaddingTop: headerStyles ? parsePx(headerStyles.paddingTop) : -1,
      tabsInsideHeader: !!headerTabs && !!headerTabs.closest(".pane-list-head"),
      tabsTop: tabsRect ? Math.round(tabsRect.top) : -1,
      tabsBottom: tabsRect ? Math.round(tabsRect.bottom) : -1,
      toolbarTop: toolbarRect ? Math.round(toolbarRect.top) : -1,
      searchTop: searchRect ? Math.round(searchRect.top) : -1,
      searchBottom: searchRect ? Math.round(searchRect.bottom) : -1,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(libraryMetrics.outerTabsDisplay).toBe("none");
  expect(libraryMetrics.headerTop).toBe(0);
  expect(libraryMetrics.headerPaddingTop).toBeGreaterThanOrEqual(31);
  expect(libraryMetrics.headerHeight).toBeLessThanOrEqual(128);
  expect(libraryMetrics.tabsInsideHeader).toBe(true);
  expect(libraryMetrics.tabsTop).toBeGreaterThanOrEqual(31);
  expect(libraryMetrics.toolbarTop).toBeGreaterThanOrEqual(libraryMetrics.headerPaddingTop);
  expect(libraryMetrics.searchTop).toBeGreaterThanOrEqual(libraryMetrics.tabsBottom);
  expect(libraryMetrics.searchBottom).toBeLessThanOrEqual(libraryMetrics.headerTop + libraryMetrics.headerHeight);
  expect(libraryMetrics.overflow).toBeLessThanOrEqual(0);

  await page.goto(`${baseUrl}/#/settings`);
  await expect(page.locator(".settings-sections")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--worklab-safe-area-top", "31px");
  });
  await page.waitForTimeout(50);

  const settingsMetrics = await page.evaluate(() => {
    const shell = document.querySelector(".settings-route-shell");
    const directTabs = document.querySelector(".settings-route-shell > .settings-tabs");
    const head = document.querySelector(".settings-route-shell > .ds-page-head");
    const headerTabs = document.querySelector(".settings-route-shell > .ds-page-head .settings-tabs");
    const tabButtons = [...document.querySelectorAll(".settings-route-shell > .ds-page-head .settings-tabs .tab")];
    const content = document.querySelector(".settings-route-content");
    const shellRect = shell?.getBoundingClientRect();
    const headRect = head?.getBoundingClientRect();
    const tabsRect = headerTabs?.getBoundingClientRect();
    const tabRects = tabButtons.map((tab) => tab.getBoundingClientRect());
    const contentRect = content?.getBoundingClientRect();
    const headStyles = head ? getComputedStyle(head) : null;
    const parsePx = (value) => Math.round(parseFloat(value) || 0);
    return {
      shellLeft: shellRect ? Math.round(shellRect.left) : -1,
      shellRight: shellRect ? Math.round(shellRect.right) : -1,
      directTabsDisplay: directTabs ? getComputedStyle(directTabs).display : "none",
      headTop: headRect ? Math.round(headRect.top) : -1,
      headBottom: headRect ? Math.round(headRect.bottom) : -1,
      headHeight: headRect ? Math.round(headRect.height) : 0,
      headPaddingTop: headStyles ? parsePx(headStyles.paddingTop) : -1,
      tabsInsideHeader: !!headerTabs && !!headerTabs.closest(".ds-page-head"),
      tabsTop: tabsRect ? Math.round(tabsRect.top) : -1,
      tabsBottom: tabsRect ? Math.round(tabsRect.bottom) : -1,
      tabsWidth: tabsRect ? Math.round(tabsRect.width) : 0,
      tabWidths: tabRects.map((rect) => Math.round(rect.width)),
      contentTop: contentRect ? Math.round(contentRect.top) : -1,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(settingsMetrics.shellLeft).toBe(0);
  expect(settingsMetrics.shellRight).toBe(390);
  expect(settingsMetrics.directTabsDisplay).toBe("none");
  expect(settingsMetrics.headTop).toBe(0);
  expect(settingsMetrics.headPaddingTop).toBeGreaterThanOrEqual(31);
  expect(settingsMetrics.headHeight).toBeLessThanOrEqual(148);
  expect(settingsMetrics.tabsInsideHeader).toBe(true);
  expect(settingsMetrics.tabsTop).toBeGreaterThanOrEqual(31);
  expect(settingsMetrics.tabsBottom).toBeLessThanOrEqual(settingsMetrics.headBottom);
  expect(settingsMetrics.tabsWidth).toBeGreaterThanOrEqual(350);
  expect(Math.max(...settingsMetrics.tabWidths) - Math.min(...settingsMetrics.tabWidths)).toBeLessThanOrEqual(1);
  expect(settingsMetrics.contentTop).toBeGreaterThan(settingsMetrics.headBottom);
  expect(settingsMetrics.overflow).toBeLessThanOrEqual(0);
});

test("mobile tabbar does not create document scroll space below content", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(50);

  const metrics = await page.evaluate(() => {
    const app = document.querySelector(".app");
    const appBody = document.querySelector(".app-body");
    const appMain = document.querySelector(".app-main");
    const tabbar = document.querySelector(".app-tabbar");
    const appStyles = app ? getComputedStyle(app) : null;
    const bodyStyles = appBody ? getComputedStyle(appBody) : null;
    const tabbarStyles = tabbar ? getComputedStyle(tabbar) : null;
    const parsePx = (value) => Math.round(parseFloat(value) || 0);
    return {
      windowScrollY: Math.round(window.scrollY),
      viewportHeight: window.innerHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
      appPaddingBottom: appStyles ? parsePx(appStyles.paddingBottom) : 0,
      bodyPaddingBottom: bodyStyles ? parsePx(bodyStyles.paddingBottom) : 0,
      mainOverflowY: appMain ? getComputedStyle(appMain).overflowY : "",
      tabbarDisplay: tabbarStyles?.display || "",
      tabbarPosition: tabbarStyles?.position || "",
      tabbarOverflowX: tabbarStyles?.overflowX || "",
      tabbarHeight: tabbar ? Math.round(tabbar.getBoundingClientRect().height) : 0,
      tabbarBottom: tabbar ? Math.round(tabbar.getBoundingClientRect().bottom) : 0,
    };
  });

  expect(metrics.windowScrollY).toBe(0);
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.appPaddingBottom).toBe(0);
  expect(metrics.bodyPaddingBottom).toBe(metrics.tabbarHeight);
  expect(metrics.mainOverflowY).toBe("auto");
  expect(metrics.tabbarDisplay).toBe("grid");
  expect(metrics.tabbarPosition).toBe("fixed");
  expect(["clip", "hidden"]).toContain(metrics.tabbarOverflowX);
  expect(metrics.tabbarBottom).toBe(metrics.viewportHeight);
});

test("mobile tasks header owns the opening route status safe area", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();
  await page.waitForTimeout(420);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--worklab-safe-area-top", "31px");
    document.documentElement.style.setProperty("--worklab-safe-area-bottom", "11px");
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(50);

  const metrics = await page.evaluate(() => {
    const app = document.querySelector(".app");
    const appBody = document.querySelector(".app-body");
    const topbar = document.querySelector(".commander-topbar");
    const filter = document.querySelector(".commander-filter");
    const tabbar = document.querySelector(".app-tabbar");
    const fab = document.querySelector(".commander-new-task-fab");
    const assistantLauncher = document.querySelector(".assistant-launcher");
    const topbarRect = topbar?.getBoundingClientRect();
    const filterRect = filter?.getBoundingClientRect();
    const tabbarRect = tabbar?.getBoundingClientRect();
    const fabRect = fab?.getBoundingClientRect();
    const assistantRect = assistantLauncher?.getBoundingClientRect();
    const bodyStyles = appBody ? getComputedStyle(appBody) : null;
    const topbarStyles = topbar ? getComputedStyle(topbar) : null;
    const tabbarStyles = tabbar ? getComputedStyle(tabbar) : null;
    const parsePx = (value) => Math.round(parseFloat(value) || 0);
    const safeAreaElement = document.elementFromPoint(12, 12);
    return {
      route: app?.getAttribute("data-route") || "",
      bodyPaddingTop: bodyStyles ? parsePx(bodyStyles.paddingTop) : -1,
      bodyPaddingBottom: bodyStyles ? parsePx(bodyStyles.paddingBottom) : -1,
      topbarTop: topbarRect ? Math.round(topbarRect.top) : -1,
      topbarPaddingTop: topbarStyles ? parsePx(topbarStyles.paddingTop) : -1,
      topbarBackground: topbarStyles?.backgroundColor || "",
      filterTop: filterRect ? Math.round(filterRect.top) : -1,
      safeAreaOwnedByHeader: !!safeAreaElement?.closest?.(".commander-topbar"),
      tabbarHeight: tabbarRect ? Math.round(tabbarRect.height) : 0,
      tabbarBottom: tabbarRect ? Math.round(tabbarRect.bottom) : 0,
      tabbarBackground: tabbarStyles?.backgroundColor || "",
      fabBottomBeforeNav: fabRect && tabbarRect ? Math.round(fabRect.bottom) <= Math.round(tabbarRect.top) + 1 : false,
      assistantBottomBeforeFab: assistantRect && fabRect ? Math.round(assistantRect.bottom) <= Math.round(fabRect.top) - 1 : false,
      viewportHeight: window.innerHeight,
      windowScrollY: Math.round(window.scrollY),
      documentScrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(metrics.route).toBe("tasks");
  expect(metrics.bodyPaddingTop).toBe(0);
  expect(metrics.topbarTop).toBe(0);
  expect(metrics.topbarPaddingTop).toBe(31);
  expect(metrics.filterTop).toBeGreaterThanOrEqual(31);
  expect(metrics.topbarBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(metrics.safeAreaOwnedByHeader).toBe(true);
  expect(metrics.bodyPaddingBottom).toBe(metrics.tabbarHeight);
  expect(metrics.tabbarBottom).toBe(metrics.viewportHeight);
  expect(metrics.tabbarBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(metrics.fabBottomBeforeNav).toBe(true);
  expect(metrics.assistantBottomBeforeFab).toBe(true);
  expect(metrics.windowScrollY).toBe(0);
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight);
});

test("mobile topbar owns the status safe-area background", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".mobile-topbar")).toBeVisible();
  await expect(page.locator(".task-hero-title", { hasText: "UI regression task" })).toBeVisible();
  await page.waitForTimeout(420);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--worklab-safe-area-top", "31px");
    document.documentElement.style.setProperty("--worklab-safe-area-bottom", "11px");
  });
  await page.waitForTimeout(50);

  const metrics = await page.evaluate(() => {
    const app = document.querySelector(".app");
    const appBody = document.querySelector(".app-body");
    const topbar = document.querySelector(".mobile-topbar");
    const back = document.querySelector(".mobile-topbar-back");
    const main = document.querySelector(".app-main");
    const dock = document.querySelector(".app-mobile-action-dock");
    const topbarRect = topbar?.getBoundingClientRect();
    const backRect = back?.getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect();
    const dockRect = dock?.getBoundingClientRect();
    const appStyles = app ? getComputedStyle(app) : null;
    const bodyStyles = appBody ? getComputedStyle(appBody) : null;
    const topbarStyles = topbar ? getComputedStyle(topbar) : null;
    const parsePx = (value) => Math.round(parseFloat(value) || 0);
    return {
      hasTopbarClass: app?.classList.contains("has-mobile-topbar") || false,
      appPaddingTop: appStyles ? parsePx(appStyles.paddingTop) : -1,
      bodyPaddingTop: bodyStyles ? parsePx(bodyStyles.paddingTop) : -1,
      bodyPaddingBottom: bodyStyles ? parsePx(bodyStyles.paddingBottom) : -1,
      topbarHeight: topbarRect ? Math.round(topbarRect.height) : 0,
      topbarTop: topbarRect ? Math.round(topbarRect.top) : -1,
      topbarPaddingTop: topbarStyles ? parsePx(topbarStyles.paddingTop) : -1,
      topbarBackground: topbarStyles?.backgroundColor || "",
      backTop: backRect ? Math.round(backRect.top) : -1,
      backHeight: backRect ? Math.round(backRect.height) : 0,
      mainTop: mainRect ? Math.round(mainRect.top) : -1,
      dockHeight: dockRect ? Math.round(dockRect.height) : 0,
      dockBottom: dockRect ? Math.round(dockRect.bottom) : 0,
      viewportHeight: window.innerHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(metrics.hasTopbarClass).toBe(true);
  expect(metrics.appPaddingTop).toBe(0);
  expect(metrics.bodyPaddingTop).toBe(0);
  expect(metrics.topbarHeight).toBe(75);
  expect(metrics.topbarTop).toBe(0);
  expect(metrics.topbarPaddingTop).toBe(31);
  expect(metrics.topbarBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(metrics.backTop).toBeGreaterThanOrEqual(31);
  expect(metrics.backTop + metrics.backHeight).toBeLessThanOrEqual(metrics.topbarHeight);
  expect(metrics.mainTop).toBe(metrics.topbarHeight);
  expect(metrics.bodyPaddingBottom).toBe(metrics.dockHeight);
  expect(metrics.dockBottom).toBe(metrics.viewportHeight);
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight);
});

test("mobile registered chrome owns bottom navigation before project detail settles", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/projects/${projectSlug}`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" })).toBeVisible();
  await expect(page.locator(".mobile-topbar")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const app = document.querySelector(".app");
    const body = document.querySelector(".app-body");
    const tabbar = document.querySelector(".app-tabbar");
    const dock = document.querySelector(".app-mobile-action-dock");
    const topbar = document.querySelector(".mobile-topbar");
    const dockRect = dock?.getBoundingClientRect();
    const parsePx = (value) => Math.round(parseFloat(value) || 0);
    return {
      hasDockClass: app?.classList.contains("has-dock") || false,
      hasTopbarClass: app?.classList.contains("has-mobile-topbar") || false,
      tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      bodyPaddingBottom: body ? parsePx(getComputedStyle(body).paddingBottom) : 0,
      dockHeight: dockRect ? Math.round(dockRect.height) : 0,
      dockBottom: dockRect ? Math.round(dockRect.bottom) : 0,
      topbarDisplay: topbar ? getComputedStyle(topbar).display : "",
      viewportHeight: window.innerHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
    };
  });

  expect(metrics.hasDockClass).toBe(true);
  expect(metrics.hasTopbarClass).toBe(true);
  expect(metrics.tabbarDisplay).toBe("none");
  expect(metrics.dockDisplay).toBe("flex");
  expect(metrics.topbarDisplay).toBe("flex");
  expect(metrics.bodyPaddingBottom).toBe(metrics.dockHeight);
  expect(metrics.dockBottom).toBe(metrics.viewportHeight);
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight);
});

test("mobile task list keeps search visible and moves configuration into a bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();

  await expect(page.locator(".commander-filter .search-field")).toBeVisible();
  await expect(page.locator(".commander-mobile-config-trigger")).toBeVisible();
  await expect(page.locator(".commander-filter .tabs")).toBeHidden();
  await expect(page.locator(".commander-stage-filter")).toBeHidden();
  await expect(page.locator(".commander-project-filter")).toBeHidden();

  await page.locator(".commander-mobile-config-trigger").click();
  const sheet = page.getByRole("dialog", { name: "Task list configuration" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".tabs")).toBeVisible();
  await expect(sheet.locator(".commander-stage-filter")).toBeVisible();
  await expect(sheet.locator(".commander-project-filter")).toBeVisible();
  const metrics = await mobileConfigSheetMetrics(page);
  expect(metrics.panelHeight).toBeLessThan(metrics.previousFixedHeight - 80);
  expect(metrics.panelBottom).toBeLessThanOrEqual(1);
  expect(metrics.bodyBottomGap).toBeLessThanOrEqual(16);
  expect(metrics.visibleChildren).toBeGreaterThanOrEqual(4);
  await sheet.getByRole("tab", { name: /Running/ }).click();
  await expect(sheet.getByRole("tab", { name: /Running/ })).toHaveAttribute("aria-selected", "true");
});

test("mobile resource list filters are available from the shared configuration sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    { hash: "#/library/agents", label: "Agents" },
    { hash: "#/goals", label: "Goals" },
    { hash: "#/projects", label: "Projects" },
    { hash: "#/library/knowledge", label: "Knowledge" },
    { hash: "#/library/skills", label: "Skills" },
    { hash: "#/library/teams", label: "Teams" },
    { hash: "#/settings/providers", label: "Providers" },
  ]) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(page.locator(".resource-toolbar .search-field")).toBeVisible();
    await expect(page.locator(".resource-mobile-config-trigger")).toBeVisible();
    await expect(page.locator(".resource-toolbar-filters")).toBeHidden();

    await page.locator(".resource-mobile-config-trigger").click();
    const sheet = page.getByRole("dialog", { name: `${route.label} configuration` });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".resource-toolbar-filters")).toBeVisible();
    await expect(sheet.locator(".tabs, .resource-filter-select").first()).toBeVisible();
    const metrics = await mobileConfigSheetMetrics(page);
    expect(metrics.panelHeight, `${route.label} sheet height`).toBeLessThan(metrics.previousFixedHeight - 80);
    expect(metrics.panelBottom, `${route.label} sheet bottom alignment`).toBeLessThanOrEqual(1);
    expect(metrics.bodyBottomGap, `${route.label} sheet content gap`).toBeLessThanOrEqual(16);
    expect(metrics.visibleChildren, `${route.label} sheet controls`).toBeGreaterThanOrEqual(1);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
  }
});

test("desktop resource list filters use the same compact configuration surface", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  for (const route of [
    { hash: "#/library/agents", label: "Agents" },
    { hash: "#/goals", label: "Goals" },
    { hash: "#/projects", label: "Projects" },
    { hash: "#/library/knowledge", label: "Knowledge" },
    { hash: "#/library/skills", label: "Skills" },
    { hash: "#/library/teams", label: "Teams" },
    { hash: "#/settings/providers", label: "Providers" },
  ]) {
    await page.goto(`${baseUrl}/${route.hash}`);
    const toolbar = page.locator(".resource-toolbar").first();
    await expect(toolbar.locator(".search-field")).toBeVisible();
    await expect(toolbar.locator(".resource-mobile-config-trigger")).toBeVisible();
    await expect(page.locator(".resource-toolbar-filters")).toBeHidden();

    const compactMetrics = await toolbar.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const search = node.querySelector(".search-field")?.getBoundingClientRect();
      const trigger = node.querySelector(".resource-mobile-config-trigger")?.getBoundingClientRect();
      return {
        height: Math.round(rect.height),
        searchWidth: search ? Math.round(search.width) : 0,
        searchAndTriggerSameRow: search && trigger
          ? Math.round(trigger.top) < Math.round(search.bottom)
            && Math.round(search.top) < Math.round(trigger.bottom)
          : false,
      };
    });
    expect(compactMetrics.height, `${route.label} toolbar height`).toBeLessThanOrEqual(58);
    expect(compactMetrics.searchWidth, `${route.label} search width`).toBeGreaterThanOrEqual(240);
    expect(compactMetrics.searchAndTriggerSameRow, `${route.label} search/config row`).toBe(true);

    await toolbar.locator(".resource-mobile-config-trigger").click();
    const sheet = page.getByRole("dialog", { name: `${route.label} configuration` });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".resource-toolbar-filters")).toBeVisible();
    await expect(sheet.locator(".tabs, .resource-filter-select").first()).toBeVisible();
    const sheetMetrics = await sheet.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const body = node.querySelector(".resource-toolbar-filters")?.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        rightGap: Math.round(window.innerWidth - rect.right),
        top: Math.round(rect.top),
        bodyWidth: body ? Math.round(body.width) : 0,
      };
    });
    expect(sheetMetrics.width, `${route.label} sheet width`).toBeLessThanOrEqual(380);
    expect(sheetMetrics.rightGap, `${route.label} right alignment`).toBeGreaterThanOrEqual(12);
    expect(sheetMetrics.top, `${route.label} sheet top`).toBeGreaterThanOrEqual(56);
    expect(sheetMetrics.bodyWidth, `${route.label} sheet body width`).toBeGreaterThanOrEqual(280);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
  }
});

test("project list workdirs render as path metadata instead of badges", async ({ page }) => {
  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/#/projects`);
    const row = page.locator(".project-pane-row", { hasText: "Mobile Layout Project" });
    await expect(row).toBeVisible();

    const metrics = await row.evaluate((node) => {
      const path = node.querySelector(".resource-row-path");
      const value = node.querySelector(".resource-row-path-value");
      const style = path ? getComputedStyle(path) : null;
      const pathRect = path?.getBoundingClientRect();
      const rowRect = node.getBoundingClientRect();
      return {
        oldWorkdirChipCount: node.querySelectorAll(".project-row-workdir-chip").length,
        pathText: value?.textContent?.trim() || "",
        pathWidth: pathRect ? Math.round(pathRect.width) : 0,
        rowWidth: Math.round(rowRect.width),
        pathBorderRadius: style?.borderRadius || "",
        pathBorderWidth: style?.borderTopWidth || "",
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });

    expect(metrics.oldWorkdirChipCount, `${viewport.label} old workdir chip`).toBe(0);
    expect(metrics.pathText, `${viewport.label} workdir text`).toContain("mobile-layout-project");
    expect(metrics.pathWidth, `${viewport.label} path width`).toBeGreaterThan(0);
    expect(metrics.pathWidth, `${viewport.label} bounded path width`).toBeLessThanOrEqual(metrics.rowWidth);
    expect(metrics.pathBorderRadius, `${viewport.label} path border radius`).toBe("0px");
    expect(metrics.pathBorderWidth, `${viewport.label} path border`).toBe("0px");
    expect(metrics.overflow, `${viewport.label} projects overflow`).toBeLessThanOrEqual(0);
  }
});

test("project detail keeps workdir metadata readable in the detail pane", async ({ page }) => {
  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/#/projects/${projectSlug}`);
    await expect(page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" })).toBeVisible();
    const metrics = await page.evaluate(() => {
      const layout = document.querySelector(".project-read-layout");
      const row = document.querySelector(".project-workdir-row");
      const value = document.querySelector(".project-workdir-value");
      const layoutStyle = layout ? getComputedStyle(layout) : null;
      const rowRect = row?.getBoundingClientRect();
      const valueRect = value?.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        layoutColumns: layoutStyle?.gridTemplateColumns || "",
        rowHeight: rowRect ? Math.round(rowRect.height) : 0,
        valueWidth: valueRect ? Math.round(valueRect.width) : 0,
        valueLineCount: value ? value.getClientRects().length : 0,
      };
    });

    expect(metrics.overflow, `${viewport.label} project detail overflow`).toBeLessThanOrEqual(0);
    expect(metrics.layoutColumns.split(" ").length, `${viewport.label} project detail columns`).toBe(1);
    expect(metrics.valueWidth, `${viewport.label} workdir value width`).toBeGreaterThan(140);
    expect(metrics.valueLineCount, `${viewport.label} workdir line count`).toBeLessThanOrEqual(3);
    expect(metrics.rowHeight, `${viewport.label} workdir row height`).toBeLessThanOrEqual(76);
  }
});

test("resource editor rails collapse before form sections become cramped", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const route of [
    { label: "skill", hash: `#/library/skills/${skillName}`, title: "Regression Skill", layout: ".skill-editor-layout" },
    { label: "project", hash: `#/projects/${projectSlug}/edit`, title: "Mobile Layout Project", layout: ".project-editor-layout" },
  ]) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(page.locator(".pane-detail-head h2", { hasText: route.title })).toBeVisible();
    const metrics = await page.evaluate((layoutSelector) => {
      const layout = document.querySelector(layoutSelector);
      const layoutStyle = layout ? getComputedStyle(layout) : null;
      const sections = [...document.querySelectorAll(`${layoutSelector} .entity-editor-main > .form-section`)];
      const rail = document.querySelector(`${layoutSelector} > .entity-editor-rail`);
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        columns: layoutStyle?.gridTemplateColumns || "",
        minSectionWidth: sections.length
          ? Math.min(...sections.map((section) => Math.round(section.getBoundingClientRect().width)))
          : 0,
        railPosition: rail ? getComputedStyle(rail).position : "",
      };
    }, route.layout);

    expect(metrics.overflow, `${route.label} editor overflow`).toBeLessThanOrEqual(0);
    expect(metrics.columns.split(" ").length, `${route.label} editor columns`).toBe(1);
    expect(metrics.minSectionWidth, `${route.label} form width`).toBeGreaterThan(360);
    if (metrics.railPosition) {
      expect(metrics.railPosition, `${route.label} rail position`).toBe("static");
    }
  }
});

test("mobile resource list create actions move to a floating FAB", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const routes = [
    { hash: "#/library/agents", label: "New agent", target: /#\/library\/agents\/new/, toolbar: "resource" },
    { hash: "#/goals", label: "New goal", target: /#\/goals\/new/, toolbar: "resource" },
    { hash: "#/projects", label: "New project", target: /#\/projects\/new/, toolbar: "resource" },
    { hash: "#/library/skills", label: "New skill", target: /#\/library\/skills\/new/, toolbar: "resource" },
    { hash: "#/library/knowledge", label: "New entry", target: /#\/library\/knowledge\/new/, toolbar: "resource" },
    { hash: "#/library/teams", label: "New team", target: /#\/library\/teams\/new/, toolbar: "resource" },
    { hash: "#/settings/providers", label: "New provider", target: /#\/settings\/providers\/new/, toolbar: "resource" },
  ];

  for (const route of routes) {
    await page.goto(`${baseUrl}/${route.hash}`);
    await expect(page.locator(".pane-list-head").first()).toBeVisible();
    const fabButton = page.getByRole("button", { name: route.label }).and(page.locator(".resource-list-fab"));
    await expect(fabButton).toBeVisible();

    const metrics = await page.evaluate(({ toolbar }) => {
      const toolbarRoot = toolbar === "resource"
        ? document.querySelector(".resource-toolbar")
        : document.querySelector(".pane-list-head");
      const search = toolbarRoot?.querySelector(".search-field");
      const configTrigger = toolbarRoot?.querySelector(".resource-mobile-config-trigger");
      const actions = toolbarRoot?.querySelector(".resource-toolbar-actions");
      const inlineButtons = [...(toolbarRoot?.querySelectorAll(":scope > .button:not(.resource-list-fab)") || [])];
      const count = toolbarRoot?.querySelector(".resource-toolbar-count");
      const fab = document.querySelector(".resource-list-fab");
      const assistantLauncher = document.querySelector(".assistant-launcher");
      const nav = document.querySelector(".app-tabbar");
      const list = document.querySelector(".pane-list-body");
      const toolbarRect = toolbarRoot?.getBoundingClientRect();
      const searchRect = search?.getBoundingClientRect();
      const triggerRect = configTrigger?.getBoundingClientRect();
      const fabRect = fab?.getBoundingClientRect();
      const assistantRect = assistantLauncher?.getBoundingClientRect();
      const navRect = nav?.getBoundingClientRect();
      const actionStyles = actions ? getComputedStyle(actions) : null;
      const countStyles = count ? getComputedStyle(count) : null;
      const fabStyles = fab ? getComputedStyle(fab) : null;
      const listStyles = list ? getComputedStyle(list) : null;
      return {
        toolbarHeight: toolbarRect ? Math.round(toolbarRect.height) : 0,
        searchWidth: searchRect ? Math.round(searchRect.width) : 0,
        configTriggerDisplay: configTrigger ? getComputedStyle(configTrigger).display : "",
        searchAndTriggerSameRow: searchRect && triggerRect
          ? Math.round(triggerRect.top) < Math.round(searchRect.bottom)
            && Math.round(searchRect.top) < Math.round(triggerRect.bottom)
          : true,
        actionsDisplay: actionStyles?.display || "",
        countDisplay: countStyles?.display || "",
        visibleInlineButtonCount: inlineButtons
          .filter((button) => getComputedStyle(button).display !== "none")
          .length,
        fabDisplay: fabStyles?.display || "",
        fabWidth: fabRect ? Math.round(fabRect.width) : 0,
        fabHeight: fabRect ? Math.round(fabRect.height) : 0,
        fabRadius: fabStyles ? Math.round(parseFloat(fabStyles.borderRadius)) : 0,
        fabBottomBeforeNav: fabRect && navRect ? Math.round(fabRect.bottom) <= Math.round(navRect.top) + 1 : false,
        assistantAboveFab: assistantRect && fabRect
          ? Math.round(assistantRect.bottom) <= Math.round(fabRect.top) - 1
          : false,
        assistantRightAligned: assistantRect && fabRect
          ? Math.abs(Math.round(assistantRect.right) - Math.round(fabRect.right)) <= 1
          : false,
        listPaddingBottom: listStyles ? Math.round(parseFloat(listStyles.paddingBottom) || 0) : 0,
        documentScrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      };
    }, { toolbar: route.toolbar });

    expect(metrics.toolbarHeight, `${route.hash} compact header`).toBeLessThanOrEqual(96);
    expect(metrics.searchWidth, `${route.hash} search width`).toBeGreaterThanOrEqual(route.toolbar === "resource" ? 280 : 320);
    if (route.toolbar === "resource") {
      expect(["flex", "inline-flex"]).toContain(metrics.configTriggerDisplay);
      expect(metrics.searchAndTriggerSameRow, `${route.hash} search/config row`).toBe(true);
      expect(metrics.actionsDisplay, `${route.hash} action row hidden`).toBe("none");
      expect(metrics.countDisplay, `${route.hash} count hidden`).toBe("none");
    }
    expect(metrics.visibleInlineButtonCount, `${route.hash} inline create hidden`).toBe(0);
    expect(metrics.fabDisplay, `${route.hash} FAB visible`).toBe("flex");
    expect(metrics.fabWidth, `${route.hash} FAB width`).toBe(56);
    expect(metrics.fabHeight, `${route.hash} FAB height`).toBe(56);
    expect(metrics.fabRadius, `${route.hash} FAB radius`).toBeGreaterThanOrEqual(28);
    expect(metrics.fabBottomBeforeNav, `${route.hash} FAB above nav`).toBe(true);
    expect(metrics.assistantAboveFab, `${route.hash} assistant above FAB`).toBe(true);
    expect(metrics.assistantRightAligned, `${route.hash} assistant alignment`).toBe(true);
    expect(metrics.listPaddingBottom, `${route.hash} list bottom padding`).toBeGreaterThanOrEqual(72);
    expect(metrics.listPaddingBottom, `${route.hash} list bottom padding`).toBeLessThanOrEqual(96);
    expect(metrics.documentScrollHeight, `${route.hash} document height`).toBeLessThanOrEqual(metrics.viewportHeight);

    await fabButton.click();
    await expect(page).toHaveURL(route.target);
  }
});

test("mobile goals keep detail and editor actions reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(`${baseUrl}/#/goals/${goalId}`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "Mobile Layout Project" })).toBeVisible();
  await expect(page.locator(".app-mobile-action-dock .button", { hasText: "Run lead cycle" })).toBeVisible();
  await expect(page.locator(".app-mobile-action-dock .button", { hasText: "Edit" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "mobile goal detail actions");

  await page.goto(`${baseUrl}/#/goals/new`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "New goal" })).toBeVisible();
  await expect(page.locator(".app-mobile-action-dock .button", { hasText: "Create goal" })).toBeVisible();
  await expect(page.locator(".app-mobile-action-dock .button", { hasText: "Cancel" })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const dock = document.querySelector(".app-mobile-action-dock");
    const tabbar = document.querySelector(".app-tabbar");
    const buttons = [...document.querySelectorAll(".app-mobile-action-dock .button")];
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
      minButtonHeight: buttons.length ? Math.min(...buttons.map((button) => Math.round(button.getBoundingClientRect().height))) : 0,
      buttonOverflow: buttons.some((button) => button.scrollWidth > button.clientWidth + 1),
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.dockDisplay).toBe("flex");
  expect(metrics.tabbarDisplay).toBe("none");
  expect(metrics.minButtonHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.buttonOverflow).toBe(false);
});

test("goals missing detail degrades to a stable not-found state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/goals/not-a-real-goal`);

  await expect(page.locator(".empty-state", { hasText: "Goal not found" })).toBeVisible();
  await expect(page.locator(".loading-state", { hasText: "Loading goal" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "missing goal detail");
});

test("mobile Activity filters collapse into a configuration sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/runs`);
  await expect(page.locator(".activity-filter-card")).toBeVisible();

  await expect(page.locator(".activity-mobile-config-trigger")).toBeVisible();
  await expect(page.locator(".activity-filter-card .activity-filter-panel")).toBeHidden();
  await page.locator(".activity-mobile-config-trigger").click();

  const sheet = page.getByRole("dialog", { name: "Activity configuration" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".activity-filter-field", { hasText: "Agent" })).toBeVisible();
  await expect(sheet.locator(".activity-filter-field", { hasText: "Status" })).toBeVisible();
  await expect(sheet.locator(".activity-filter-date")).toBeVisible();
  const metrics = await mobileConfigSheetMetrics(page);
  expect(metrics.panelHeight).toBeLessThan(metrics.previousFixedHeight - 80);
  expect(metrics.panelBottom).toBeLessThanOrEqual(1);
  expect(metrics.bodyBottomGap).toBeLessThanOrEqual(16);
  expect(metrics.visibleChildren).toBeGreaterThanOrEqual(3);
});

test("commander stage and project filters share selector sizing", async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseUrl}/#/tasks`);
    await expect(page.locator(".commander-row").first()).toBeVisible();
    if (viewport.width <= 860) {
      await page.locator(".commander-mobile-config-trigger").click();
      await expect(page.getByRole("dialog", { name: "Task list configuration" })).toBeVisible();
    }

    const metrics = await page.evaluate(() => {
      function selectorMetrics(selector) {
        const root = document.querySelector(selector);
        const control = root?.matches("select")
          ? root
          : root?.querySelector(".select-trigger");
        const rect = control?.getBoundingClientRect();
        const styles = control ? getComputedStyle(control) : null;
        return {
          tagName: control?.tagName?.toLowerCase() || "",
          width: rect ? Math.round(rect.width) : 0,
          height: rect ? Math.round(rect.height) : 0,
          fontFamily: styles?.fontFamily || "",
          fontSize: styles?.fontSize || "",
        };
      }
      return {
        stage: selectorMetrics(".commander-stage-filter"),
        project: selectorMetrics(".commander-project-filter"),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });

    expect(metrics.stage.tagName).toBe("button");
    expect(metrics.project.tagName).toBe("button");
    expect(Math.abs(metrics.stage.width - metrics.project.width)).toBeLessThanOrEqual(1);
    expect(metrics.stage.height).toBe(metrics.project.height);
    expect(metrics.stage.fontFamily).toBe(metrics.project.fontFamily);
    expect(metrics.stage.fontSize).toBe(metrics.project.fontSize);
    expect(metrics.overflow).toBeLessThanOrEqual(0);
  }
});

test("mobile commander uses deliberate row density without exposing task ids", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();
  await expect(page.locator(".commander-row.selected").first()).toBeVisible();
  const touchTargetRow = page.locator(".commander-row").nth(1);
  await touchTargetRow.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await expect(touchTargetRow).toHaveClass(/selected/);
  const runningDetailRow = page.locator(".commander-row", { hasText: "Running detail task" });
  await expect(runningDetailRow.locator(".tool-token-name", { hasText: "mcp__worklab__journal_append" })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const row = document.querySelector(".commander-row");
    const densityRow = [...document.querySelectorAll(".commander-row")]
      .find((entry) => !entry.querySelector(".commander-live-line")) || row;
    const liveRow = [...document.querySelectorAll(".commander-row")]
      .find((entry) => entry.textContent?.includes("Running detail task"));
    const liveToken = [...(liveRow?.querySelectorAll(".commander-live-line .tool-token") || [])]
      .find((entry) => entry.querySelector(".tool-token-name")?.textContent?.includes("mcp__worklab__journal_append"));
    const liveName = liveToken?.querySelector(".tool-token-name");
    const liveArg = liveToken?.querySelector(".tool-token-arg");
    const selectedRow = document.querySelector(".commander-row.selected");
    const baseRow = document.querySelector(".commander-row:not(.selected)");
    const id = row?.querySelector(".commander-cell-id");
    const state = row?.querySelector(".commander-cell-state");
    const filter = document.querySelector(".commander-filter");
    const search = document.querySelector(".commander-filter .search-field");
    const tabs = document.querySelector(".commander-filter .tabs");
    const trigger = document.querySelector(".commander-mobile-config-trigger");
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
    const liveNameRect = liveName?.getBoundingClientRect();
    const liveArgRect = liveArg?.getBoundingClientRect();
    const liveTokenRect = liveToken?.getBoundingClientRect();
    const searchRect = search?.getBoundingClientRect();
    const tabsRect = tabs?.getBoundingClientRect();
    const triggerRect = trigger?.getBoundingClientRect();
    const triggerStyles = trigger ? getComputedStyle(trigger) : null;
    const liveNameStyles = liveName ? getComputedStyle(liveName) : null;
    const liveArgStyles = liveArg ? getComputedStyle(liveArg) : null;
    const navWidths = [...document.querySelectorAll(".app-tabbar a")]
      .map((entry) => Math.round(entry.getBoundingClientRect().width));
    return {
      rowHeight: densityRow ? Math.round(densityRow.getBoundingClientRect().height) : 0,
      filterHeight: filter ? Math.round(filter.getBoundingClientRect().height) : 0,
      searchWidth: searchRect ? Math.round(searchRect.width) : 0,
      searchTop: searchRect ? Math.round(searchRect.top) : 0,
      configTriggerDisplay: triggerStyles?.display || "",
      configTriggerWidth: triggerRect ? Math.round(triggerRect.width) : 0,
      configTriggerHeight: triggerRect ? Math.round(triggerRect.height) : 0,
      configTriggerSameRow: searchRect && triggerRect
        ? Math.abs(Math.round(searchRect.top) - Math.round(triggerRect.top)) <= 2
        : false,
      configTriggerAfterSearch: searchRect && triggerRect
        ? Math.round(triggerRect.left) >= Math.round(searchRect.right)
        : false,
      filtersCollapsed: tabsRect ? Math.round(tabsRect.height) === 0 : true,
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
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      viewportMeta,
      bodyTouchAction: bodyStyles.touchAction,
      rowTouchAction: rowStyles?.touchAction || "",
      liveToolName: liveName?.textContent?.trim() || "",
      liveToolValue: liveArg?.textContent?.trim() || "",
      liveToolNameWhiteSpace: liveNameStyles?.whiteSpace || "",
      liveToolValueWhiteSpace: liveArgStyles?.whiteSpace || "",
      liveToolInline: liveNameRect && liveArgRect
        ? Math.abs(Math.round(liveNameRect.top) - Math.round(liveArgRect.top)) <= 1
          && Math.round(liveArgRect.left) >= Math.round(liveNameRect.right) - 1
        : false,
      liveToolNameSingleLine: liveNameRect ? Math.round(liveNameRect.height) <= 22 : false,
      liveToolTokenSingleLine: liveTokenRect ? Math.round(liveTokenRect.height) <= 24 : false,
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
  expect(metrics.rowHeight).toBeLessThanOrEqual(120);
  expect(metrics.filterHeight).toBeLessThanOrEqual(80);
  expect(metrics.searchWidth).toBeGreaterThanOrEqual(280);
  expect(["flex", "inline-flex"]).toContain(metrics.configTriggerDisplay);
  expect(metrics.configTriggerWidth).toBeGreaterThanOrEqual(32);
  expect(metrics.configTriggerHeight).toBeGreaterThanOrEqual(32);
  expect(metrics.configTriggerSameRow).toBe(true);
  expect(metrics.configTriggerAfterSearch).toBe(true);
  expect(metrics.filtersCollapsed).toBe(true);
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
  expect(metrics.liveToolName).toBe("mcp__worklab__journal_append");
  expect(metrics.liveToolValue).toContain("mobile live preview value");
  expect(metrics.liveToolNameWhiteSpace).toBe("nowrap");
  expect(metrics.liveToolValueWhiteSpace).toBe("nowrap");
  expect(metrics.liveToolInline).toBe(true);
  expect(metrics.liveToolNameSingleLine).toBe(true);
  expect(metrics.liveToolTokenSingleLine).toBe(true);
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

test("mobile task list wraps badges below the visible title", async ({ page }) => {
  const suffix = Date.now();
  const title = "Mobile badge wrapping task title stays visible";
  const mobileProject = await requestJson("/api/projects", {
    method: "POST",
    body: {
      name: "Mobile badges",
      slug: `mobile-badge-overflow-${suffix}`,
    },
    ok: [201],
  });
  const mobileBadgeTaskId = await createTask(title, {
    project_id: mobileProject.project.id,
    run_policy: "auto_plan_execute",
    stage: "execute",
  });
  await requestJson(`/api/tasks/${mobileBadgeTaskId}/automations`, {
    method: "POST",
    body: {
      trigger: { type: "daily", hour: 10, minute: 30 },
      enabled: true,
    },
    ok: [201],
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  const row = page.locator(".commander-row", { hasText: title });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip")).toHaveCount(4);

  const metrics = await row.evaluate((node) => {
    const title = node.querySelector(".commander-title");
    const chips = [...node.querySelectorAll(".commander-cell-title-row > .chip")];
    const titleRect = title?.getBoundingClientRect();
    const chipRects = chips.map((chip) => chip.getBoundingClientRect());
    const rowRect = node.getBoundingClientRect();
    return {
      titleText: title?.textContent?.trim() || "",
      titleWidth: titleRect ? Math.round(titleRect.width) : 0,
      rowWidth: Math.round(rowRect.width),
      rowHeight: Math.round(rowRect.height),
      chipsBelowTitle: titleRect
        ? chipRects.every((rect) => Math.round(rect.top) >= Math.round(titleRect.bottom))
        : false,
      visibleChipCount: chipRects.filter((rect) => rect.width > 0 && rect.height > 0).length,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(metrics.titleText).toBe(title);
  expect(metrics.titleWidth).toBeGreaterThanOrEqual(200);
  expect(metrics.chipsBelowTitle).toBe(true);
  expect(metrics.visibleChipCount).toBe(4);
  expect(metrics.rowHeight).toBeLessThanOrEqual(128);
  expect(metrics.rowWidth).toBeLessThanOrEqual(390);
  expect(metrics.overflow).toBeLessThanOrEqual(0);
});

test("mobile task list stacks assistant launcher above new task", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();
  await expect(page.locator(".commander-new-task-fab")).toBeVisible();
  await expect(page.locator(".assistant-launcher")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const fab = document.querySelector(".commander-new-task-fab");
    const assistantLauncher = document.querySelector(".assistant-launcher");
    const nav = document.querySelector(".app-tabbar");
    const fabRect = fab?.getBoundingClientRect();
    const assistantLauncherRect = assistantLauncher?.getBoundingClientRect();
    const navRect = nav?.getBoundingClientRect();
    const fabCenterTarget = fabRect
      ? document.elementFromPoint(fabRect.left + fabRect.width / 2, fabRect.top + fabRect.height / 2)
      : null;
    return {
      fabLabel: fab?.getAttribute("aria-label") || "",
      assistantLauncherLabel: assistantLauncher?.getAttribute("aria-label") || "",
      fabBottomBeforeNav: fabRect && navRect ? Math.round(fabRect.bottom) <= Math.round(navRect.top) + 1 : false,
      assistantLauncherBottomBeforeFab: assistantLauncherRect && fabRect
        ? Math.round(assistantLauncherRect.bottom) <= Math.round(fabRect.top) - 1
        : false,
      assistantLauncherRightAligned: assistantLauncherRect && fabRect
        ? Math.abs(Math.round(assistantLauncherRect.right) - Math.round(fabRect.right)) <= 1
        : false,
      fabCenterTargetIsFab: !!fabCenterTarget?.closest?.(".commander-new-task-fab"),
    };
  });

  expect(metrics.fabLabel).toBe("New task");
  expect(metrics.assistantLauncherLabel).toBe("Open assistant");
  expect(metrics.fabBottomBeforeNav).toBe(true);
  expect(metrics.assistantLauncherBottomBeforeFab).toBe(true);
  expect(metrics.assistantLauncherRightAligned).toBe(true);
  expect(metrics.fabCenterTargetIsFab).toBe(true);

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
    const status = document.querySelector(".task-hero-status-row");
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
      statusInsideHeader: head && status
        ? Math.ceil(status.getBoundingClientRect().bottom - head.getBoundingClientRect().bottom) <= 0
        : false,
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
  expect(beforeFocus.statusInsideHeader).toBe(true);
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
    const dockRect = dock?.getBoundingClientRect();
    return {
      inputHeight: input ? Math.round(input.getBoundingClientRect().height) : 0,
      keyboardOpen: document.documentElement.classList.contains("keyboard-open"),
      tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      dockTransform: dock ? getComputedStyle(dock).transform : "",
      dockBottomBeforeNav: dockRect ? Math.round(dockRect.bottom) <= window.innerHeight + 1 : false,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(afterFocus.inputHeight).toBeGreaterThanOrEqual(84);
  expect(afterFocus.keyboardOpen).toBe(false);
  expect(afterFocus.tabbarDisplay).toBe("none");
  expect(afterFocus.dockDisplay).toBe("flex");
  expect(afterFocus.dockTransform).toBe("none");
  expect(afterFocus.dockBottomBeforeNav).toBe(true);
  expect(afterFocus.overflow).toBeLessThanOrEqual(0);
});

test("mobile task detail review wraps idle dock actions into two rows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks/${desktopReviewTaskId}`);
  await expect(page.locator(".task-hero-title", { hasText: "Desktop review task" })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const dock = document.querySelector(".app-mobile-action-dock");
    const assistantLauncher = document.querySelector(".assistant-launcher");
    const buttons = dock ? [...dock.querySelectorAll(".button")] : [];
    const rows = [];
    for (const button of buttons) {
      const top = Math.round(button.getBoundingClientRect().top);
      if (!rows.some((rowTop) => Math.abs(rowTop - top) <= 4)) rows.push(top);
    }
    const dockRect = dock?.getBoundingClientRect();
    const assistantRect = assistantLauncher?.getBoundingClientRect();
    const appBody = document.querySelector(".app-body");
    const bodyPaddingBottom = appBody ? Math.round(parseFloat(getComputedStyle(appBody).paddingBottom) || 0) : 0;
    return {
      labels: buttons.map((button) => button.textContent.replace(/\s+/g, " ").trim()),
      rowCount: rows.length,
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      dockHeight: dockRect ? Math.round(dockRect.height) : 0,
      bodyPaddingBottom,
      dockInsideViewport: dockRect ? Math.round(dockRect.bottom) <= window.innerHeight + 1 : false,
      assistantAboveDock: dockRect && assistantRect
        ? Math.round(assistantRect.bottom) <= Math.round(dockRect.top) - 1
        : false,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(metrics.labels).toEqual(["Edit", "Run input", "Run review", "Approve", "Request changes"]);
  expect(metrics.dockDisplay).toBe("flex");
  expect(metrics.rowCount).toBe(2);
  expect(metrics.bodyPaddingBottom).toBeGreaterThanOrEqual(metrics.dockHeight - 1);
  expect(metrics.dockInsideViewport).toBe(true);
  expect(metrics.assistantAboveDock).toBe(true);
  expect(metrics.overflow).toBeLessThanOrEqual(0);
});

test("mobile task detail omits redundant header labels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks/${taskId}`);
  await expect(page.locator(".task-hero-title", { hasText: "UI regression task" })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const head = document.querySelector(".task-detail-head");
    const title = head?.querySelector(".task-hero-title");
    const idPrefix = head?.querySelector(".id-prefix");
    const kicker = head?.querySelector(".kicker");
    const status = head?.querySelector(".task-hero-status-row");
    const headRect = head?.getBoundingClientRect();
    const titleRect = title?.getBoundingClientRect();
    return {
      headingText: title?.innerText?.replace(/\s+/g, " ").trim() || "",
      idPrefixDisplay: idPrefix ? getComputedStyle(idPrefix).display : "",
      kickerDisplay: kicker ? getComputedStyle(kicker).display : "",
      titleWidth: titleRect ? Math.round(titleRect.width) : 0,
      headWidth: headRect ? Math.round(headRect.width) : 0,
      statusInsideHeader: head && status
        ? Math.ceil(status.getBoundingClientRect().bottom - head.getBoundingClientRect().bottom) <= 0
        : false,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(metrics.headingText).toBe("UI regression task");
  expect(metrics.idPrefixDisplay).toBe("none");
  expect(metrics.kickerDisplay).toBe("none");
  expect(metrics.titleWidth).toBeLessThanOrEqual(metrics.headWidth);
  expect(metrics.statusInsideHeader).toBe(true);
  expect(metrics.overflow).toBeLessThanOrEqual(0);
});

test("mobile new task dock stays anchored when autofocus does not open the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks/new`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();
  await expect(page.locator(".app-mobile-action-dock .button").first()).toBeVisible();
  await page.locator(".task-edit-body input[type='text']").first().fill("Create a compact mobile task header that stays readable while the title is being entered");

  const metrics = await page.evaluate(() => {
    const appBody = document.querySelector(".app-body");
    const header = document.querySelector(".task-edit-task-head");
    const title = document.querySelector(".task-edit-task-head .title-copy h2");
    const dock = document.querySelector(".app-mobile-action-dock");
    const tabbar = document.querySelector(".app-tabbar");
    const active = document.activeElement;
    const headerRect = header?.getBoundingClientRect();
    const titleRect = title?.getBoundingClientRect();
    const titleStyles = title ? getComputedStyle(title) : null;
    const dockRect = dock?.getBoundingClientRect();
    const parsePx = (value) => Math.round(parseFloat(value) || 0);
    const lineHeight = titleStyles ? parseFloat(titleStyles.lineHeight) || 0 : 0;
    return {
      activeTag: active?.tagName || "",
      keyboardOpen: document.documentElement.classList.contains("keyboard-open"),
      bodyPaddingBottom: appBody ? parsePx(getComputedStyle(appBody).paddingBottom) : 0,
      headerHeight: headerRect ? Math.round(headerRect.height) : 0,
      titleText: title?.textContent?.trim() || "",
      titleHeight: titleRect ? Math.round(titleRect.height) : 0,
      titleLineHeight: Math.round(lineHeight),
      titleWhiteSpace: titleStyles?.whiteSpace || "",
      titleOverflow: titleStyles?.overflow || "",
      titleInsideHeader: headerRect && titleRect
        ? Math.round(titleRect.bottom) <= Math.round(headerRect.bottom)
        : false,
      dockDisplay: dock ? getComputedStyle(dock).display : "",
      dockTransform: dock ? getComputedStyle(dock).transform : "",
      dockHeight: dockRect ? Math.round(dockRect.height) : 0,
      dockTop: dockRect ? Math.round(dockRect.top) : -1,
      dockBottom: dockRect ? Math.round(dockRect.bottom) : 0,
      tabbarDisplay: tabbar ? getComputedStyle(tabbar).display : "",
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });

  expect(["INPUT", "TEXTAREA"]).toContain(metrics.activeTag);
  expect(metrics.keyboardOpen).toBe(false);
  expect(metrics.titleText).toContain("Create a compact mobile task header");
  expect(metrics.headerHeight).toBeGreaterThanOrEqual(92);
  expect(metrics.titleHeight).toBeGreaterThanOrEqual(metrics.titleLineHeight * 2 - 2);
  expect(metrics.titleInsideHeader).toBe(true);
  expect(metrics.titleWhiteSpace).not.toBe("nowrap");
  expect(metrics.dockDisplay).toBe("flex");
  expect(metrics.dockTransform).toBe("none");
  expect(metrics.dockTop).toBeGreaterThanOrEqual(0);
  expect(metrics.dockBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.bodyPaddingBottom).toBe(metrics.dockHeight);
  expect(metrics.tabbarDisplay).toBe("none");
  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.viewportHeight);
});

test("assistant composer clears the keyboard while keeping input controls visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("worklab.assistantDockOpen", "open");
    } catch {}
  });

  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".assistant-dock.open")).toBeVisible();
  await expect(page.locator(".assistant-composer")).toBeVisible();

  const readState = () => page.evaluate(() => {
    const composer = document.querySelector(".assistant-composer");
    const thread = document.querySelector(".assistant-thread");
    const textarea = document.querySelector(".assistant-composer .textarea");
    const submit = document.querySelector(".assistant-composer-submit");
    const composerRect = composer?.getBoundingClientRect();
    const textareaRect = textarea?.getBoundingClientRect();
    const submitRect = submit?.getBoundingClientRect();
    const composerStyles = composer ? getComputedStyle(composer) : null;
    const threadStyles = thread ? getComputedStyle(thread) : null;
    const threadSpacerStyles = thread ? getComputedStyle(thread, "::after") : null;
    const transform = composerStyles?.transform || "none";
    let transformY = 0;
    if (transform && transform !== "none") {
      const match = transform.match(/matrix(?:3d)?\(([^)]+)\)/);
      const parts = match ? match[1].split(",").map((part) => parseFloat(part.trim())) : [];
      transformY = Math.round(parts.length === 16 ? parts[13] : parts[5] || 0);
    }
    const keyboardHeight = Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--worklab-keyboard-height")) || 0);
    const visibleBottom = window.visualViewport ? Math.round(window.visualViewport.height + window.visualViewport.offsetTop) : window.innerHeight;
    return {
      paddingBottom: composerStyles ? Math.round(parseFloat(composerStyles.paddingBottom) || 0) : -1,
      transform,
      transformY,
      threadScrollPaddingBottom: threadStyles ? Math.round(parseFloat(threadStyles.scrollPaddingBottom) || 0) : -1,
      threadSpacerFlexBasis: threadSpacerStyles ? Math.round(parseFloat(threadSpacerStyles.flexBasis) || 0) : -1,
      keyboardOpenClass: document.documentElement.classList.contains("keyboard-open"),
      activeTag: document.activeElement ? document.activeElement.tagName : "",
      keyboardHeight,
      visibleBottom,
      composerBottom: composerRect ? Math.round(composerRect.bottom) : -1,
      textareaBottom: textareaRect ? Math.round(textareaRect.bottom) : -1,
      submitBottom: submitRect ? Math.round(submitRect.bottom) : -1,
    };
  });

  // At rest the composer pads max(sp-2, env(safe-area-inset-bottom)). Chromium reports
  // env=0 on desktop, so paddingBottom collapses to sp-2 (8px). On a real iPhone PWA
  // the same rule produces ~34px — that's what the user wants preserved.
  const rest = await readState();
  expect(rest.keyboardOpenClass).toBe(false);
  expect(rest.paddingBottom).toBeGreaterThanOrEqual(8);

  await page.locator(".assistant-composer .textarea").focus();
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (vv) {
      Object.defineProperty(vv, "height", { configurable: true, value: 520 });
      Object.defineProperty(vv, "offsetTop", { configurable: true, value: 0 });
      vv.dispatchEvent(new Event("resize"));
    }
  });
  await page.waitForTimeout(360);

  const open = await readState();
  expect(open.keyboardOpenClass).toBe(true);
  expect(open.keyboardHeight).toBeGreaterThan(150);
  expect(open.paddingBottom).toBeLessThan(48);
  expect(open.transform).not.toBe("none");
  expect(open.transformY).toBeLessThanOrEqual(-open.keyboardHeight + 1);
  expect(open.composerBottom).toBeLessThanOrEqual(open.visibleBottom + 1);
  expect(open.threadScrollPaddingBottom).toBeGreaterThan(open.keyboardHeight);
  expect(open.threadSpacerFlexBasis).toBeGreaterThan(open.keyboardHeight);
  expect(open.textareaBottom).toBeLessThanOrEqual(open.visibleBottom - 8);
  expect(open.submitBottom).toBeLessThanOrEqual(open.visibleBottom - 8);

  // Synthesize the iOS keyboard collapsing.
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (vv) {
      Object.defineProperty(vv, "height", { configurable: true, value: window.innerHeight });
      Object.defineProperty(vv, "offsetTop", { configurable: true, value: 0 });
      vv.dispatchEvent(new Event("resize"));
    }
  });
  await page.waitForTimeout(360);

  const dismissed = await readState();
  expect(dismissed.keyboardOpenClass).toBe(false);
  expect(dismissed.paddingBottom).toBe(rest.paddingBottom);
  expect(dismissed.transformY).toBe(0);
});

test("keyboard-open class clears on focusout even when visualViewport stays shrunk", async ({ page }) => {
  // Stresses the proactive cleanup path: the user dismisses the keyboard via blur and
  // iOS lazy-reports visualViewport, leaving .keyboard-open stuck without the runtime's
  // focusout-driven force-clear.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks/${taskId}/edit`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();

  const titleInput = page.locator("input[type='text']").first();
  await expect(titleInput).toBeVisible();

  await titleInput.focus();
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (vv) {
      Object.defineProperty(vv, "height", { configurable: true, value: 520 });
      Object.defineProperty(vv, "offsetTop", { configurable: true, value: 0 });
      vv.dispatchEvent(new Event("resize"));
    }
  });
  await page.waitForTimeout(360);
  expect(await page.evaluate(() => document.documentElement.classList.contains("keyboard-open"))).toBe(true);

  // Blur the input WITHOUT dispatching a visualViewport.resize — emulates iOS lagging
  // its visualViewport report after a Done-button or tap-outside dismiss.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active && typeof active.blur === "function") active.blur();
  });
  await page.waitForTimeout(80);

  expect(await page.evaluate(() => document.documentElement.classList.contains("keyboard-open"))).toBe(false);
});

test("body and assistant dock stay at full viewport height even while keyboard-open is set", async ({ page }) => {
  // The user-reported "empty band at the bottom that stays forever" was caused by
  // CSS rules clamping body / .assistant-dock to a stale --vv-height when iOS 26
  // lazy-reports visualViewport (WebKit bug 301857, fixed in 26.1). We dropped
  // both clamps; both must stay at the real viewport height regardless of
  // .keyboard-open state or how stale --vv-height becomes.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("worklab.assistantDockOpen", "open");
    } catch {}
  });
  await page.goto(`${baseUrl}/#/tasks/${taskId}/edit`);
  await expect(page.locator(".task-edit-head").first()).toBeVisible();

  await page.locator("input[type='text']").first().focus();
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (vv) {
      Object.defineProperty(vv, "height", { configurable: true, value: 520 });
      Object.defineProperty(vv, "offsetTop", { configurable: true, value: 0 });
      vv.dispatchEvent(new Event("resize"));
    }
  });
  await page.waitForTimeout(360);

  const metrics = await page.evaluate(() => {
    const dock = document.querySelector(".assistant-dock");
    return {
      keyboardOpen: document.documentElement.classList.contains("keyboard-open"),
      innerHeight: window.innerHeight,
      bodyHeight: Math.round(document.body.getBoundingClientRect().height),
      dockHeight: dock ? Math.round(dock.getBoundingClientRect().height) : null,
    };
  });
  expect(metrics.keyboardOpen).toBe(true);
  // Body height must equal the real viewport height — NOT --vv-height (520).
  expect(metrics.bodyHeight).toBe(metrics.innerHeight);
  // Assistant dock must also stay at full viewport height — not collapse to --vv-height.
  if (metrics.dockHeight != null) {
    expect(metrics.dockHeight).toBe(metrics.innerHeight);
  }
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
    { hash: "#/library/agents/new", title: "New agent", back: "All agents", entityEditor: true },
    { hash: "#/library/skills/new", title: "New skill", back: "All skills", entityEditor: true },
    { hash: "#/library/knowledge/new", title: "New entry", back: "Knowledge", entityEditor: true },
    { hash: "#/settings/providers/new", title: "New provider", back: "Providers", entityEditor: true },
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
  await page.goto(`${baseUrl}/#/runs`);
  await expect(page.locator(".activity-row").first()).toBeVisible();
  await expect(page.locator(".activity-mobile-config-trigger")).toBeVisible();
  await expect(page.locator(".activity-filter-card .activity-filter-panel")).toBeHidden();
  await expect(page.locator(".activity-stat-card", { hasText: "Cost history" })).toBeVisible();
  await expect(page.locator(".activity-stat-card", { hasText: "Run Health" })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const filters = document.querySelector(".activity-filter-card .activity-filter-panel");
    const row = document.querySelector(".activity-row");
    const status = row?.querySelector(".status-pill");
    const time = row?.querySelector(".activity-time");
    const stats = [...document.querySelectorAll(".activity-stat-card")];
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      filtersVisible: filters ? !!(filters.offsetWidth || filters.offsetHeight || filters.getClientRects().length) : false,
      filterColumns: filters ? getComputedStyle(filters).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      rowColumns: row ? getComputedStyle(row).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
      rowWidth: row ? Math.round(row.getBoundingClientRect().width) : 0,
      rowRadius: row ? parseFloat(getComputedStyle(row).borderRadius) : 0,
      statusVisible: status ? status.getBoundingClientRect().width > 0 : false,
      timeVisible: time ? time.getBoundingClientRect().width > 0 : false,
      statCount: stats.length,
      statColumns: stats.length
        ? getComputedStyle(stats[0].parentElement).gridTemplateColumns.split(" ").filter(Boolean).length
        : 0,
      visualBars: document.querySelectorAll(".activity-cost-chart, .activity-health-bar").length,
    };
  });

  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.filtersVisible).toBe(false);
  expect(metrics.filterColumns).toBeGreaterThanOrEqual(1);
  expect(metrics.rowColumns).toBe(3);
  expect(metrics.rowWidth).toBeLessThanOrEqual(390);
  expect(metrics.rowRadius).toBeGreaterThanOrEqual(6);
  expect(metrics.statusVisible).toBe(true);
  expect(metrics.timeVisible).toBe(true);
  expect(metrics.statCount).toBe(2);
  expect(metrics.statColumns).toBe(2);
  expect(metrics.visualBars).toBeGreaterThanOrEqual(2);
  await expectNoHorizontalOverflow(page, "mobile activity rows");
  await expectNoCriticalHorizontalClipping(
    page,
    [
      ".activity-stat-label",
      ".activity-stat-value",
      ".activity-title",
      ".activity-meta",
      ".activity-time",
      ".activity-row-metric",
      ".status-pill-label",
    ].join(", "),
    "mobile activity rows",
  );
});

test("mobile assistant pane opens full width", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-row").first()).toBeVisible();

  await page.locator(".assistant-launcher").click();
  await expect(page.locator(".assistant-dock.open")).toBeVisible();
  await expect.poll(async () => page.locator(".assistant-dock.open").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return Math.round(rect.left);
  })).toBe(0);

  const metrics = await page.evaluate(() => {
    const dock = document.querySelector(".assistant-dock.open");
    const rect = dock?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      left: rect ? Math.round(rect.left) : null,
      right: rect ? Math.round(rect.right) : null,
      width: rect ? Math.round(rect.width) : null,
      viewportWidth: window.innerWidth,
    };
  });
  expect(metrics.left).toBe(0);
  expect(metrics.right).toBe(metrics.viewportWidth);
  expect(metrics.width).toBe(metrics.viewportWidth);
  expect(metrics.overflow).toBeLessThanOrEqual(0);
});

test("assistant composer keeps send button aligned and visible on narrow viewports", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("worklab.assistantDockOpen", "open");
  });

  for (const viewport of [
    { width: 1440, height: 900, label: "desktop" },
    { width: 820, height: 900, label: "tablet" },
    { width: 390, height: 844, label: "mobile" },
    { width: 320, height: 700, label: "narrow" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/?assistant-composer=${viewport.label}#/tasks`);
    await expect(page.locator(".assistant-dock.open")).toBeVisible();
    await expect(page.locator(".assistant-composer")).toBeVisible();

    const metrics = await page.evaluate(() => {
      const composer = document.querySelector(".assistant-composer");
      const textarea = composer?.querySelector(".textarea");
      const button = composer?.querySelector(".assistant-composer-submit");
      const icon = button?.querySelector("svg");
      const composerRect = composer?.getBoundingClientRect();
      const textareaRect = textarea?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      const iconRect = icon?.getBoundingClientRect();
      const buttonStyles = button ? getComputedStyle(button) : null;
      const iconStyles = icon ? getComputedStyle(icon) : null;
      return {
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        composerOverflow: composer ? Math.ceil(composer.scrollWidth - composer.clientWidth) : null,
        composerWidth: composerRect ? Math.round(composerRect.width) : 0,
        textareaWidth: textareaRect ? Math.round(textareaRect.width) : 0,
        textareaHeight: textareaRect ? Math.round(textareaRect.height) : 0,
        buttonWidth: buttonRect ? Math.round(buttonRect.width) : 0,
        buttonHeight: buttonRect ? Math.round(buttonRect.height) : 0,
        buttonMinWidth: buttonStyles?.minWidth || "",
        buttonMinHeight: buttonStyles?.minHeight || "",
        buttonPaddingLeft: buttonStyles ? Math.round(parseFloat(buttonStyles.paddingLeft)) : -1,
        buttonPaddingRight: buttonStyles ? Math.round(parseFloat(buttonStyles.paddingRight)) : -1,
        iconWidth: iconRect ? Math.round(iconRect.width) : 0,
        iconHeight: iconRect ? Math.round(iconRect.height) : 0,
        iconDisplay: iconStyles?.display || "",
        inline: textareaRect && buttonRect
          ? Math.round(textareaRect.right) <= Math.round(buttonRect.left)
          : false,
        bottomAligned: textareaRect && buttonRect
          ? Math.abs(Math.round(textareaRect.bottom) - Math.round(buttonRect.bottom)) <= 2
          : false,
      };
    });

    expect(metrics.pageOverflow, `${viewport.label} page overflow`).toBeLessThanOrEqual(0);
    expect(metrics.composerOverflow, `${viewport.label} composer overflow`).toBeLessThanOrEqual(1);
    expect(metrics.composerWidth, `${viewport.label} composer width`).toBeGreaterThan(0);
    expect(metrics.textareaWidth, `${viewport.label} textarea width`).toBeGreaterThanOrEqual(200);
    expect(metrics.textareaHeight, `${viewport.label} textarea height`).toBeGreaterThanOrEqual(44);
    expect(metrics.buttonWidth, `${viewport.label} button width`).toBe(44);
    expect(metrics.buttonHeight, `${viewport.label} button height`).toBe(44);
    expect(metrics.buttonMinWidth, `${viewport.label} button min-width`).toBe("44px");
    expect(metrics.buttonMinHeight, `${viewport.label} button min-height`).toBe("44px");
    expect(metrics.buttonPaddingLeft, `${viewport.label} button left padding`).toBe(0);
    expect(metrics.buttonPaddingRight, `${viewport.label} button right padding`).toBe(0);
    expect(metrics.iconWidth, `${viewport.label} icon width`).toBeGreaterThan(0);
    expect(metrics.iconHeight, `${viewport.label} icon height`).toBeGreaterThan(0);
    expect(metrics.iconDisplay, `${viewport.label} icon display`).toBe("block");
    expect(metrics.inline, `${viewport.label} composer inline layout`).toBe(true);
    expect(metrics.bottomAligned, `${viewport.label} composer bottom alignment`).toBe(true);
  }
});

test("assistant thread remains scrollable with long history", async ({ page }) => {
  const now = Date.now();
  const seededMessages = Array.from({ length: 28 }, (_, index) => ({
    id: `assistant-scroll-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    body: `Scrollable assistant message ${index + 1}. This seeded text makes the assistant thread taller than the viewport so the dock must keep the message list as the scroll container.`,
    status: "complete",
    created_at: now + index,
    updated_at: now + index,
  }));
  await page.route("**/api/assistant**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname === "/api/assistant/messages") {
      const before = url.searchParams.get("before");
      const beforeIndex = before
        ? seededMessages.findIndex((message) => message.id === before)
        : seededMessages.length;
      const end = beforeIndex < 0 ? seededMessages.length : beforeIndex;
      const start = Math.max(0, end - 5);
      const messages = seededMessages.slice(start, end);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          thread: { id: "personal", title: "Long assistant thread", created_at: now, updated_at: now },
          messages,
          history: {
            has_more: start > 0,
            before: before || null,
            next_before: messages[0]?.id || before || null,
            page_size: 5,
          },
        }),
      });
      return;
    }
    if (url.pathname !== "/api/assistant") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        thread: { id: "personal", title: "Long assistant thread", created_at: now, updated_at: now },
        active_run: null,
        messages: [],
        history: { has_more: true, before: null, page_size: 5 },
      }),
    });
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 820, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseUrl}/?assistant-scroll=${viewport.width}#/tasks`);
    await expect(page.locator(".commander-row").first()).toBeVisible();

    const launcher = page.locator(".assistant-launcher");
    if (await launcher.isVisible()) await launcher.click();
    await expect(page.locator(".assistant-dock.open")).toBeVisible();
    await expect(page.locator(".assistant-empty")).toBeVisible();
    for (const expectedCount of [5, 10, 15, 20, 25, 28]) {
      await page.getByRole("button", { name: "Load previous conversation" }).click();
      await expect.poll(async () => page.locator(".assistant-message").count()).toBe(expectedCount);
    }
    await expect(page.getByRole("button", { name: "Load previous conversation" })).toHaveCount(0);
    await expect(page.locator(".assistant-message").last()).toBeVisible();

    const metrics = await page.evaluate(() => {
      const thread = document.querySelector(".assistant-thread");
      if (!thread) return null;
      thread.scrollTop = 0;
      const initialScrollTop = thread.scrollTop;
      thread.scrollTop = 120;
      return {
        clientHeight: Math.round(thread.clientHeight),
        scrollHeight: Math.round(thread.scrollHeight),
        initialScrollTop,
        afterScrollTop: Math.round(thread.scrollTop),
        overflowY: getComputedStyle(thread).overflowY,
      };
    });

    expect(metrics?.overflowY, `${viewport.width} assistant thread overflow`).toBe("auto");
    expect(metrics?.scrollHeight, `${viewport.width} assistant thread content height`).toBeGreaterThan(metrics?.clientHeight || 0);
    expect(metrics?.afterScrollTop, `${viewport.width} assistant thread scrollTop`).toBeGreaterThan(metrics?.initialScrollTop || 0);

    await page.locator(".assistant-thread").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const beforeWheel = await page.locator(".assistant-thread").evaluate((node) => node.scrollTop);
    const threadBox = await page.locator(".assistant-thread").boundingBox();
    expect(threadBox).not.toBeNull();
    await page.mouse.move((threadBox?.x || 0) + (threadBox?.width || 0) / 2, (threadBox?.y || 0) + (threadBox?.height || 0) / 2);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(50);
    const afterWheel = await page.locator(".assistant-thread").evaluate((node) => node.scrollTop);
    expect(afterWheel, `${viewport.width} assistant thread wheel scroll`).toBeLessThan(beforeWheel);

    await page.locator(".assistant-dock.open [aria-label='Collapse assistant']").click();
    await expect(page.locator(".assistant-launcher")).toBeVisible();
  }
});

test("desktop unsaved changes modal keeps content and actions inside the dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/#/tasks/${taskId}/edit`);
  const titleInput = page.locator('input[placeholder*="actionable"]');
  await titleInput.fill("UI regression task with unsaved desktop edit");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal", { hasText: "You have unsaved changes" })).toBeVisible();

  const metrics = await modalLayoutMetrics(page);
  expect(metrics.overflow).toBeLessThanOrEqual(0);
  expect(metrics.width).toBeGreaterThanOrEqual(440);
  expect(metrics.width).toBeLessThanOrEqual(500);
  expect(metrics.bodyText).toContain("Your changes have not been saved.");
  expect(metrics.bodyVisible).toBe(true);
  expect(metrics.footerDisplay).toBe("flex");
  expect(metrics.buttonLabels).toEqual(["Keep editing", "Discard", "Save & leave"]);
  expect(metrics.buttonOverflow).toBe(false);
  expect(metrics.buttonsInsideFooter).toBe(true);
  expect(metrics.buttonsInsideModal).toBe(true);
  await expectNoCriticalHorizontalClipping(
    page,
    [".modal-head h2", ".modal-body", ".modal-foot .button"].join(", "),
    "desktop unsaved modal",
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

  const modalMetrics = await modalLayoutMetrics(page);
  expect(modalMetrics.overflow).toBeLessThanOrEqual(0);
  expect(modalMetrics.width).toBeLessThanOrEqual(390);
  expect(modalMetrics.bodyText).toContain("Your changes have not been saved.");
  expect(modalMetrics.bodyVisible).toBe(true);
  expect(modalMetrics.footerDisplay).toBe("grid");
  expect(modalMetrics.minButtonHeight).toBeGreaterThanOrEqual(44);
  expect(modalMetrics.maxButtonWidth).toBeLessThanOrEqual(390);
  expect(modalMetrics.buttonLabels).toEqual(["Keep editing", "Discard", "Save & leave"]);
  expect(modalMetrics.buttonOverflow).toBe(false);
  expect(modalMetrics.buttonsInsideFooter).toBe(true);
  expect(modalMetrics.buttonsInsideModal).toBe(true);
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

test("desktop New Task CTA keeps the N shortcut visually separated", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(`${baseUrl}/#/tasks`);
  await expect(page.locator(".commander-new-task-inline")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const cta = document.querySelector(".commander-new-task-inline");
    const label = cta?.querySelector(".button-label > span");
    const kbd = cta?.querySelector(".kbd");
    const labelRect = label?.getBoundingClientRect();
    const kbdRect = kbd?.getBoundingClientRect();
    const labelStyles = cta?.querySelector(".button-label")
      ? getComputedStyle(cta.querySelector(".button-label"))
      : null;
    const kbdStyles = kbd ? getComputedStyle(kbd) : null;
    return {
      labelText: label?.textContent || "",
      kbdText: kbd?.textContent || "",
      labelDisplay: labelStyles?.display || "",
      gap: labelRect && kbdRect ? Math.round(kbdRect.left - labelRect.right) : 0,
      marginLeft: kbdStyles?.marginLeft || "",
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  expect(metrics.labelText).toBe("New task");
  expect(metrics.kbdText).toBe("N");
  expect(["flex", "inline-flex"]).toContain(metrics.labelDisplay);
  expect(metrics.gap).toBeGreaterThanOrEqual(4);
  expect(metrics.marginLeft).toBe("4px");
  expect(metrics.overflow).toBeLessThanOrEqual(0);
});

test("provider creation uses a simple mobile provider-type select", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/settings/providers/new`);
  await expect(page.locator(".pane-detail-head h2", { hasText: "New provider" })).toBeVisible();
  await expect(page.locator(".provider-type-segmented")).toBeHidden();
  await expect(page.locator(".provider-type-select select")).toBeVisible();
  await expectNoHorizontalOverflow(page, "mobile provider new");
});

test("dropdown inside mobile bottom sheet portals out and stays visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/runs`);
  await expect(page.locator(".activity-mobile-config-trigger")).toBeVisible();
  await page.locator(".activity-mobile-config-trigger").click();

  const sheet = page.getByRole("dialog", { name: "Activity configuration" });
  await expect(sheet).toBeVisible();

  const statusField = sheet.locator(".activity-filter-field", { hasText: "Status" });
  const statusTrigger = statusField.locator(".select-trigger");
  await statusTrigger.click();

  const menu = page.locator(".select-menu").last();
  await expect(menu).toBeVisible();

  const layout = await page.evaluate(() => {
    const menus = document.querySelectorAll(".select-menu");
    const menuEl = menus[menus.length - 1];
    const sheetPanel = document.querySelector(".mobile-config-sheet.open .mobile-config-sheet-panel");
    const sheetHead = document.querySelector(".mobile-config-sheet.open .mobile-config-sheet-head");
    const styles = menuEl ? getComputedStyle(menuEl) : null;
    return {
      menuParentIsBody: menuEl?.parentElement === document.body,
      menuPosition: styles?.position || "",
      menuZ: Number(styles?.zIndex) || 0,
      menuVisible: menuEl ? menuEl.getBoundingClientRect().height > 0 : false,
      menuTop: menuEl?.getBoundingClientRect().top ?? 0,
      menuLeft: menuEl?.getBoundingClientRect().left ?? 0,
      menuRight: menuEl?.getBoundingClientRect().right ?? 0,
      sheetTop: sheetPanel?.getBoundingClientRect().top ?? 0,
      sheetHeadBottom: sheetHead?.getBoundingClientRect().bottom ?? 0,
      viewportWidth: window.innerWidth,
      sheetZ: sheetPanel ? Number(getComputedStyle(sheetPanel).zIndex) || 0 : 0,
    };
  });

  // Portal target: <body>, not the sheet panel.
  expect(layout.menuParentIsBody).toBe(true);
  expect(layout.menuPosition).toBe("fixed");
  // The Select menu must paint above the sheet — either by being below the
  // sheet's header band, or above it on the layer stack.
  expect(layout.menuVisible).toBe(true);
  expect(layout.menuZ).toBeGreaterThan(layout.sheetZ);
  // And it must stay inside the viewport (no off-screen clamp failure).
  expect(layout.menuLeft).toBeGreaterThanOrEqual(0);
  expect(layout.menuRight).toBeLessThanOrEqual(layout.viewportWidth + 1);

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
});
