import { watch } from "chokidar";
import { join } from "node:path";
import { getEmbeddingModel, getIndexStatus, indexAllSources, indexPath } from "../core/index.js";

const DEBOUNCE_MS = 500;
const DEFAULT_STARTUP_SCAN_DELAY_MS = 60_000;

export function searchStartupScanDelayMs({ indexed = 0, env = process.env } = {}) {
  const value = Number(env.WORKLAB_SEARCH_STARTUP_SCAN_DELAY_MS);
  if (Number.isFinite(value) && value >= 0) return value;
  if (Number(indexed || 0) > 0) return null;
  return DEFAULT_STARTUP_SCAN_DELAY_MS;
}

export function startSearchIndexer({ db, dataDir, broker, logger, events } = {}) {
  const timers = new Map();
  let stopped = false;
  let scanning = null; // in-flight scan promise, or null
  let startupScanTimer = null;

  const shouldStop = () => stopped;

  async function reindexFile(path) {
    if (stopped) return;
    try {
      await indexPath({ db, dataDir, filePath: path });
      broker?.broadcast?.("global", { type: "search_index_updated" });
    } catch (err) {
      logger?.warn?.({ err: err.message, path }, "search index update failed");
    }
  }

  function schedule(path) {
    if (!path) return;
    if (timers.has(path)) clearTimeout(timers.get(path));
    timers.set(path, setTimeout(() => {
      timers.delete(path);
      reindexFile(path);
    }, DEBOUNCE_MS));
  }

  function startScan(reason) {
    if (stopped) return null;
    if (scanning) return scanning;
    const promise = indexAllSources({ db, dataDir, shouldStop })
      .then((stats) => {
        logger?.info?.({ ...stats, reason }, "search index scan complete");
        broker?.broadcast?.("global", { type: "search_index_updated" });
        return stats;
      })
      .catch((err) => {
        logger?.warn?.({ err: err.message, reason }, "search index scan failed");
      })
      .finally(() => {
        if (scanning === promise) scanning = null;
      });
    scanning = promise;
    return promise;
  }

  const startupScanDelay = searchStartupScanDelayMs({ indexed: getIndexStatus(db).total });
  if (startupScanDelay != null) {
    startupScanTimer = setTimeout(() => {
      startupScanTimer = null;
      startScan("startup");
    }, startupScanDelay);
    startupScanTimer.unref?.();
  } else {
    logger?.info?.("search startup scan skipped; existing index will be refreshed by file events");
  }

  function onSettingsUpdated({ keys } = {}) {
    if (!keys?.includes?.("default_embedding_model")) return;
    if (!getEmbeddingModel(db)) return;
    if (scanning) return;
    startScan("settings_updated");
  }
  events?.on?.("settings:updated", onSettingsUpdated);

  const watcher = watch([
    join(dataDir, "knowledge", "*.md"),
    join(dataDir, "agents", "*", "JOURNAL.md"),
    join(dataDir, "agents", "*", "MEMORY.md"),
  ], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });
  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  watcher.on("error", (err) => logger?.warn?.({ err: err.message }, "search index watcher error"));

  return {
    async shutdown() {
      stopped = true;
      if (startupScanTimer) clearTimeout(startupScanTimer);
      startupScanTimer = null;
      events?.off?.("settings:updated", onSettingsUpdated);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await watcher.close();
      if (scanning) {
        try { await scanning; } catch { /* already logged */ }
      }
    },
    async reindexAll() {
      return indexAllSources({ db, dataDir, shouldStop });
    },
  };
}
