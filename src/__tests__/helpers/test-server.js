import supertest from "supertest";
import { Agent as HttpAgent, createServer as createHttpServer } from "node:http";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

const ROUTE_HEADER = "x-worklab-test-app";
const routedApps = new Map();
let nextRoutedAppId = 0;
let sharedHarness = null;

function testHarness() {
  if (sharedHarness) return sharedHarness;
  const server = createHttpServer((req, res) => {
    const app = routedApps.get(String(req.headers[ROUTE_HEADER] || ""));
    if (app) {
      app(req, res);
      return;
    }
    res.statusCode = 500;
    res.end("test app is not registered");
  });
  server.listen(0);
  server.unref();
  server.on("connection", (socket) => socket.unref());
  sharedHarness = {
    server,
    transportAgent: new HttpAgent({ keepAlive: true, maxSockets: 8 }),
  };
  return sharedHarness;
}

function routedTestAgent(app, defaultHeaders = {}) {
  const appId = String(++nextRoutedAppId);
  routedApps.set(appId, app);
  const { server, transportAgent } = testHarness();
  const client = supertest(server);
  return Object.fromEntries(
    ["get", "post", "put", "patch", "delete", "head", "options"]
      .map((method) => [method, (...args) => client[method](...args).agent(transportAgent).set({
        [ROUTE_HEADER]: appId,
        ...defaultHeaders,
      })]),
  );
}

export function sameOriginTestAgent(app) {
  return routedTestAgent(app, {
    host: "worklab-test.ts.net",
    origin: "http://worklab-test.ts.net",
    "sec-fetch-site": "same-origin",
  });
}

export function sameOriginFetch(url, init = {}) {
  const target = new URL(url);
  const headers = new Headers(init.headers || {});
  headers.set("origin", target.origin);
  headers.set("sec-fetch-site", "same-origin");
  return fetch(url, { ...init, headers });
}

export function makeTestServer({ watcher, dataDir, consolidation, automationManager, config, runtimeControls, updateControls, assistant, notifications, serviceStatus, acpControls, acpOperationManager, acpUrlHandoffStore } = {}) {
  const db = makeTestDb();
  const stubWatcher = watcher || {
    handleRunRequested: async () => ({ runId: "fake-run" }),
    cancel: () => true,
    shutdown: async () => {},
    isActive: () => false,
    isRunActive: () => false,
    getRunLiveInputState: () => ({ supported: false, active: false, reason: "unsupported_provider" }),
    sendRunMessage: async () => ({ ok: false, code: "run_not_active", message: "run is not active" }),
    maybeAutoStart: () => {},
    maybeAutoStartDependents: () => {},
    maybeScheduleUnassignedTeamTask: () => {},
  };
  const { app, broker, assistant: serverAssistant, acpOperationManager: serverAcpOperationManager } = createServer({
    db,
    logger: undefined,
    watcher: stubWatcher,
    dataDir,
    consolidation,
    automationManager,
    config,
    runtimeControls,
    updateControls,
    assistant,
    notifications,
    serviceStatus,
    acpControls,
    acpOperationManager,
    acpUrlHandoffStore,
  });
  const rawAgent = routedTestAgent(app);
  const agent = sameOriginTestAgent(app);
  return {
    app,
    broker,
    db,
    watcher: stubWatcher,
    assistant: serverAssistant,
    acpOperationManager: serverAcpOperationManager,
    agent,
    rawAgent,
  };
}
