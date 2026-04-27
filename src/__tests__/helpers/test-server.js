import supertest from "supertest";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

export function makeTestServer({ watcher, dataDir, consolidation, automationManager } = {}) {
  const db = makeTestDb();
  const stubWatcher = watcher || {
    handleRunRequested: async () => ({ runId: "fake-run" }),
    cancel: () => true,
    shutdown: async () => {},
    isActive: () => false,
    maybeAutoStart: () => {},
    maybeAutoStartDependents: () => {},
  };
  const { app, broker } = createServer({ db, logger: undefined, watcher: stubWatcher, dataDir, consolidation, automationManager });
  return { app, broker, db, watcher: stubWatcher, agent: supertest(app) };
}
