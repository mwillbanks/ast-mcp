import { defineConfig } from "@playwright/test";

const port = Number(process.env.TEST_PORT ?? 4173);
export default defineConfig({
  testDir: "./browser",
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:" + port, browserName: "chromium" },
  webServer: {
    command: "bun run preview",
    env: { PORT: String(port), BASE_PATH: process.env.BASE_PATH ?? "/" },
    url: "http://127.0.0.1:" + port + (process.env.BASE_PATH ?? "/"),
    reuseExistingServer: false,
    timeout: 15_000,
  },
  reporter: "line",
});
