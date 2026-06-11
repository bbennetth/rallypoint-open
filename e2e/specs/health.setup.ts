import { test as setup, expect, type APIRequestContext } from '@playwright/test'

// Cold-boot readiness gate (#283). The `webServer` block in
// playwright.config.ts only polls events-api health as its readiness
// proxy, but the Planner sweep (planner-sweep.spec.ts, #255 slice 11)
// drives planner-web (:5177), which proxies to planner-api (:8084). On a
// warm stack (reuseExistingServer with the apps already running) those
// are already up; on a cold boot they can lag events-api. Without this
// gate the sweep's first
// `page.goto(http://localhost:5177/...)` can race a not-yet-listening
// planner-web and fail with an opaque net error instead of a useful
// assertion. Run as a setup project the chromium project depends on, so
// the suite blocks until every surface under test answers.
//
// (webServer can take an array, but each entry requires a `command`
// string — a url-only readiness entry doesn't typecheck — so this
// setup-project probe is the type-clean form of the issue's two
// suggested fixes.)

const PLANNER_API_HEALTH = 'http://localhost:8084/api/v1/health'
const PLANNER_WEB_URL = 'http://localhost:5177'
const READY_TIMEOUT = 120_000

async function statusOrZero(request: APIRequestContext, url: string): Promise<number> {
  try {
    const res = await request.get(url)
    return res.status()
  } catch {
    // Connection refused / DNS / reset while the server is still binding.
    return 0
  }
}

setup('planner surfaces are healthy', async ({ request }) => {
  // planner-api: a 200 from its health route means the BFF is serving.
  await expect
    .poll(() => statusOrZero(request, PLANNER_API_HEALTH), {
      timeout: READY_TIMEOUT,
      intervals: [500, 1000, 2000],
    })
    .toBe(200)

  // planner-web: any HTTP answer (Vite serves index.html at the root)
  // proves the dev server is accepting connections — a 0 means it isn't.
  await expect
    .poll(() => statusOrZero(request, PLANNER_WEB_URL), {
      timeout: READY_TIMEOUT,
      intervals: [500, 1000, 2000],
    })
    .toBeGreaterThanOrEqual(200)
})
