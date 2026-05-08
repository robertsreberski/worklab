import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/__tests__/**/*.test.js",
      "packages/*/src/__tests__/**/*.test.js",
    ],
    minWorkers: 1,
    maxWorkers: 4,
    coverage: {
      include: ["src/**/*.js", "packages/*/src/**/*.js"],
      exclude: ["src/__tests__/**", "src/ui/**", "packages/*/src/__tests__/**"],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
});
