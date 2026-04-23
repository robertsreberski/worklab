import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const ollamaUrl = (process.env.WORKLAB_E2E_OLLAMA_URL || "http://100.64.103.59:11434").replace(/\/+$/, "");

let serverProcess;
let baseUrl;
let dataDir;
let workspaceDir;
let chatModel;
let embeddingModel;
let output = "";

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

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
    if (processRef.exitCode !== null) throw new Error(`Worklab exited early:\n${output}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until the coordinator is listening.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for Worklab at ${url}:\n${output}`);
}

async function pickLiveModels() {
  const tags = await fetchJson(`${ollamaUrl}/api/tags`, { timeoutMs: 10_000 });
  const models = Array.isArray(tags.models) ? tags.models : [];
  if (models.length === 0) throw new Error(`Live Ollama endpoint has no models: ${ollamaUrl}`);

  for (const model of models) {
    const name = model.name || model.model;
    if (!name) continue;
    let show = {};
    try {
      show = await fetchJson(`${ollamaUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name }),
        timeoutMs: 10_000,
      });
    } catch {
      continue;
    }
    const capabilities = new Set(Array.isArray(show.capabilities)
      ? show.capabilities.map((capability) => String(capability).toLowerCase())
      : []);
    const supportsChat = capabilities.has("completion") || capabilities.has("chat");
    const embeddingOnly = capabilities.has("embedding") && !supportsChat;
    if (!chatModel && supportsChat) chatModel = name;
    if (!embeddingModel && embeddingOnly) embeddingModel = name;
    if (chatModel && embeddingModel) return;
  }

  if (!chatModel || !embeddingModel) {
    throw new Error(`Live Ollama smoke requires at least one chat model and one embedding-only model at ${ollamaUrl}`);
  }
}

test.beforeAll(async () => {
  await pickLiveModels();
  dataDir = mkdtempSync(join(tmpdir(), "worklab-pw-data-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worklab-pw-workspace-"));
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => { output += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { output += chunk.toString(); });
  await waitForHealth(baseUrl, serverProcess);
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

test("new user configures live Ollama provider and creates an agent with a runnable model", async ({ page }) => {
  const providerName = "Ollama LAN E2E";

  await page.goto(`${baseUrl}/#/providers`);
  await page.locator(".field", { hasText: "Name" }).locator("input").fill(providerName);
  await page.locator(".field", { hasText: "Base URL" }).locator("input").fill(ollamaUrl);
  await page.getByRole("button", { name: "Create provider" }).click();

  const providerCard = page.locator(".provider-card", { hasText: providerName });
  await expect(providerCard).toBeVisible();
  await providerCard.getByRole("button", { name: "Test" }).click();
  await expect(providerCard.locator(".status-line.ok")).toContainText("Reachable");

  await providerCard.getByRole("button", { name: "Discover" }).click();
  await expect(providerCard).toContainText(chatModel);
  await expect(providerCard).toContainText(embeddingModel);

  const embeddingRow = providerCard.locator(".provider-model", { hasText: embeddingModel });
  await expect(embeddingRow).toContainText(/Embedding-only|not runnable/i);
  await expect(embeddingRow.getByRole("button", { name: "Not runnable" })).toBeDisabled();

  const chatRow = providerCard.locator(".provider-model", { hasText: chatModel });
  await chatRow.getByRole("button", { name: "Enable" }).click();
  await expect(chatRow.getByRole("button", { name: "Disable" })).toBeVisible();

  await page.goto(`${baseUrl}/#/agents/new`);
  await page.locator(".field", { hasText: "Model" }).getByRole("combobox").click();
  await page.getByRole("option", { name: new RegExp(chatModel) }).click();
  await expect(page.locator(".field", { hasText: "Advanced model reference" }).locator("input")).toHaveValue(new RegExp(`:${chatModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.locator("body")).toContainText(/Tools:|This model does not support tool use/);

  await page.locator(".field", { hasText: "Display name" }).locator("input").fill("Ollama Smoke");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Ollama Smoke" })).toBeVisible();

  await page.goto(`${baseUrl}/#/providers`);
  await providerCard.locator(".provider-actions").getByRole("button", { name: "Disable" }).click();
  await page.goto(`${baseUrl}/#/agents/new`);
  await page.locator(".field", { hasText: "Model" }).getByRole("combobox").click();
  await expect(page.getByRole("option", { name: new RegExp(chatModel) })).toHaveCount(0);
});

test("providers page does not create horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#/providers`);
  const widths = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.innerWidth);
});
