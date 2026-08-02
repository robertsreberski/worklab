import supertest from "supertest";
import { createServer as createHttpServer } from "node:http";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

export function sameOriginTestAgent(app) {
  const server = createHttpServer(app);
  server.listen(0);
  server.unref();
  const agent = supertest.agent(server).set({
    origin: "http://127.0.0.1",
    "sec-fetch-site": "same-origin",
  });
  let idleClose = null;
  const scheduleClose = () => {
    clearTimeout(idleClose);
    idleClose = setTimeout(() => {
      if (server.listening) server.close();
    }, 1_000);
    idleClose.unref?.();
  };
  return Object.fromEntries(
    ["get", "post", "put", "patch", "delete", "head", "options"]
      .map((method) => [method, (...args) => {
        clearTimeout(idleClose);
        if (!server.listening) {
          server.listen(0);
          server.unref();
        }
        const request = agent[method](...args);
        request.once("response", scheduleClose);
        request.once("error", scheduleClose);
        return request;
      }]),
  );
}

export function sameOriginFetch(url, init = {}) {
  const target = new URL(url);
  const headers = new Headers(init.headers || {});
  headers.set("origin", target.origin);
  headers.set("sec-fetch-site", "same-origin");
  return fetch(url, { ...init, headers });
}

export function makeTestServer({ watcher, dataDir, consolidation, automationManager, config, runtimeControls, updateControls, assistant, notifications, serviceStatus, acpControls, acpOperationManager } = {}) {
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
  });
  const rawAgent = supertest(app);
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
