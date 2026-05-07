export const DEFAULT_READ_LINES = 240;
export const MAX_READ_LINES = 500;
export const MAX_READ_LINE_CHARS = 2_000;
export const DEFAULT_MAX_READ_CHARS = 16_000;
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 16_000;
export const DEFAULT_MAX_BASH_OUTPUT_CHARS = 20_000;
export const MAX_WRITE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_EXCLUDED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  ".cache",
];
export const DEFAULT_EXCLUDED_FILES = ["*.map"];
export const DEFAULT_MAX_SEARCH_LINES = 100;
export const DEFAULT_MAX_SEARCH_CHARS = 16_000;
export const SEARCH_MAX_BUFFER = 4 * 1024 * 1024;
export const READ_HISTORY_LIMIT = 200;
