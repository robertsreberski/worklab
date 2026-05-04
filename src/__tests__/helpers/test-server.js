import supertest from "supertest";
import { makeTestDb } from "./test-db.js";
import { createServer } from "../../api/server.js";

export function makeTestServer({ watcher, dataDir, consolidation, automationManager, config, runtimeControls, assistant, notifications } = {}) {
  const db = makeTestDb();
  // intelligence-ramp Phase 6: production default for task_instructions_min_chars
  // is 80 to push real briefs into the prompt. Existing fixtures POST tasks
  // with bare titles, so flip the check off here. Tests that exercise the
  // gate explicitly should re-enable via writeSettings.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('task_instructions_min_chars', '0')").run();
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
  const { app, broker, assistant: serverAssistant } = createServer({
    db,
    logger: undefined,
    watcher: stubWatcher,
    dataDir,
    consolidation,
    automationManager,
    config,
    runtimeControls,
    assistant,
    notifications,
  });
  return { app, broker, db, watcher: stubWatcher, assistant: serverAssistant, agent: supertest(app) };
}
