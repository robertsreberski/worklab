#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const maxLines = Number(process.env.WORKLAB_MAX_SOURCE_LINES || 1200);
const extensions = new Set([".js", ".jsx"]);
const excludedParts = new Set(["node_modules", "dist", "__tests__"]);

function extension(path) {
  const match = /\.[^.]+$/.exec(path);
  return match ? match[0] : "";
}

function shouldSkip(path) {
  return relative(root, path).split(/[\\/]/).some((part) => excludedParts.has(part));
}

function walk(dir, files = []) {
  if (shouldSkip(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (shouldSkip(path)) continue;
    const info = statSync(path);
    if (info.isDirectory()) walk(path, files);
    else if (extensions.has(extension(path))) files.push(path);
  }
  return files;
}

const rows = walk(join(root, "src"))
  .map((path) => {
    const text = readFileSync(path, "utf8");
    return {
      path: relative(root, path),
      lines: text ? text.split(/\r?\n/).length : 0,
    };
  })
  .sort((a, b) => b.lines - a.lines);

const oversized = rows.filter((row) => row.lines > maxLines);
console.log(`guard-file-size: checked ${rows.length} production source files; max ${maxLines} lines.`);
console.log("guard-file-size: largest files:");
for (const row of rows.slice(0, 15)) {
  console.log(`${String(row.lines).padStart(5)} ${row.path}`);
}

if (oversized.length > 0) {
  console.error("\nguard-file-size: oversized files:");
  for (const row of oversized) console.error(`${row.lines} ${row.path}`);
  process.exit(1);
}
