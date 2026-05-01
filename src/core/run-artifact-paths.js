import { join, resolve } from "node:path";

export function resolveRunArtifactDir({ workdir, runId } = {}) {
  if (!workdir || !runId) return null;
  return join(resolve(workdir), ".worklab-tmp", "artifacts", String(runId));
}
