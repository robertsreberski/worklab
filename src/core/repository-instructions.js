import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shortHash } from "./context-cache.js";

export const REPOSITORY_INSTRUCTION_FILES = ["AGENTS.md"];
export const REPOSITORY_INSTRUCTIONS_MAX_CHARS = 24_000;
export const REPOSITORY_INSTRUCTIONS_PROMPT_SECTION = "Repository instructions";

export function loadRepositoryInstructions(workdir) {
  if (!workdir) return null;
  for (const filename of REPOSITORY_INSTRUCTION_FILES) {
    const path = join(workdir, filename);
    try {
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const raw = readFileSync(path, "utf8");
      const content = raw.length > REPOSITORY_INSTRUCTIONS_MAX_CHARS
        ? `${raw.slice(0, REPOSITORY_INSTRUCTIONS_MAX_CHARS)}\n...[truncated]`
        : raw;
      return {
        filename,
        path,
        content,
        hash: shortHash(raw),
        size: Buffer.byteLength(raw, "utf8"),
        truncated: raw.length > REPOSITORY_INSTRUCTIONS_MAX_CHARS,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function findRepositoryGitRoot(workdir) {
  if (!workdir) return null;
  let current = resolve(workdir);
  while (current) {
    const gitPath = join(current, ".git");
    try {
      const stat = statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch {
      // Continue walking to the parent.
    }
    const parent = dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return null;
}

export function repositoryInstructionsPromptMetadata(instructions) {
  if (!instructions) return null;
  return {
    recognized: true,
    filename: instructions.filename,
    path: instructions.path,
    hash: instructions.hash,
    size: instructions.size,
    truncated: !!instructions.truncated,
    injected_into_prompts: true,
    prompt_section: REPOSITORY_INSTRUCTIONS_PROMPT_SECTION,
  };
}

