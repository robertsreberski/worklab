import { expect, test } from "@playwright/test";
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

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
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
      // The isolated server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Worklab at ${url}`);
}

function formInteraction(id, title, fieldLabel, createdAt = 1) {
  return {
    id,
    kind: "form",
    state: "pending",
    profileId: "11111111-1111-4111-8111-111111111111",
    taskRunId: `run-${id}`,
    createdAt,
    requestSchema: {
      mode: "form",
      title,
      message: `Input is required for ${title}.`,
      requestedSchema: {
        type: "object",
        required: ["answer"],
        properties: {
          answer: { type: "string", title: fieldLabel, minLength: 2 },
        },
      },
    },
  };
}

function urlInteraction(id = "url-handoff") {
  return {
    id,
    kind: "url",
    state: "pending",
    profileId: "11111111-1111-4111-8111-111111111111",
    operationId: `operation-${id}`,
    createdAt: 1,
    requestSchema: {
      mode: "url",
      message: "Continue in your browser.",
      urlAvailable: true,
    },
  };
}

async function routeInteractionApi(context, state) {
  await context.route("**/api/acp/interactions**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/acp/interactions") {
      const failure = state.listFailure?.();
      if (failure) {
        await route.fulfill({
          status: failure.status || 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: failure.code || "unavailable", message: failure.message } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ interactions: state.interactions() }),
      });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/url:open")) {
      await state.onOpen?.(request);
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Private handoff fixture</title><p>Fixture opened.</p>",
      });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/respond")) {
      const result = await state.onRespond?.(request);
      if (result?.error) {
        await route.fulfill({
          status: result.status || 502,
          contentType: "application/json",
          body: JSON.stringify({ error: result.error }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ interaction: result?.interaction || { state: "submitted" } }),
      });
      return;
    }
    if (request.method() === "POST" && pathname.endsWith("/cancel")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ interaction: { state: "cancelled" } }),
      });
      return;
    }
    await route.fallback();
  });
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "worklab-acp-browser-data-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worklab-acp-browser-workspace-"));
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["src/cli/index.js", "serve"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WORKLAB_DATA_DIR: dataDir,
      WORKLAB_WORKSPACE: workspaceDir,
      WORKLAB_HOST: "127.0.0.1",
      WORKLAB_PORT: String(port),
      WORKLAB_LOG_LEVEL: "error",
    },
    stdio: "ignore",
  });
  await waitForHealth(baseUrl, serverProcess);
});

test.afterAll(async () => {
  if (serverProcess?.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolveWait) => {
      const timeout = setTimeout(resolveWait, 5_000);
      serverProcess.once("exit", () => {
        clearTimeout(timeout);
        resolveWait();
      });
    });
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

test("opens an opaque URL handoff at most once through a hidden same-origin POST form", async ({ page, context }) => {
  let interactions = [urlInteraction()];
  let openCount = 0;
  const responseBodies = [];
  await routeInteractionApi(context, {
    interactions: () => interactions,
    onOpen: () => { openCount += 1; },
    onRespond: async (request) => {
      responseBodies.push(request.postDataJSON());
      interactions = [];
      return { interaction: { state: "submitted" } };
    },
  });

  await page.goto(baseUrl);
  const dialog = page.getByRole("dialog", { name: "Continue in your browser" });
  await expect(dialog).toBeVisible();
  const hiddenForm = page.locator("form[id^='acp-interaction-url-open-']");
  await expect(hiddenForm).toHaveAttribute("method", "post");
  await expect(hiddenForm).toHaveAttribute("target", "_blank");
  await expect(hiddenForm).toHaveAttribute("rel", "noopener noreferrer");
  await expect(hiddenForm).toHaveAttribute("action", /\/api\/acp\/interactions\/url-handoff\/url:open$/u);

  const rawUrlSentinel = "PRIVATE-HOST.example/PRIVATE-PATH?PRIVATE-KEY=PRIVATE-VALUE#PRIVATE-FRAGMENT";
  await expect(page.locator("body")).not.toContainText(rawUrlSentinel);
  await expect(page.locator("body")).toContainText("A private one-use browser handoff is ready.");

  const popupPromise = context.waitForEvent("page");
  await dialog.getByRole("button", { name: "Open link" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup).toHaveTitle("Private handoff fixture");
  await expect(dialog.getByRole("button", { name: "Link opened" })).toBeDisabled();

  await page.evaluate(() => document.querySelector("form[id^='acp-interaction-url-open-']")?.requestSubmit());
  await page.waitForTimeout(100);
  expect(openCount).toBe(1);

  await dialog.getByRole("button", { name: "Continue agent" }).click();
  await expect(dialog).toBeHidden();
  expect(responseBodies).toEqual([{ disposition: "accept", action: "accept" }]);
  await popup.close();
});

test("retains a private form draft after delivery failure and submits it on retry", async ({ page, context }) => {
  let interactions = [formInteraction("form-retry", "Agent input requested", "Decision note")];
  let respondCount = 0;
  const responseBodies = [];
  await routeInteractionApi(context, {
    interactions: () => interactions,
    onRespond: async (request) => {
      respondCount += 1;
      responseBodies.push(request.postDataJSON());
      if (respondCount === 1) {
        return {
          status: 502,
          error: { code: "interaction_delivery_failed", message: "The fixture could not deliver the response." },
        };
      }
      interactions = [];
      return { interaction: { state: "submitted" } };
    },
  });

  await page.goto(baseUrl);
  const dialog = page.getByRole("dialog", { name: "Agent input requested" });
  const answer = dialog.getByLabel("Decision note");
  await answer.fill("PRIVATE DRAFT RETAINED FOR RETRY");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(dialog.getByText("The fixture could not deliver the response.")).toBeVisible();
  await expect(answer).toHaveValue("PRIVATE DRAFT RETAINED FOR RETRY");
  await expect(page.locator("#acp-interaction-error")).toBeFocused();

  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(dialog).toBeHidden();
  expect(responseBodies).toEqual([
    { disposition: "accept", action: "accept", content: { answer: "PRIVATE DRAFT RETAINED FOR RETRY" } },
    { disposition: "accept", action: "accept", content: { answer: "PRIVATE DRAFT RETAINED FOR RETRY" } },
  ]);
  await expect(page.locator("body")).not.toContainText("PRIVATE DRAFT RETAINED FOR RETRY");
});

test("recovers an initial inbox load and focuses the newly available request", async ({ page, context }) => {
  let failing = true;
  const interaction = formInteraction("form-recovered", "Recovered request", "Recovery answer");
  await routeInteractionApi(context, {
    interactions: () => [interaction],
    listFailure: () => failing
      ? { status: 503, code: "unavailable", message: "fixture unavailable" }
      : null,
  });

  await page.goto(baseUrl);
  const alert = page.locator(".acp-interaction-load-error");
  await expect(alert).toContainText("Pending agent requests could not be loaded.");
  failing = false;
  await alert.getByRole("button", { name: "Retry" }).click();

  const dialog = page.getByRole("dialog", { name: "Recovered request" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Recovery answer")).toBeFocused();
});

test("reconciles a changing request queue with focus and no mobile overflow", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const first = formInteraction(
    "queue-first",
    "First queued request with a deliberately long mobile title",
    "First answer with a deliberately long mobile label",
    1,
  );
  const second = formInteraction(
    "queue-second",
    "Second queued request with a deliberately long mobile title",
    "Second answer with a deliberately long mobile label",
    2,
  );
  let interactions = [first, second];
  await routeInteractionApi(context, { interactions: () => interactions });

  await page.goto(baseUrl);
  const firstDialog = page.getByRole("dialog", { name: first.requestSchema.title });
  await expect(firstDialog.getByLabel(first.requestSchema.requestedSchema.properties.answer.title)).toBeFocused();
  await expect(firstDialog.getByText("1 of 2")).toBeVisible();

  interactions = [second];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const secondDialog = page.getByRole("dialog", { name: second.requestSchema.title });
  await expect(secondDialog).toBeVisible();
  await expect(secondDialog.getByText("1 of 1")).toBeVisible();
  await expect(secondDialog.getByLabel(second.requestSchema.requestedSchema.properties.answer.title)).toBeFocused();

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    dialogWidth: document.querySelector("[role='dialog']")?.getBoundingClientRect().width || 0,
  }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.dialogWidth).toBeLessThanOrEqual(layout.viewportWidth);
});
