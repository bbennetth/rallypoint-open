import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// Resolve a chromium already on this machine — never download the
// ~150MB Playwright browser bundle (mirrors CLAUDE.md's screenshot
// guidance). Honor CHROMIUM_EXECUTABLE_PATH (set by the session hook)
// first, then probe the standard install locations.
function resolveChromium(): string {
  const fromEnv = process.env.CHROMIUM_EXECUTABLE_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found) return found

  throw new Error(
    'No chromium found. Install one (e.g. `apt install chromium`) or set ' +
      'CHROMIUM_EXECUTABLE_PATH to its path. The E2E suite never downloads ' +
      'a browser.',
  )
}

const EVENTS_WEB_URL = 'http://localhost:5174'
const EVENTS_API_HEALTH = 'http://localhost:8081/api/v1/health'

export default defineConfig({
  testDir: './specs',
  // One shared dev DB + one seeded user: parallelism would let specs
  // clobber each other's session row and data. Serial is mandatory here.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: EVENTS_WEB_URL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: resolveChromium() },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    // Cold-boot readiness gate for the Planner surfaces (#283): the
    // webServer below only proxies events-api health, so block the
    // suite on planner-api/planner-web before the planner sweep runs.
    { name: 'health', testMatch: /health\.setup\.ts$/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup', 'health'],
    },
  ],
  // Boots the Cloudflare-native one-command dev stack (#403): five
  // `wrangler dev` Workers + five Vite UIs, with local D1/R2 via Miniflare.
  // `reuseExistingServer` reuses a stack you already have running rather than
  // double-booting it. `url` gates on events-api health; the `health` setup
  // project additionally waits on planner before the sweep. Generous timeout
  // because a cold first boot compiles five Workers + five Vite servers.
  webServer: {
    command: 'npm run dev:stack',
    url: EVENTS_API_HEALTH,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
