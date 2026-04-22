import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "src/__tests__/playwright",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
