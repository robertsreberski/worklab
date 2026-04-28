import supertest from "supertest";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

export function makeTestServer({ watcher, dataDir, consolidation, automationManager, config, runtimeControls } = {}) {
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
  };
  const { app, broker } = createServer({
    db,
    logger: undefined,
    watcher: stubWatcher,
    dataDir,
    consolidation,
    automationManager,
    config,
    runtimeControls,
  });
  return { app, broker, db, watcher: stubWatcher, agent: supertest(app) };
}
