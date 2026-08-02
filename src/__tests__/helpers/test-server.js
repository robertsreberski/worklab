import supertest from "supertest";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

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
  return {
    app,
    broker,
    db,
    watcher: stubWatcher,
    assistant: serverAssistant,
    acpOperationManager: serverAcpOperationManager,
    agent: supertest(app),
  };
}
