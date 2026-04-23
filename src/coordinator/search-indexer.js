import { watch } from "chokidar";
import { join } from "node:path";
import { getEmbeddingModel, indexAllSources, indexPath } from "../core/embeddings.js";

const DEBOUNCE_MS = 500;

export function startSearchIndexer({ db, dataDir, broker, logger, events } = {}) {
  const timers = new Map();
  let stopped = false;
  let scanning = null; // in-flight scan promise, or null

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

  startScan("startup");

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
