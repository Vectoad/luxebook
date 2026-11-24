import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: "http://localhost:5179" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm --filter @vectoad/luxebook-playground dev --port 5179 --strictPort",
    url: "http://localhost:5179",
    reuseExistingServer: !process.env.CI,
  },
});
