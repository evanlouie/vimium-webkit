/**
 * Playwright configuration for the DOM integration layer.
 *
 * Run it with `deno task test:e2e` — the suite is Deno-hosted (the fixture
 * server, the bundle build, and the harness all use `Deno.*`), and Playwright's
 * runner is invoked from inside that Deno process.
 *
 * > [!IMPORTANT]
 * > Playwright's WebKit build is **not Safari**. See `test/e2e/README.md` for
 * > what this suite can and cannot answer.
 */

import { defineConfig, devices } from "@playwright/test";
import { PRIMARY_ORIGIN, READY_PATH } from "./test/e2e/harness/config.ts";

const isCi = Deno.env.get("CI") !== undefined;

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./test-results",

  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  // Hint detection on `link-dense.html` is deliberately heavy; the default
  // 30 s is not enough headroom on a cold WebKit build.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: isCi ? [["list"], ["github"]] : [["list"]],

  globalSetup: "./test/e2e/harness/global-setup.ts",

  use: {
    baseURL: PRIMARY_ORIGIN,
    trace: isCi ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    video: "off",
    // A stable viewport keeps the occlusion and `content-visibility` fixtures
    // deterministic: both are assertions about what is *in the viewport*.
    viewport: { width: 1280, height: 800 },
  },

  projects: [
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],

  webServer: {
    // One process, two ports: the cross-origin fixtures need a second origin.
    command: "deno run -A test/e2e/harness/server.ts",
    url: `${PRIMARY_ORIGIN}${READY_PATH}`,
    reuseExistingServer: !isCi,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
  },
});
