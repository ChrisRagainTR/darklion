// playwright.config.js
// Playwright E2E test configuration for DarkLion AI.
// Uses CommonJS style to be compatible with the project's package.json (no "type":"module").

const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const AUTH_STATE_PATH = 'tests/.auth/user.json';

module.exports = defineConfig({
  // Root directory for tests
  testDir: './tests/e2e',

  // Match only .spec.js files
  testMatch: '**/*.spec.js',

  // Global timeout per test (60s in CI to handle Railway cold starts)
  timeout: process.env.CI ? 60_000 : 45_000,

  // Expect timeout for assertions
  expect: {
    timeout: 10_000,
  },

  // Retry failed tests once in CI to handle flakiness
  retries: process.env.CI ? 1 : 0,

  // 1 worker — prevents race conditions on shared auth state and sequential API calls
  workers: 1,

  // Test result output directory
  outputDir: 'tests/results',

  // Reporter configuration
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/report', open: 'never' }],
    ['json', { outputFile: 'tests/results/results.json' }],
  ],

  // Global test setup: log in once before the whole suite runs
  globalSetup: './tests/global-setup.cjs',

  use: {
    // Base URL used by page.goto('/foo') shorthand
    baseURL: BASE_URL,

    // All authenticated tests use the saved login state
    storageState: AUTH_STATE_PATH,

    // Basic access is restricted to this origin; never send the staging key to CDNs.
    ...(process.env.E2E_STAGING_ACCESS_KEY ? { httpCredentials: {
      username: 'staging', password: process.env.E2E_STAGING_ACCESS_KEY, origin: BASE_URL,
    } } : {}),

    // Collect trace on first retry
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'on-first-retry',

    // Viewport
    viewport: { width: 1280, height: 800 },

    // Extra HTTP headers
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },

    // Navigation timeout (60s in CI)
    navigationTimeout: process.env.CI ? 60_000 : 30_000,

    // Action timeout (clicks, fills, etc.)
    actionTimeout: process.env.CI ? 30_000 : 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
