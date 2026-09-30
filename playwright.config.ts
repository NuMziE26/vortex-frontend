import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;

/**
 * Accessibility gate configuration.
 *
 * The `a11y` project runs the axe-core scans defined in `e2e/a11y.spec.ts`
 * across every route in the README table, in both the light and dark palettes
 * and at the 400px (mobile) and 1280px (desktop) viewports. It is a blocking
 * CI step: any new serious/critical violation fails the build unless the rule
 * is listed in the documented allowlist (`e2e/a11y-allowlist.ts`).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: [["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    // Disable motion so tooltips/animations do not cause flaky axe results.
    reducedMotion: "reduce",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    {
      name: "a11y",
      testMatch: /a11y\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    // `next dev` compiles on first request; give cold CI runners headroom.
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_API_URL: "http://localhost:4000",
    },
  },
});
