import { watch } from "chokidar";
import { join } from "node:path";
import { indexAllSources, indexPath } from "../core/embeddings.js";

const DEBOUNCE_MS = 500;

export function startSearchIndexer({ db, dataDir, broker, logger } = {}) {
  const timers = new Map();
  let stopped = false;

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

  indexAllSources({ db, dataDir })
    .then((stats) => {
      logger?.info?.(stats, "search index startup scan complete");
      broker?.broadcast?.("global", { type: "search_index_updated" });
    })
    .catch((err) => logger?.warn?.({ err: err.message }, "search index startup scan failed"));

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
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await watcher.close();
    },
    async reindexAll() {
      return indexAllSources({ db, dataDir });
    },
  };
}
