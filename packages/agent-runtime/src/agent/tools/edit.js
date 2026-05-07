import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isPathAllowed, resolveToolPath } from "./shared/path-resolver.js";

export async function editToolImpl({ file_path, old_string, new_string, replace_all = false, workdir }) {
  const target = resolveToolPath(file_path, workdir);
  if (!isPathAllowed(target, workdir)) return `Error: Path not allowed: ${file_path}`;
  if (!existsSync(target)) return `Error: File not found: ${file_path}`;
  const content = readFileSync(target, "utf8");
  const count = content.split(old_string).length - 1;
  if (count === 0) return `Error: old_string not found in ${target}`;
  if (!replace_all && count > 1) return `Error: old_string found ${count} times`;
  writeFileSync(target, replace_all ? content.replaceAll(old_string, new_string) : content.replace(old_string, new_string), "utf8");
  return `Successfully edited ${target}`;
}
