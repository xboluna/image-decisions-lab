import { defineConfig, devices } from "@playwright/test";

const use = { baseURL: process.env.BASE_URL ?? "http://localhost:3000", viewport: { width: 1600, height: 1000 }, acceptDownloads: true };

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...use } },
    // Safari's engine: catches storage and rendering differences (e.g. Blobs refused by IndexedDB).
    { name: "webkit", use: { ...devices["Desktop Safari"], ...use }, grepInvert: /live:/ },
  ],
  webServer: process.env.BASE_URL ? undefined : { command: "npm run dev", url: "http://localhost:3000", reuseExistingServer: true, timeout: 120_000 },
});
