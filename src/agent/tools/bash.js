import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { DEFAULT_MAX_BASH_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import {
  isPathAllowed,
  isWorkdirAllowed,
  workspaceRoot,
} from "./shared/path-resolver.js";

const execAsync = promisify(exec);

export async function bashToolImpl({ command, timeout = 120000, max_output_chars, workdir }) {
  if (workdir && !isWorkdirAllowed(workdir)) return `Error: Working directory not allowed: ${workdir}`;
  const cwd = workspaceRoot(workdir);
  if (!isPathAllowed(cwd, workdir)) return `Error: Working directory not allowed: ${cwd}`;
  if (!existsSync(cwd)) return `Error: Working directory not found: ${cwd}`;
  const maxChars = Number(max_output_chars) || DEFAULT_MAX_BASH_OUTPUT_CHARS;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      shell: "/bin/bash",
    });
    const output = stdout && stderr ? `STDOUT:\n${stdout}\nSTDERR:\n${stderr}` : (stdout || stderr || "(no output)");
    return capChars(output, { label: "Bash", maxChars, strategy: "head_tail" });
  } catch (err) {
    if (err.killed) return `Error: Command timed out after ${timeout}ms`;
    return capChars(`Exit code ${err.code || 1}:\n${err.stdout || ""}${err.stderr || err.message}`, {
      label: "Bash",
      maxChars,
      strategy: "head_tail",
    });
  }
}
