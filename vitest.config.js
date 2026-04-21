import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.js"],
    coverage: {
      include: ["src/**/*.js"],
      exclude: ["src/__tests__/**", "src/ui/**"],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
});
