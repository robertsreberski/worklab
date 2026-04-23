// UX/UI audit harness — walks every route at three viewports, captures
// screenshots, and writes a findings JSON for the curated audit doc.
// Read-only inspection: never asserts on shape, only flags anomalies.

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const auditDir = join(repoRoot, "test-results", "ux-audit");

let serverProcess;
let baseUrl;
let dataDir;
let workspaceDir;
let seeded = {};
const findings = { generatedAt: null, routes: [], summary: {} };

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

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

async function api(path, { method = "GET", body, ok = [200, 201] } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!ok.includes(response.status)) {
    const text = await response.text();
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  }
  if (response.status === 204) return null;
  return await response.json();
}

async function seedFixtures() {
  // Tasks across statuses
  const t1 = await api("/api/tasks", { method: "POST", body: { title: "Audit fixture: todo task", description: "Used by ux-audit; lives in todo." }, ok: [201] });
  const t2 = await api("/api/tasks", { method: "POST", body: { title: "Audit fixture: in progress", description: "Carries `inline code` and a [link](https://example.com)." }, ok: [201] });
  await api(`/api/tasks/${t2.task.id}`, { method: "PATCH", body: { status: "in_progress" } });
  const t3 = await api("/api/tasks", { method: "POST", body: { title: "Audit fixture: in review", description: "Reviewer should approve." }, ok: [201] });
  await api(`/api/tasks/${t3.task.id}`, { method: "PATCH", body: { status: "in_review" } });
  const t4 = await api("/api/tasks", { method: "POST", body: { title: "Audit fixture: done", description: "Nothing further to do." }, ok: [201] });
  await api(`/api/tasks/${t4.task.id}`, { method: "PATCH", body: { status: "done" } });
  // Add a long descriptive task with code-fenced block to surface overflow
  const tCode = await api("/api/tasks", {
    method: "POST",
    body: {
      title: "Audit fixture: long content",
      description: [
        "This task description deliberately includes a very long URL that should not break the layout: https://this.is.a.very.long.subdomain.example.com/path/that/keeps/going/and/going/until/it/wraps/correctly.",
        "",
        "```json",
        '{ "this_is_a_long_key_that_will_force_horizontal_scroll": "and_a_value_that_keeps_going_for_a_while_to_make_sure_pre_blocks_wrap_on_mobile_viewports" }',
        "```",
      ].join("\n"),
    },
    ok: [201],
  });

  // Agent
  let agentName = "audit-agent";
  try {
    await api("/api/agents", {
      method: "POST",
      body: {
        name: agentName,
        display_name: "Audit Agent",
        sdk: "claude",
        model: "claude:claude-sonnet-4-6",
        effort: "medium",
        instructions: "Test agent for the UX audit harness. Do not run.",
        skills: [],
        mcp: [],
        builtin_tools: [],
        enabled: true,
      },
      ok: [201],
    });
  } catch (e) {
    if (!String(e.message).includes("409")) throw e;
  }

  // Skill
  let skillName = "audit-skill";
  try {
    await api("/api/skills", {
      method: "POST",
      body: {
        name: skillName,
        trigger: "When the user mentions 'ux audit'",
        priority: "normal",
        body: "# Audit Skill\n\nA fixture skill for the UX audit harness.\n\n- Bullet one\n- Bullet two",
        enabled: true,
      },
      ok: [201],
    });
  } catch (e) {
    if (!String(e.message).includes("409")) throw e;
  }

  // KB entries — one short, one long with tags + body content
  for (const entry of [
    { slug: "audit-welcome", title: "Audit welcome guide", category: "guide", tags: ["intro", "audit"], pinned: true, body: "# Welcome\n\nThis is a fixture KB entry for the UX audit." },
    { slug: "audit-mobile-reference", title: "Audit mobile layout reference", category: "reference", tags: ["very-long-tag-name-for-mobile-layout", "wrapping-check"], body: "## Long content\n\n" + "lorem ipsum dolor sit amet, ".repeat(40) },
  ]) {
    try {
      await api("/api/kb", { method: "POST", body: entry, ok: [201] });
    } catch (e) {
      if (!String(e.message).includes("409")) throw e;
      await api(`/api/kb/${entry.slug}`, { method: "PATCH", body: entry });
    }
  }

  return {
    taskId: t1.task.id,
    inProgressTaskId: t2.task.id,
    longContentTaskId: tCode.task.id,
    agentName,
    skillName,
    kbSlug: "audit-welcome",
  };
}

async function captureRouteFindings(page, routePath, viewport) {
  const collected = await page.evaluate(() => {
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    }
    function bgChain(el) {
      let cur = el;
      while (cur) {
        const cs = getComputedStyle(cur);
        if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") {
          return cs.backgroundColor;
        }
        cur = cur.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    }
    function selectorFor(el) {
      const id = el.id ? `#${el.id}` : "";
      const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => "." + c).join("");
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    }

    const overflow = {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };

    // Icon/SVG-only or empty-text buttons + links missing accessible name
    const interactive = Array.from(document.querySelectorAll("button, a, [role='button']"));
    const iconOnlyMissingName = [];
    for (const el of interactive) {
      if (!isVisible(el)) continue;
      const text = (el.innerText || "").trim();
      const aria = el.getAttribute("aria-label");
      const title = el.getAttribute("title");
      const hasSvg = !!el.querySelector("svg");
      if (!text && !aria && !title) {
        iconOnlyMissingName.push({ tag: el.tagName.toLowerCase(), selector: selectorFor(el), hasSvg });
      }
    }

    // Elements wider than the viewport (often the overflow culprit)
    const wideOffenders = [];
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > window.innerWidth + 4) {
        wideOffenders.push({ selector: selectorFor(el), width: Math.round(r.width), tag: el.tagName.toLowerCase() });
        if (wideOffenders.length >= 5) break;
      }
    }

    // Fixed/sticky elements (worth knowing what stays on screen)
    const sticky = [];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.position === "sticky") {
        sticky.push({ selector: selectorFor(el), position: cs.position });
        if (sticky.length >= 8) break;
      }
    }

    // Contrast smoke — text whose computed color matches its bg chain (a real fail)
    const contrastSmoke = [];
    const textNodes = document.querySelectorAll("body *");
    for (const el of textNodes) {
      if (!isVisible(el)) continue;
      if (!el.firstChild || el.firstChild.nodeType !== Node.TEXT_NODE) continue;
      const txt = (el.innerText || "").trim();
      if (txt.length < 2) continue;
      const cs = getComputedStyle(el);
      const bg = bgChain(el);
      if (cs.color && bg && cs.color === bg) {
        contrastSmoke.push({ selector: selectorFor(el), color: cs.color, bg, sample: txt.slice(0, 40) });
        if (contrastSmoke.length >= 5) break;
      }
    }

    // Modals / dialogs visible?
    const modalsVisible = Array.from(document.querySelectorAll(".modal, [role='dialog']"))
      .filter((el) => isVisible(el))
      .map((el) => ({ selector: selectorFor(el), width: Math.round(el.getBoundingClientRect().width) }));

    return { overflow, iconOnlyMissingName, wideOffenders, sticky, contrastSmoke, modalsVisible };
  });

  const consoleErrors = page._collectedConsoleErrors || [];
  page._collectedConsoleErrors = [];
  return {
    route: routePath,
    viewport: `${viewport.width}x${viewport.height}`,
    viewportName: viewport.name,
    ...collected,
    consoleErrors: consoleErrors.slice(0, 6),
  };
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-uxaudit-data-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worklab-uxaudit-workspace-"));
  mkdirSync(auditDir, { recursive: true });
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
  seeded = await seedFixtures();
  findings.generatedAt = new Date().toISOString();
});

test.afterAll(async () => {
  // Aggregate summary then write JSON
  let overflowCount = 0;
  let iconBtnCount = 0;
  let consoleErrorCount = 0;
  for (const r of findings.routes) {
    if (r.overflow?.hasHorizontalOverflow) overflowCount++;
    iconBtnCount += r.iconOnlyMissingName?.length || 0;
    consoleErrorCount += r.consoleErrors?.length || 0;
  }
  findings.summary = {
    routeCount: findings.routes.length,
    horizontalOverflowRoutes: overflowCount,
    totalIconOnlyButtonsMissingName: iconBtnCount,
    totalConsoleErrors: consoleErrorCount,
  };
  writeFileSync(join(auditDir, "findings.json"), JSON.stringify(findings, null, 2));

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

test("walk every route at three viewports, capture screenshots and findings", async ({ browser }) => {
  test.setTimeout(600_000);
  const routes = [
    { path: "/#/tasks", slug: "tasks" },
    { path: `/#/tasks/${seeded.taskId}`, slug: "task-detail" },
    { path: `/#/tasks/${seeded.longContentTaskId}`, slug: "task-detail-long" },
    { path: "/#/agents", slug: "agents" },
    { path: "/#/agents/new", slug: "agents-new" },
    { path: `/#/agents/${seeded.agentName}`, slug: "agents-edit" },
    { path: "/#/skills", slug: "skills" },
    { path: "/#/skills/new", slug: "skills-new" },
    { path: `/#/skills/${seeded.skillName}`, slug: "skills-edit" },
    { path: "/#/knowledge", slug: "knowledge" },
    { path: "/#/knowledge/new", slug: "knowledge-new" },
    { path: `/#/knowledge/${seeded.kbSlug}`, slug: "knowledge-edit" },
    { path: "/#/providers", slug: "providers" },
    { path: "/#/activity", slug: "activity" },
    { path: "/#/settings", slug: "settings" },
  ];

  const context = await browser.newContext();
  const page = await context.newPage();
  page._collectedConsoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") page._collectedConsoleErrors.push(msg.text().slice(0, 240));
  });
  page.on("pageerror", (err) => {
    page._collectedConsoleErrors.push(`pageerror: ${err.message}`.slice(0, 240));
  });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of routes) {
      page._collectedConsoleErrors = [];
      await page.goto(`${baseUrl}${route.path}`, { waitUntil: "domcontentloaded" }).catch(() => {});
      // small settle for SSE-driven content + initial paint
      await page.waitForLoadState("load").catch(() => {});
      await page.waitForTimeout(350);
      const screenshotPath = join(auditDir, `${viewport.name}-${route.slug}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const data = await captureRouteFindings(page, route.path, viewport);
      data.screenshot = `test-results/ux-audit/${viewport.name}-${route.slug}.png`;
      findings.routes.push(data);
    }
  }

  // Modal capture: open NewTaskModal at mobile viewport so we can audit it too
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/tasks`, { waitUntil: "domcontentloaded" });
  const newBtn = page.getByRole("button", { name: /new task/i });
  if (await newBtn.count()) {
    await newBtn.first().click();
    await page.waitForSelector(".modal", { timeout: 2000 }).catch(() => {});
    const screenshotPath = join(auditDir, `mobile-modal-newtask.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const data = await captureRouteFindings(page, "/#/tasks (modal: new task)", { name: "mobile", width: 390, height: 844 });
    data.screenshot = `test-results/ux-audit/mobile-modal-newtask.png`;
    findings.routes.push(data);
  }

  await context.close();

  // Phase 1+ enforces: no horizontal overflow on any route at any viewport.
  // Capture all violations so the failure message lists every offender.
  const overflowing = findings.routes.filter((r) => r.overflow?.hasHorizontalOverflow);
  const iconMissing = findings.routes.flatMap((r) => r.iconOnlyMissingName || []);
  console.log(`UX audit captured ${findings.routes.length} route×viewport snapshots.`);
  console.log(`Horizontal overflow on ${overflowing.length} snapshots.`);
  console.log(`Icon-only buttons missing accessible name: ${iconMissing.length} occurrences.`);
  expect(findings.routes.length).toBeGreaterThan(0);
  expect(
    overflowing.map((r) => `${r.viewport} ${r.route} (scroll=${r.overflow.scrollWidth} inner=${r.overflow.innerWidth})`),
    "Horizontal overflow on these snapshots — fix the layout, not this assertion",
  ).toEqual([]);
});

// ── Phase 2 behavior tests ─────────────────────────────────────────────────

test("save errors surface inline when the API rejects the patch", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/api/tasks/*", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Simulated server error" } }) });
    } else {
      await route.continue();
    }
  });
  await page.goto(`${baseUrl}/#/tasks/${seeded.taskId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await page.getByRole("button", { name: /^Save$/ }).click();
  await expect(page.locator(".form-error")).toContainText(/Save failed/i);
  await expect(page.locator(".form-error")).toContainText(/Simulated server error/);
  await context.close();
});

test("delete buttons require a second click to confirm", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  let deleteCalled = false;
  await page.route("**/api/tasks/*", async (route) => {
    if (route.request().method() === "DELETE") {
      deleteCalled = true;
      await route.fulfill({ status: 204, body: "" });
    } else {
      await route.continue();
    }
  });
  await page.goto(`${baseUrl}/#/tasks/${seeded.taskId}`, { waitUntil: "domcontentloaded" });
  const deleteBtn = page.getByRole("button", { name: /^(Delete|Click again to delete)$/ });
  await deleteBtn.click();
  // First click must NOT delete; the button arms instead
  expect(deleteCalled).toBe(false);
  await expect(deleteBtn).toHaveText(/Click again to delete/);
  await expect(deleteBtn).toHaveClass(/confirm-button-armed/);
  await deleteBtn.click();
  // Second click within the timeout window deletes
  await expect.poll(() => deleteCalled, { timeout: 3000 }).toBe(true);
  await context.close();
});

test("NewTaskModal recalls the last-used executor + reviewer", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseUrl}/#/tasks`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "+ New task" }).click();
  const modal = page.locator(".modal");
  await modal.locator("input").first().fill("Recall round-trip");
  const executorSelect = modal.locator("select").nth(0);
  await executorSelect.selectOption(seeded.agentName);
  await modal.getByRole("button", { name: /^Create$/ }).click();
  // Modal closes on success → re-open and verify the value persisted
  await page.getByRole("button", { name: "+ New task" }).click();
  await expect(page.locator(".modal select").nth(0)).toHaveValue(seeded.agentName);
  await context.close();
});

test("Activity page renders a distinct EmptyState when there are no runs", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  // Force the activity endpoint to return an empty list
  await page.route("**/api/activity*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ items: [], nextCursor: null }),
  }));
  await page.goto(`${baseUrl}/#/activity`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load").catch(() => {});
  await expect(page.locator(".empty-state")).toBeVisible();
  await expect(page.locator(".empty-state-title")).toHaveText(/No runs yet/);
  // CTA points back to the task board
  const cta = page.locator(".empty-state-cta a");
  await expect(cta).toHaveAttribute("href", "#/tasks");
  await context.close();
});

// Targeted regression for the Phase 1 grid-overflow fix. If a `1fr` grid
// trap reappears in TaskDetail, this catches it independently of the broader
// audit pass above.
test("TaskDetail with long unwrappable content does not overflow at any viewport", async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${baseUrl}/#/tasks/${seeded.longContentTaskId}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForTimeout(200);
    const widths = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(widths.scrollWidth, `${viewport.name} (${viewport.width}px) overflows: scrollWidth=${widths.scrollWidth}`)
      .toBeLessThanOrEqual(widths.innerWidth + 1);
  }
  await context.close();
});
