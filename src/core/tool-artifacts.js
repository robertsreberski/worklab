// Worklab's persistArtifact implementation for the agent runtime.
// The runtime's tool-bloat guard hands us a filename + buffer when a
// tool_result exceeds the cap; we write it under {runArtifactDir}/tool-output/.
// Returns the final on-disk path so the runtime can splice it into the
// truncation summary the agent sees in place of the original payload.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createToolOutputSink(runArtifactDir) {
  if (!runArtifactDir) return null;
  return ({ filename, buffer }) => {
    if (!filename || !buffer) return null;
    try {
      const dir = join(runArtifactDir, "tool-output");
      mkdirSync(dir, { recursive: true });
      const target = join(dir, filename);
      writeFileSync(target, buffer);
      return target;
    } catch {
      return null;
    }
  };
}
