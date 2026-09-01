/**
 * scripts/www-shots/capture.ts
 *
 * Drives the LOCAL dev stack with Playwright to capture the mobile
 * screenshots used on the marketing site (apps/www/static/screens).
 *
 * Usage:
 *   npm run dev:stack                        # in another terminal
 *   npx tsx scripts/www-shots/capture.ts     # every step, in ORDER
 *   npx tsx scripts/www-shots/capture.ts planner health
 *                                            # just those steps (retakes)
 *   npx tsx scripts/www-shots/capture.ts --list
 *
 * The positional arguments are STEP names, not shot names. There are four:
 *
 *   planner      -> planner-tasks.png, planner-shopping.png, planner-my-day.png
 *   health       -> health-today.png, health-today-history.png, health-stats.png
 *   events       -> events-now.png
 *   health-live  -> health-live-workout.png
 *
 * Output: PNGs at 780x1688 (390x844 CSS px @2x) into OUT_DIR. They are
 * throwaway intermediates — convert the keepers to WebP with:
 *
 *   magick <in>.png -quality 82 apps/www/static/screens/<name>.webp
 *
 * PNG -> shipped WebP mapping (note the one rename):
 *
 *   planner-my-day.png        -> planner-my-day.webp
 *   planner-tasks.png         -> planner-tasks.webp
 *   planner-shopping.png      -> planner-shopping.webp
 *   health-today-history.png  -> health-today.webp      <-- see below
 *   health-stats.png          -> health-stats.webp
 *   health-live-workout.png   -> health-live-workout.webp
 *   events-now.png            -> events-now.webp
 *
 * `health-today.webp` ships the /log/history view, NOT /log. The /log
 * "Today" hub is action tiles + a week strip: with a workout logged it
 * still reads "LOG FOOD 0 / NOTHING LOGGED YET / NOTHING SCHEDULED",
 * which is an empty state on a marketing page. /log/history leads with a
 * TODAY group and shows the seeded block (titles, set counts, tonnage).
 * The /log shot is still captured as `health-today.png` if that call is
 * ever reversed.
 *
 * Data: each step seeds what it needs first, reconciling against whatever
 * the stack already holds, so a re-run never duplicates and a run that
 * died halfway finishes the job. Planner data is seeded through the real
 * API in the browser (seedPlanner / seedShopping); the health training
 * block is seeded straight into fitness-api's local D1 from
 * seed-fitness-history.sql (seedFitnessHistory), which needs the local
 * `wrangler` the repo already depends on.
 *
 * Browser policy: NEVER downloads a browser. Uses the chromium already
 * installed on the machine via CHROMIUM_EXECUTABLE_PATH or the same
 * probe list as e2e/playwright.config.ts.
 *
 * Env overrides:
 *   OUT_DIR         scratch dir: PNGs + the substituted seed SQL
 *                   (default: ./.www-shots, gitignored)
 *   DEMO_EMAIL / ADMIN_EMAIL / DEV_PASSWORD / DEV_SIGNIN_CODE
 *   ID_WEB_URL / PLANNER_WEB_URL / FITNESS_WEB_URL / EVENTS_WEB_URL
 *   HEADED=1        watch it run
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ID_WEB = process.env.ID_WEB_URL ?? 'http://localhost:5173'
const EVENTS_WEB = process.env.EVENTS_WEB_URL ?? 'http://localhost:5174'
const PLANNER_WEB = process.env.PLANNER_WEB_URL ?? 'http://localhost:5177'
const FITNESS_WEB = process.env.FITNESS_WEB_URL ?? 'http://localhost:5178'

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'demo@example.com'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const PASSWORD = process.env.DEV_PASSWORD ?? 'RallypointDev!2026'
/** Fixed by DEV_SIGNIN_CODE_OVERRIDE in apps/id-api/.dev.vars (dev only). */
const SIGNIN_CODE = process.env.DEV_SIGNIN_CODE ?? '000000'

const OUT_DIR = process.env.OUT_DIR ?? path.resolve('.www-shots')
const FESTIVAL_SLUG = 'harvest-moon-demo'

/** Derived from this file's own location, not cwd — the D1 seeding below
 *  shells out with an app directory as cwd, so it needs absolute paths. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FITNESS_SEED_SQL = path.join(REPO_ROOT, 'scripts', 'www-shots', 'seed-fitness-history.sql')

/** Accent per app origin. localStorage is per-origin, so one browser
 *  context can carry a different accent for each app. */
const ACCENT_BY_ORIGIN: Record<string, string> = {
  [PLANNER_WEB]: 'blue',
  [FITNESS_WEB]: 'green',
  [EVENTS_WEB]: 'orange',
  [ID_WEB]: 'blue',
}

/** Planner's WeatherStrip has two ways to learn where you are: a location
 *  persisted in localStorage, or the browser geolocation API. This pins the
 *  stored one (shape: apps/planner-web/src/ui/WeatherStrip.tsx `StoredLoc`)
 *  so the strip resolves a real Open-Meteo forecast through the planner-api
 *  proxy — no geolocation call, no manual "City or ZIP" fallback box.
 *  Requires outbound internet; the fallback box returns if the proxy call
 *  fails. */
const WEATHER_LOCATION = { lat: 37.7749, lng: -122.4194, label: 'San Francisco' }

/** Live-session keys that make fitness-web float a "resume session" pill
 *  over the page (apps/fitness-web/src/lib/live-session-keys.ts). */
const FITNESS_LIVE_KEYS = [
  'rp-fitness-strength-session-current',
  'rp-fitness-wod-session-current',
  'rp-fitness-wod-rep-session-current',
  'rp-fitness-pending-save',
]

// ---------------------------------------------------------------------------
// Browser plumbing
// ---------------------------------------------------------------------------

/** Resolve a chromium already on this machine — never download one.
 *  Mirrors e2e/playwright.config.ts. */
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
      'CHROMIUM_EXECUTABLE_PATH. This script never downloads a browser.',
  )
}

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Mobile Safari/537.36'

async function newMobileContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
    locale: 'en-US',
    timezoneId: process.env.TZ_ID ?? undefined,
    colorScheme: 'dark',
    // Grant nothing. Geolocation in particular stays denied so no shot can
    // stall on a permission prompt or on a headless geolocation lookup that
    // never resolves. WEATHER_LOCATION (pinned into localStorage below) is
    // what feeds planner's WeatherStrip instead, so denying costs nothing.
    permissions: [],
  })

  // Seed the persisted zustand theme blob before any app script runs, so
  // the pre-hydration boot script in index.html picks up the right
  // chassis + accent on first paint (no flash, no toggling in-app).
  // Also pin planner's weather location — the stored-location path the
  // WeatherStrip prefers, which is why denying geolocation above does not
  // drop My Day into the "City or ZIP" fallback.
  await ctx.addInitScript(
    (cfg: { accents: Record<string, string>; planner: string; wx: unknown }) => {
      try {
        const color = cfg.accents[window.location.origin] ?? 'blue'
        window.localStorage.setItem(
          'rallypt-theme',
          JSON.stringify({ state: { mode: 'dark', color }, version: 1 }),
        )
        if (window.location.origin === cfg.planner) {
          window.localStorage.setItem('rallypt-planner-weather-loc', JSON.stringify(cfg.wx))
        }
      } catch {
        /* storage blocked — fall back to app defaults */
      }
    },
    {
      accents: ACCENT_BY_ORIGIN,
      planner: PLANNER_WEB,
      wx: WEATHER_LOCATION,
    },
  )

  return ctx
}

/**
 * Force the touch-device media features browser-wide.
 *
 * Playwright's `isMobile`/`hasTouch` set the UA, viewport and touch event
 * plumbing, but the page still matches `(hover: hover) and (pointer: fine)`
 * — so every `SwipeActions` row renders its DESKTOP hover-reveal variant
 * (packages/ui/src/shell.css:759), which reserves 52–90px of right padding
 * for the hover action tray. That shows up in a screenshot as a dead gap
 * to the right of planner task/shopping rows and the health tonnage score.
 * A real phone matches hover:none / pointer:coarse.
 *
 * Blink's pointer/hover capability enums, forced at launch.
 *
 *   HoverType:   1 = none,   2 = hover
 *   PointerType: 1 = none,   2 = coarse,  4 = fine
 *
 * CDP `Emulation.setEmulatedMedia` is a NO-OP for the hover/pointer
 * features in this chromium (verified: setting them before AND after
 * navigation, with and without an explicit `media`, leaves
 * `(hover: hover) and (pointer: fine)` matching). Playwright's
 * `isMobile`/`hasTouch` do not move them either — that context still
 * reports maxTouchPoints 0. The launch flag is the only lever that
 * actually works, so it is applied browser-wide.
 */
const TOUCH_BLINK_SETTINGS =
  '--blink-settings=primaryHoverType=1,primaryPointerType=2,' +
  'availableHoverTypes=1,availablePointerTypes=2'

// Pages are opened with a bare ctx.newPage() — the touch media features
// come from TOUCH_BLINK_SETTINGS at launch (browser-wide) and the context
// options in newMobileContext, so there is no per-page setup to do. Every
// shot re-asserts the touch media (assertTouchMedia) so a regression in
// either can't ship silently.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// console.warn, not .log — the repo's no-console rule allows warn/error
// only, and sibling CLI scripts (scripts/argon2-bench.ts) do the same.
const log = (msg: string) => console.warn(`[www-shots] ${msg}`)

async function settle(page: Page, ms = 900): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(ms)
}

/** Assert the page is presenting as a touch device. Guards against
 *  silently shipping the desktop hover-reveal variant of SwipeActions
 *  rows (reserved right padding) — see TOUCH_BLINK_SETTINGS. */
async function assertTouchMedia(page: Page, name: string): Promise<void> {
  const m = await page.evaluate(() => ({
    hover: window.matchMedia('(hover: none)').matches,
    pointer: window.matchMedia('(pointer: coarse)').matches,
    desktopVariant: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
  }))
  if (!m.hover || !m.pointer || m.desktopVariant) {
    throw new Error(
      `${name}: page is NOT presenting as a touch device ` +
        `(hover:none=${m.hover}, pointer:coarse=${m.pointer}, ` +
        `desktopVariant=${m.desktopVariant}). CDP media emulation did not apply.`,
    )
  }
}

/** Blur whatever has focus and kill carets/focus rings, then screenshot. */
async function shot(
  page: Page,
  name: string,
  opts: { scrollY?: number } = {},
): Promise<string> {
  await settle(page)
  await assertTouchMedia(page, name)
  await page
    .addStyleTag({
      content: `
        *, *::before, *::after { caret-color: transparent !important; }
        *:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }
        /* freeze spinners/pulses so nothing is caught mid-animation */
        *, *::before, *::after {
          animation-play-state: paused !important;
          transition: none !important;
        }
      `,
    })
    .catch(() => {})
  await page.evaluate((y: number) => {
    const el = document.activeElement as HTMLElement | null
    if (el && typeof el.blur === 'function') el.blur()
    window.scrollTo(0, 0)
    // These app shells scroll an inner <main> (e.g. planner's
    // `main.plapp-main`, overflow-y:auto), NOT the window — window
    // scrollHeight === innerHeight, so window.scrollTo does nothing.
    // Find the real scroller and drive that instead.
    const scroller = Array.from(document.querySelectorAll<HTMLElement>('*')).find(
      (e) =>
        e.scrollHeight > e.clientHeight + 2 &&
        e.clientHeight > 200 &&
        ['auto', 'scroll'].includes(getComputedStyle(e).overflowY),
    )
    if (scroller) scroller.scrollTop = y
  }, opts.scrollY ?? 0)
  // Park the pointer in a dead corner — otherwise the row it happens to
  // sit over renders its hover/swipe action tray in the shot.
  await page.mouse.move(2, 2)
  await page.waitForTimeout(400)
  const file = path.join(OUT_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  log(`shot -> ${file}`)
  return file
}

/** The visible QuickAdd FAB. Planner renders two (subbar + float); only
 *  one is visible at a given breakpoint. */
function quickAddFab(page: Page) {
  return page.locator('button[aria-label="Quick add"]:visible').first()
}

async function openQuickAdd(page: Page, item: string): Promise<void> {
  await quickAddFab(page).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const localDateTime = (d: Date) => `${ymd(d)}T${hm(d)}`
function daysFromNow(n: number, hour = 9, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  d.setHours(hour, minute, 0, 0)
  return d
}

// ---------------------------------------------------------------------------
// Auth — mirrors the e2e SSO dance without the (stale) mailpit helper.
// The 2FA code is pinned by DEV_SIGNIN_CODE_OVERRIDE in dev.
// ---------------------------------------------------------------------------

async function signIn(
  page: Page,
  opts: { email: string; startUrl: string; landingPrefix: string },
): Promise<void> {
  const { email, startUrl, landingPrefix } = opts
  log(`sign-in: ${email} -> ${startUrl}`)
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' })

  // The SSO bounce is client-side (RequireSession -> beginSso ->
  // location.assign), so the pre-redirect URL still matches the app
  // origin for a moment. Wait specifically for RPID's hosted /signin;
  // if it never arrives, an existing RPID session already completed SSO
  // silently and we are authenticated.
  const needsCredentials = await page
    .waitForURL((url) => url.pathname.startsWith('/signin'), { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)

  if (!needsCredentials) {
    log('already signed in (RPID session reused)')
    await settle(page)
    return
  }

  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Continue' }).click()

  const code = page.getByLabel('6-digit code')
  await code.waitFor({ state: 'visible', timeout: 30_000 })
  await code.fill(SIGNIN_CODE)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Done when we have left RPID's origin and landed back on the app.
  await page.waitForURL(
    (url) => !url.href.startsWith(ID_WEB) && url.href.startsWith(landingPrefix),
    { timeout: 60_000 },
  )
  await settle(page)
  log(`signed in -> ${page.url()}`)
}

// ---------------------------------------------------------------------------
// Planner seeding
// ---------------------------------------------------------------------------

interface SeedTask {
  title: string
  priority: 'LOW' | 'MED' | 'HIGH' | null
  dueInDays: number
  hour: number
  minute?: number
}

const PLANNER_TASKS: SeedTask[] = [
  { title: 'Send Q3 invoice to Brightwater', priority: 'HIGH', dueInDays: 0, hour: 9, minute: 30 },
  { title: 'Call the dentist to reschedule', priority: 'MED', dueInDays: 0, hour: 11, minute: 15 },
  { title: 'Renew the car insurance', priority: 'HIGH', dueInDays: 0, hour: 14 },
  { title: 'Water the balcony herbs', priority: 'LOW', dueInDays: 0, hour: 18, minute: 30 },
  { title: "Book flights for Sarah's wedding", priority: 'HIGH', dueInDays: 2, hour: 10 },
  { title: 'Draft the Q4 offsite agenda', priority: 'MED', dueInDays: 3, hour: 15 },
  { title: 'Replace the bathroom light fitting', priority: 'LOW', dueInDays: 5, hour: 11 },
  { title: 'Return the library books', priority: 'MED', dueInDays: 1, hour: 17 },
]

async function addTask(page: Page, t: SeedTask): Promise<void> {
  await openQuickAdd(page, 'Task')
  await page.getByLabel('Task title').fill(t.title)
  const due = daysFromNow(t.dueInDays, t.hour, t.minute ?? 0)
  await page.getByLabel('Task due date').fill(ymd(due))
  await page.getByLabel('Task due time').fill(hm(due))
  if (t.priority) {
    await page.getByRole('button', { name: t.priority, exact: true }).click()
  }
  await page.getByRole('button', { name: 'Add task' }).click()
  await settle(page, 500)
}

const PLANNER_CHORES = ['Take out the recycling', 'Change the bed linen']

async function addChore(page: Page, name: string): Promise<void> {
  await openQuickAdd(page, 'Chore')
  await page.getByLabel('Chore name').fill(name)
  await page.getByRole('button', { name: 'Add chore' }).click()
  await settle(page, 500)
}

interface SeedEvent {
  name: string
  startHour: number
  startMin: number
  endHour: number
  endMin: number
  location: string
}

const PLANNER_EVENTS: SeedEvent[] = [
  {
    name: 'Product sync — roadmap review',
    startHour: 10,
    startMin: 0,
    endHour: 11,
    endMin: 0,
    location: 'Meeting room 2',
  },
  {
    name: 'Dinner with Marcus',
    startHour: 19,
    startMin: 30,
    endHour: 21,
    endMin: 30,
    location: 'Trattoria Vecchia',
  },
]

async function addEvent(page: Page, e: SeedEvent): Promise<void> {
  await openQuickAdd(page, 'Event')
  await page.getByLabel('Event name').fill(e.name)
  await page.getByLabel('Event start').fill(localDateTime(daysFromNow(0, e.startHour, e.startMin)))
  await page.getByLabel('Event end').fill(localDateTime(daysFromNow(0, e.endHour, e.endMin)))
  await page.getByLabel('Event location').fill(e.location)
  await page.getByRole('button', { name: 'Add event' }).click()
  await settle(page, 500)
}

const SHOPPING_ITEMS = [
  'Wholemeal sourdough',
  'Greek yoghurt',
  'Cherry tomatoes',
  'Free-range eggs',
  'Ground coffee',
  'Parmesan',
  'Baby spinach',
  'Olive oil',
]
const SHOPPING_CHECKED = ['Greek yoghurt', 'Ground coffee', 'Baby spinach']

/** Dismiss the Morning Check-in modal on /me. It is gated on a
 *  server-persisted `lastCheckinDay` setting and fails open, so it can
 *  appear on any first visit of the day. Escape closes it and the page
 *  then persists today's date. */
async function dismissMorningCheckin(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog')
  if (await dialog.first().isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    log('dismissed morning check-in')
  }
}

/** The one task the seed leaves completed, for a mixed done/not-done list. */
const PLANNER_DONE_TASK = 'Return the library books'

/** Titles of every task on /tasks, completed ones INCLUDED.
 *
 *  Completed tasks hide behind a collapsed "Completed (N)" disclosure
 *  (apps/planner-web/src/pages/TasksPage.tsx:331), so it gets expanded
 *  first — otherwise PLANNER_DONE_TASK reads as missing on every re-run
 *  and gets added again. Each row's checkbox is a `button.pl-check` whose
 *  aria-label is `Mark <title> done` / `Mark <title> not done` (the `Check`
 *  bit in apps/planner-web/src/ui/bits.tsx). */
async function existingTaskTitles(page: Page): Promise<Set<string>> {
  const disclosure = page.locator('button[aria-controls="tasks-completed-list"]').first()
  if (
    (await disclosure.isVisible().catch(() => false)) &&
    (await disclosure.getAttribute('aria-expanded')) !== 'true'
  ) {
    await disclosure.click()
    await page.waitForTimeout(400)
  }
  const labels = await Promise.all(
    (await page.locator('button.pl-check').all()).map((el) => el.getAttribute('aria-label')),
  )
  return new Set(
    labels
      .filter((l): l is string => Boolean(l))
      .map((l) => l.replace(/^Mark /, '').replace(/ (?:not )?done$/, '')),
  )
}

/** Switch /tasks to its Chores sub-view. The segmented control renders
 *  twice (mobile `.rp-subbar-seg` floating bar + desktop `.seg` in the page
 *  head, one hidden per breakpoint), so match whichever is visible. */
async function openChoresSubview(page: Page): Promise<void> {
  const seg = page
    .locator('button.rp-subbar-seg:visible, .seg button:visible')
    .filter({ hasText: 'Chores' })
    .first()
  await seg.waitFor({ state: 'visible', timeout: 15_000 })
  await seg.click()
  await settle(page, 600)
}

/**
 * Seed tasks, chores and events through the real API, reconciling each
 * surface item-by-item against what is already there (same shape as
 * seedShopping): a retake never duplicates, and a run that died partway
 * finishes the remaining items instead of tripping over a sentinel.
 *
 * Note the different time semantics per surface. Tasks and chores are
 * matched purely by title, so an older seed's tasks are left alone (stale
 * due dates and all). Events are read off /events, which lists only
 * non-past events, so a run on a later day re-seeds today's two events —
 * which is what the shots want.
 */
async function seedPlanner(page: Page): Promise<void> {
  // --- tasks ---
  await page.goto(`${PLANNER_WEB}/tasks`, { waitUntil: 'domcontentloaded' })
  await settle(page)

  const tasksBefore = await existingTaskTitles(page)
  const missingTasks = PLANNER_TASKS.filter((t) => !tasksBefore.has(t.title))
  if (missingTasks.length) {
    log(`adding ${missingTasks.length} tasks (${tasksBefore.size} already present)`)
    for (const t of missingTasks) await addTask(page, t)
  } else {
    log('tasks already seeded')
  }

  // --- chores ---
  await page.goto(`${PLANNER_WEB}/tasks`, { waitUntil: 'domcontentloaded' })
  await settle(page)
  await openChoresSubview(page)
  // Chore rows are `li.pl-row`s carrying the title plus a recurrence chip
  // (apps/planner-web/src/ui/SeriesList.tsx), so match on contained text.
  const choreRows = await page.locator('ul.tk-rows li.pl-row').allInnerTexts()
  const missingChores = PLANNER_CHORES.filter((c) => !choreRows.some((row) => row.includes(c)))
  if (missingChores.length) {
    log(`adding ${missingChores.length} chores (${choreRows.length} rows already present)`)
    for (const c of missingChores) await addChore(page, c)
  } else {
    log('chores already seeded')
  }

  // --- events ---
  await page.goto(`${PLANNER_WEB}/events`, { waitUntil: 'domcontentloaded' })
  await settle(page)
  const eventNames = await page.locator('.ev-rail-name').allInnerTexts()
  const missingEvents = PLANNER_EVENTS.filter((e) => !eventNames.some((n) => n.trim() === e.name))
  if (missingEvents.length) {
    log(`adding ${missingEvents.length} events (${eventNames.length} already listed)`)
    for (const e of missingEvents) await addEvent(page, e)
  } else {
    log('events already seeded')
  }

  // --- verify + mixed done/not-done state ---
  await page.goto(`${PLANNER_WEB}/tasks`, { waitUntil: 'domcontentloaded' })
  await settle(page)
  const tasksAfter = await existingTaskTitles(page)
  const stillMissing = PLANNER_TASKS.filter((t) => !tasksAfter.has(t.title)).map((t) => t.title)
  if (stillMissing.length) {
    throw new Error(`task seed incomplete, missing: ${stillMissing.join(', ')}`)
  }
  log(`tasks list now has ${tasksAfter.size} items`)

  const doneBtn = page.getByRole('button', { name: `Mark ${PLANNER_DONE_TASK} done` })
  if (await doneBtn.isVisible().catch(() => false)) {
    await doneBtn.click()
    await settle(page, 500)
  }
}

/** Shopping seeds separately from tasks/chores/events and reconciles
 *  against whatever is already on the list, so a retake never
 *  duplicates and a partial earlier run self-heals. */
async function seedShopping(page: Page): Promise<void> {
  await page.goto(`${PLANNER_WEB}/shopping`, { waitUntil: 'domcontentloaded' })
  await settle(page)

  const existing = new Set(
    (await page.locator('button[aria-label^="Edit "]').all().then((els) =>
      Promise.all(els.map((e) => e.getAttribute('aria-label'))),
    ))
      .filter((l): l is string => Boolean(l))
      .map((l) => l.replace(/^Edit /, '')),
  )
  const missing = SHOPPING_ITEMS.filter((i) => !existing.has(i))

  if (missing.length) {
    log(`adding ${missing.length} shopping items (${existing.size} already present)`)
    await openQuickAdd(page, 'Shopping')
    await page.getByLabel('Shopping items, one per line').fill(missing.join('\n'))
    // The role-name regex proved flaky (the label flips between
    // "Add to list" and "Add N to list" as React re-renders) — target
    // the form's submit button directly instead.
    const submit = page.locator('form.pl-fab-form button[type="submit"]')
    await submit.waitFor({ state: 'visible', timeout: 10_000 })
    await submit.click()
    await page.waitForTimeout(1500)
    await settle(page, 1200)
    await page.goto(`${PLANNER_WEB}/shopping`, { waitUntil: 'domcontentloaded' })
    await settle(page)
  } else {
    log('shopping already seeded')
  }

  for (const item of SHOPPING_CHECKED) {
    const b = page.getByRole('button', { name: `Mark ${item} bought` })
    if (await b.isVisible().catch(() => false)) {
      await b.click()
      await page.waitForTimeout(500)
    }
  }
  await settle(page, 600)

  const rows = await page.locator('button[aria-label^="Edit "]').count()
  log(`shopping list now has ${rows} items`)
  if (rows < SHOPPING_ITEMS.length) {
    throw new Error(`shopping seed incomplete: ${rows}/${SHOPPING_ITEMS.length} items`)
  }
}

// ---------------------------------------------------------------------------
// Health seeding — straight into fitness-api's local D1
//
// The /log and /stats shots need a training history that no amount of UI
// driving would produce in reasonable time (19 sessions over five weeks),
// so it is applied as SQL instead of clicked in. Same access path as
// scripts/seed-demo-festival.sh: `wrangler d1 execute DB --local` run from
// the owning app's directory, against the Miniflare state under
// apps/<app>/.wrangler/state that `npm run dev:stack` migrates.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile)

/** Run the repo-local wrangler from `cwd` and hand back stdout. Wrangler
 *  can emit a lot on a --file apply, hence the roomy buffer; a non-zero
 *  exit is rethrown with its stderr attached so the failure is readable. */
async function wrangler(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('npx', ['wrangler', ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    const e = err as { message?: string; stderr?: string }
    throw new Error(
      `wrangler ${args.join(' ')} failed (cwd ${cwd}): ${e.message ?? String(err)}\n${e.stderr ?? ''}`,
    )
  }
}

/** `wrangler d1 execute --json` prints a JSON array of per-statement
 *  results. Shape kept minimal — only the single-column SELECT below
 *  reads it. */
interface D1JsonResult {
  results?: Record<string, unknown>[]
}

/** The demo user's id, read out of id-api's local D1 (users are owned by
 *  RPID; every other app keys rows off that id). */
async function demoUserId(): Promise<string> {
  // Local dev script, local sqlite — but DEMO_EMAIL is env-supplied, so
  // still escape it rather than splicing raw text into SQL.
  const email = DEMO_EMAIL.replace(/'/g, "''")
  const stdout = await wrangler(path.join(REPO_ROOT, 'apps', 'id-api'), [
    'd1',
    'execute',
    'DB',
    '--local',
    '--command',
    `SELECT id FROM users WHERE email = '${email}'`,
    '--json',
  ])
  const parsed = parseD1Json(stdout)
  const id = parsed[0]?.results?.[0]?.id
  if (typeof id !== 'string' || !id) {
    throw new Error(
      `no user "${DEMO_EMAIL}" in id-api's local D1. \`npm run dev:stack\` ` +
        'seeds this account automatically (scripts/seed-dev.sh, run once ' +
        'the APIs are healthy) — start the stack, or run ' +
        '`bash scripts/seed-dev.sh` against an already-running one. Set ' +
        `DEMO_EMAIL to point at another account you signed up at ${ID_WEB}.`,
    )
  }
  return id
}

/** Parse `wrangler d1 execute --json` stdout. npx/wrangler can prepend
 *  chatter, so the payload starts at the first bracket — but that slice is
 *  a guess about someone else's output format, so every way it can go
 *  wrong (no bracket, invalid JSON, not an array) reports what was
 *  actually on stdout instead of a bare SyntaxError. */
function parseD1Json(stdout: string): D1JsonResult[] {
  const snippet = (): string => {
    const s = stdout.trim()
    return s.length > 800 ? `${s.slice(0, 800)}\n… (${s.length} chars total)` : s || '(empty)'
  }
  const start = stdout.indexOf('[')
  if (start < 0) {
    throw new Error(`wrangler --json output has no JSON array. stdout was:\n${snippet()}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start))
  } catch (err) {
    throw new Error(
      `wrangler --json output did not parse as JSON (${(err as Error).message}). ` +
        `stdout was:\n${snippet()}`,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `wrangler --json output was ${typeof parsed}, expected an array of ` +
        `per-statement results. stdout was:\n${snippet()}`,
    )
  }
  return parsed as D1JsonResult[]
}

/**
 * Apply seed-fitness-history.sql — the five-week strength block behind the
 * health-today / health-stats shots — to fitness-api's local D1.
 *
 * The file ships with a literal `__USER_ID__` token, so the demo user id is
 * looked up first, substituted, and the substituted copy written into
 * OUT_DIR before it is applied. Every row uses a fixed id + INSERT OR
 * IGNORE, so re-applying is a no-op and this runs unconditionally.
 */
async function seedFitnessHistory(): Promise<void> {
  const userId = await demoUserId()
  const template = readFileSync(FITNESS_SEED_SQL, 'utf8')
  if (!template.includes('__USER_ID__')) {
    throw new Error(`${FITNESS_SEED_SQL} has no __USER_ID__ token — is it the right file?`)
  }
  const sql = template.replaceAll('__USER_ID__', userId)
  mkdirSync(OUT_DIR, { recursive: true })
  const applied = path.join(OUT_DIR, 'seed-fitness-history.applied.sql')
  writeFileSync(applied, sql)
  log(`applying strength history seed for ${userId} (${applied})`)
  await wrangler(path.join(REPO_ROOT, 'apps', 'fitness-api'), [
    'd1',
    'execute',
    'DB',
    '--local',
    '--file',
    applied,
  ])
  log('strength history seed applied')
}

// ---------------------------------------------------------------------------
// Harvest Moon time-shift — makes the demo festival LIVE at capture time
// ---------------------------------------------------------------------------

/**
 * The seeded Harvest Moon Festival (scripts/seed-demo-festival.sql) is
 * pinned to 2026-09-18..20, so the attendee Now tab renders
 * "Nothing scheduled around now." / "Nothing happening right now." on
 * every other date — an empty state, useless as a marketing shot.
 *
 * This rewrites the festival's dates and its middle-day schedule in
 * events-api's local D1 so that, at the moment of capture:
 *
 *   - day 2 IS today (day 1 = yesterday, day 3 = tomorrow), and
 *     events.start_date/end_date follow, so `defaultDateForEvent`
 *     opens the Now tab on today and the live widgets render;
 *   - every stage has a set PLAYING NOW plus a NEXT-UP set, so
 *     "Lineup now" shows three "● artist" rows and three "next: …" rows
 *     (selectCurrentLineup, packages/events-shared/src/now-selection.ts);
 *   - one session is mid-flight so "Sessions now" is populated;
 *   - earlier sets and a later headliner survive so the day agenda below
 *     reads like a real festival day rather than three rows.
 *
 * Times are LOCAL wall-clock: the Now selectors combine day.date with the
 * HH:MM:SS strings against the device clock (see the header comment in
 * now-selection.ts), so the offsets below are computed off `new Date()`.
 *
 * Clock-agnostic: a slot is filed under whichever of the three day rows
 * its own local date lands on, so a late-evening capture (where "+3h"
 * is past midnight) files those sets on tomorrow instead of wrapping to
 * 02:00 "earlier today". A slot that would cross midnight has its end
 * clamped to 23:59 (the schema stores time-of-day only).
 *
 * Idempotent, including across a date boundary: the day rows are parked
 * on sentinel (label, date) values before the real ones are written, so
 * re-running on a later day cannot trip either of the event_days unique
 * indexes, and every slot for the artists below is deleted before
 * re-inserting. Re-running just re-centres the schedule on the new
 * "now". (A run that dies mid-file can leave the `day-N-tmp` labels /
 * 1900 dates behind; the next run overwrites them, so the recovery is
 * simply to re-run.) Every artist/stage/day id comes from the seed
 * file, so `scripts/seed-demo-festival.sh local` must have run (the dev
 * stack does this) — the row-count guard below fails loudly if not.
 */

/** Offsets in minutes from `now`. Negative = already started/finished. */
const HM_SLOTS: {
  artistId: string
  stageId: string
  tier: string
  genre: string
  from: number
  to: number
}[] = [
  // Earlier today — agenda depth, all finished.
  { artistId: 'art_demo_copper_canyon', stageId: 'evs_demo_hm_meadow', tier: 'support', genre: 'americana', from: -200, to: -140 },
  { artistId: 'art_demo_static_bloom', stageId: 'evs_demo_hm_grove', tier: 'support', genre: 'shoegaze', from: -190, to: -130 },
  { artistId: 'art_demo_prairie_signals', stageId: 'evs_demo_hm_tent', tier: 'support', genre: 'ambient', from: -180, to: -120 },
  // Playing right now — one per stage.
  { artistId: 'art_demo_ferris_wheels', stageId: 'evs_demo_hm_meadow', tier: 'support', genre: 'funk', from: -40, to: 35 },
  { artistId: 'art_demo_glass_meadow', stageId: 'evs_demo_hm_grove', tier: 'support', genre: 'dream pop', from: -25, to: 50 },
  { artistId: 'art_demo_low_tide', stageId: 'evs_demo_hm_tent', tier: 'support', genre: 'house', from: -55, to: 20 },
  // Next up — one per stage.
  { artistId: 'art_demo_velvet_antenna', stageId: 'evs_demo_hm_meadow', tier: 'support', genre: 'synthpop', from: 50, to: 110 },
  { artistId: 'art_demo_marlowe_dusk', stageId: 'evs_demo_hm_grove', tier: 'support', genre: 'downtempo', from: 65, to: 125 },
  { artistId: 'art_demo_paper_lanterns', stageId: 'evs_demo_hm_tent', tier: 'support', genre: 'indie pop', from: 40, to: 100 },
  // Tonight's headliner.
  { artistId: 'art_demo_salt_flats', stageId: 'evs_demo_hm_meadow', tier: 'headliner', genre: 'desert rock', from: 180, to: 300 },
]

/** Sessions: one running now, one later today. */
const HM_SESSIONS: { id: string; from: number; to: number }[] = [
  { id: 'evx_demo_hm_print', from: -30, to: 60 },
  { id: 'evx_demo_hm_yoga', from: 150, to: 210 },
]

const HM_EVENT_ID = 'event_demo_harvest_moon_2026'
/** The seed's three day rows, in sort order. Their ids (and the seed's
 *  Fri/Sat/Sun labels) are historical: this shift re-dates them to
 *  yesterday/today/tomorrow whatever the weekday, so read `_fri/_sat/_sun`
 *  as "day 1 / day 2 / day 3". */
const HM_DAY_IDS = ['evd_demo_hm_fri', 'evd_demo_hm_sat', 'evd_demo_hm_sun'] as const
/** Day 2 — the row whose date becomes today. */
const HM_TODAY_DAY_ID = 'evd_demo_hm_sat'

function localDateIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`
}

/** Resolve an offset-from-now pair to (day row, HH:MM:SS, HH:MM:SS),
 *  clamping a midnight-crossing end to 23:59 and dropping anything that
 *  falls outside the festival's three days. */
function resolveWindow(
  now: Date,
  from: number,
  to: number,
  dayIdByDate: Map<string, string>,
): { dayId: string; start: string; end: string } | null {
  const startAt = new Date(now.getTime() + from * 60_000)
  const endAt = new Date(now.getTime() + to * 60_000)
  const dayId = dayIdByDate.get(localDateIso(startAt))
  if (!dayId) return null
  const sameDay = localDateIso(endAt) === localDateIso(startAt)
  return { dayId, start: hhmm(startAt), end: sameDay ? hhmm(endAt) : '23:59:00' }
}

async function shiftFestivalToNow(): Promise<void> {
  const now = new Date()
  const dayDates = HM_DAY_IDS.map((_, i) =>
    localDateIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i - 1)),
  )
  const dayIdByDate = new Map(HM_DAY_IDS.map((id, i) => [dayDates[i]!, id as string]))
  const weekday = (iso: string): string =>
    new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })

  const slotRows = HM_SLOTS.map((s) => ({ slot: s, win: resolveWindow(now, s.from, s.to, dayIdByDate) }))
  const artistList = HM_SLOTS.map((s) => `'${s.artistId}'`).join(', ')

  const stmts: string[] = [
    `UPDATE events SET start_date = '${dayDates[0]}', end_date = '${dayDates[2]}' WHERE id = '${HM_EVENT_ID}';`,
    // Two passes over (day_label, date): event_days carries a unique
    // index on BOTH (event_id, day_label) and (event_id, date)
    // (packages/events-db/src/schema/event-days.ts:36-37), and both
    // collide when the rows shift by a day — the new weekday names
    // overlap the old ones (Fri/Sat/Sun onto Sun/Mon/Tue collides on
    // "Sunday"), and re-running a day later assigns day 1 the date
    // day 2 still holds. Park both columns on sentinels first, then
    // write the real values. `date` is NOT NULL, hence the 1900 dates.
    ...HM_DAY_IDS.map(
      (id, i) =>
        `UPDATE event_days SET day_label = 'day-${i}-tmp', date = '1900-01-0${i + 1}' WHERE id = '${id}';`,
    ),
    ...HM_DAY_IDS.map(
      (id, i) =>
        `UPDATE event_days SET date = '${dayDates[i]}', day_label = '${weekday(dayDates[i]!)}' WHERE id = '${id}';`,
    ),
    // Clear every prior booking for these artists (any day) so a re-run
    // can move a slot between days without tripping event_artists_slot_uq.
    `DELETE FROM event_artists WHERE event_id = '${HM_EVENT_ID}' AND artist_id IN (${artistList});`,
    ...slotRows.flatMap(({ slot: s, win }) =>
      win
        ? [
            `INSERT INTO event_artists (event_id, artist_id, day_id, stage_id, tier, genre, start_time, end_time) ` +
              `SELECT '${HM_EVENT_ID}', '${s.artistId}', '${win.dayId}', '${s.stageId}', '${s.tier}', '${s.genre}', ` +
              `'${win.start}', '${win.end}' FROM artists WHERE id = '${s.artistId}';`,
          ]
        : [],
    ),
    ...HM_SESSIONS.flatMap((s) => {
      const win = resolveWindow(now, s.from, s.to, dayIdByDate)
      return win
        ? [
            `UPDATE event_sessions SET day_id = '${win.dayId}', start_time = '${win.start}', ` +
              `end_time = '${win.end}' WHERE id = '${s.id}';`,
          ]
        : []
    }),
  ]

  mkdirSync(OUT_DIR, { recursive: true })
  const applied = path.join(OUT_DIR, 'shift-festival-to-now.applied.sql')
  writeFileSync(applied, `${stmts.join('\n')}\n`)
  log(`re-centring Harvest Moon on ${dayDates[1]} ${now.toLocaleTimeString()} (${applied})`)
  const eventsApi = path.join(REPO_ROOT, 'apps', 'events-api')
  await wrangler(eventsApi, ['d1', 'execute', 'DB', '--local', '--file', applied])

  const expectedToday = slotRows.filter(({ win }) => win?.dayId === HM_TODAY_DAY_ID).length
  const check = parseD1Json(
    await wrangler(eventsApi, [
      'd1',
      'execute',
      'DB',
      '--local',
      '--command',
      `SELECT COUNT(*) AS n FROM event_artists WHERE day_id = '${HM_TODAY_DAY_ID}'`,
      '--json',
    ]),
  )
  const n = Number(check[0]?.results?.[0]?.n ?? 0)
  if (n < expectedToday) {
    throw new Error(
      `expected at least ${expectedToday} lineup slots on the demo festival's day 2 (today), found ${n}. ` +
        'Run `bash scripts/seed-demo-festival.sh local` first (the dev stack seeds it).',
    )
  }
  log(`festival is live: ${n} sets today, 3 playing now`)
}

// ---------------------------------------------------------------------------
// Festival site map — hand-authored dark SVG, rendered to PNG with the
// same chromium so it matches the app chassis.
// ---------------------------------------------------------------------------

// Portrait aspect: the attendee map page renders the image full-width in
// a 390px-wide mobile viewport, so a 4:3 map leaves ~300px of dead space
// under it. 1200x1560 fills the frame.
const MAP_W = 1200
const MAP_H = 1560

/** POIs, positioned as a fraction of the map image to line up with the
 *  features drawn in the SVG below. */
const FESTIVAL_POIS: { name: string; category: string; xPct: number; yPct: number }[] = [
  { name: 'Meadow Stage', category: 'stage', xPct: 0.267, yPct: 0.186 },
  { name: 'Grove Stage', category: 'stage', xPct: 0.742, yPct: 0.218 },
  { name: 'Starlight Tent', category: 'stage', xPct: 0.5, yPct: 0.558 },
  { name: 'Food Court', category: 'food', xPct: 0.242, yPct: 0.699 },
  { name: 'Camping', category: 'camp_site', xPct: 0.758, yPct: 0.718 },
  { name: 'Main Gate', category: 'entrance', xPct: 0.5, yPct: 0.891 },
]

function festivalMapSvg(): string {
  const label = (x: number, y: number, text: string, size = 34, fill = '#e8f0f7') =>
    `<text x="${x}" y="${y}" fill="${fill}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="700" text-anchor="middle" letter-spacing="1.5">${text}</text>`
  const sub = (x: number, y: number, text: string) =>
    `<text x="${x}" y="${y}" fill="#7fa4c0" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="22" text-anchor="middle" letter-spacing="3">${text}</text>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_W}" height="${MAP_H}" viewBox="0 0 ${MAP_W} ${MAP_H}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0d2033"/>
      <stop offset="100%" stop-color="#081726"/>
    </linearGradient>
    <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
      <path d="M80 0 L0 0 0 80" fill="none" stroke="#12314b" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${MAP_W}" height="${MAP_H}" fill="url(#ground)"/>
  <rect width="${MAP_W}" height="${MAP_H}" fill="url(#grid)"/>

  <!-- river / treeline sweeping through the site -->
  <path d="M -40 1290 C 240 1200, 420 1360, 700 1280 S 1080 1170, 1240 1240"
        fill="none" stroke="#123a52" stroke-width="52" stroke-linecap="round" opacity="0.75"/>
  <path d="M -40 120 C 200 60, 420 180, 660 110 S 1060 40, 1240 100"
        fill="none" stroke="#143d3a" stroke-width="74" stroke-linecap="round" opacity="0.5"/>

  <!-- main paths -->
  <path d="M 600 1390 L 600 940 M 600 1060 L 290 1090 M 600 1060 L 910 1120"
        fill="none" stroke="#2a5f83" stroke-width="10" stroke-dasharray="18 14" opacity="0.8"/>
  <path d="M 600 780 L 320 400 M 600 780 L 890 440 M 265 620 L 320 400"
        fill="none" stroke="#2a5f83" stroke-width="10" stroke-dasharray="18 14" opacity="0.8"/>

  <!-- NOTE: features that get a POI pin are drawn WITHOUT a text label —
       the app renders its own POI label on top, and two sets of text on
       the same shape reads as a rendering bug. Only areas with no pin
       (Craft Barn, Meadow Lawn) carry baked-in labels. -->

  <!-- Meadow Stage -->
  <rect x="120" y="180" width="400" height="220" rx="18" fill="#16405e" stroke="#3d9ad1" stroke-width="4"/>
  <rect x="152" y="210" width="336" height="72" rx="10" fill="#3d9ad1" opacity="0.55"/>
  <g fill="none" stroke="#3d9ad1" stroke-width="3" opacity="0.5">
    <path d="M 172 322 h 296 M 172 356 h 296"/>
  </g>

  <!-- Grove Stage -->
  <rect x="700" y="240" width="380" height="200" rx="18" fill="#16405e" stroke="#3d9ad1" stroke-width="4"/>
  <rect x="732" y="268" width="316" height="62" rx="10" fill="#3d9ad1" opacity="0.55"/>
  <g fill="none" stroke="#3d9ad1" stroke-width="3" opacity="0.5">
    <path d="M 752 364 h 276 M 752 398 h 276"/>
  </g>

  <!-- Craft Barn (no pin — keeps its baked-in label) -->
  <rect x="150" y="500" width="230" height="120" rx="14" fill="#2b2338" stroke="#9d7fd1" stroke-width="3"/>
  ${label(265, 570, 'CRAFT BARN', 22, '#ddd0f2')}

  <!-- Meadow Lawn (no pin — keeps its baked-in label) -->
  <ellipse cx="850" cy="580" rx="155" ry="82" fill="#14332a" stroke="#4fae72" stroke-width="3" opacity="0.85"/>
  ${label(850, 588, 'MEADOW LAWN', 20, '#bfe6cd')}

  <!-- Starlight Tent -->
  <path d="M 600 700 L 770 940 L 430 940 Z" fill="#1d3f63" stroke="#6fb2e0" stroke-width="4"/>
  <path d="M 600 700 L 600 940" stroke="#6fb2e0" stroke-width="3" opacity="0.5"/>

  <!-- Food Court -->
  <rect x="130" y="1000" width="320" height="180" rx="18" fill="#3a2c17" stroke="#d19a3d" stroke-width="4"/>
  <g fill="none" stroke="#d19a3d" stroke-width="3" opacity="0.55">
    <rect x="158" y="1116" width="60" height="42" rx="6"/>
    <rect x="230" y="1116" width="60" height="42" rx="6"/>
    <rect x="302" y="1116" width="60" height="42" rx="6"/>
    <rect x="374" y="1116" width="52" height="42" rx="6"/>
  </g>

  <!-- Camping -->
  <rect x="720" y="980" width="380" height="280" rx="18" fill="#17301f" stroke="#4fae72" stroke-width="4"/>
  <g fill="none" stroke="#4fae72" stroke-width="3" opacity="0.6">
    <path d="M 770 1210 l 26 -44 l 26 44 Z"/>
    <path d="M 850 1210 l 26 -44 l 26 44 Z"/>
    <path d="M 930 1210 l 26 -44 l 26 44 Z"/>
    <path d="M 1010 1210 l 26 -44 l 26 44 Z"/>
    <path d="M 770 1150 l 26 -44 l 26 44 Z"/>
    <path d="M 930 1150 l 26 -44 l 26 44 Z"/>
  </g>

  <!-- Main Gate -->
  <rect x="510" y="1340" width="180" height="100" rx="14" fill="#3c1f24" stroke="#d1605f" stroke-width="4"/>
  <path d="M 555 1440 v -60 M 645 1440 v -60" stroke="#d1605f" stroke-width="4" opacity="0.7"/>
  ${sub(600, 1490, 'ENTRY')}
</svg>`
}

async function renderFestivalMap(browser: Browser): Promise<string> {
  const file = path.join(OUT_DIR, 'harvest-moon-sitemap.png')
  const ctx = await browser.newContext({
    viewport: { width: MAP_W, height: MAP_H },
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#081726">${festivalMapSvg()}</body></html>`,
    { waitUntil: 'load' },
  )
  await page.waitForTimeout(500)
  await page.screenshot({ path: file })
  await ctx.close()
  log(`site map rendered -> ${file} (${MAP_W}x${MAP_H})`)
  return file
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type Ctx = { browser: Browser; demo: BrowserContext }

const steps: Record<string, (c: Ctx) => Promise<void>> = {
  /** Seed planner data + capture My Day, Tasks and Shopping. */
  async planner({ demo }) {
    const page = await demo.newPage()
    await signIn(page, {
      email: DEMO_EMAIL,
      startUrl: `${PLANNER_WEB}/tasks`,
      landingPrefix: PLANNER_WEB,
    })
    await seedPlanner(page)
    await seedShopping(page)

    await page.goto(`${PLANNER_WEB}/tasks`, { waitUntil: 'domcontentloaded' })
    await shot(page, 'planner-tasks')

    await page.goto(`${PLANNER_WEB}/shopping`, { waitUntil: 'domcontentloaded' })
    // Deliberately unscrolled — do NOT add a scrollY here to "fix" the
    // floating "+" FAB overlapping the last category chip.
    //
    // Measured geometry: the FAB occupies y 706-746 and the only gaps big
    // enough are the section gaps at 662-704 and 760-803. The upper one
    // would need scrolling *up* from 0 (impossible); the lower one needs
    // scrollY 55. But the "Shopping" H1 sits just 18px below the inner
    // scroller's top edge, so anything past ~18px clips the heading — and
    // 18px is nowhere near enough to clear the row. It is strictly title
    // OR FAB-clear, with no value that gets both.
    //
    // The title wins: it anchors the shot and matches planner-tasks /
    // planner-my-day, which both show their headings, and a FAB floating
    // over content is normal mobile behavior rather than a defect.
    // (`scrollY` + the inner-scroller detection in shot() are kept — other
    // pages may need them.)
    await shot(page, 'planner-shopping')

    await page.goto(`${PLANNER_WEB}/me`, { waitUntil: 'domcontentloaded' })
    await settle(page)
    await dismissMorningCheckin(page)
    await shot(page, 'planner-my-day')

    await page.close()
  },

  /** Health /log + /stats. Seeds the training history into fitness-api's
   *  local D1 first — without it both shots are empty states. */
  async health({ demo }) {
    await seedFitnessHistory()
    const page = await demo.newPage()
    await signIn(page, {
      email: DEMO_EMAIL,
      startUrl: `${FITNESS_WEB}/log`,
      landingPrefix: FITNESS_WEB,
    })
    // Kill any stale live-session pill floating over the tab bar.
    await page.evaluate((keys: string[]) => {
      keys.forEach((k) => window.localStorage.removeItem(k))
    }, FITNESS_LIVE_KEYS)

    await page.goto(`${FITNESS_WEB}/log`, { waitUntil: 'domcontentloaded' })
    await shot(page, 'health-today')

    // The Today hub is mostly action tiles; History is where the seeded
    // training block actually shows. Captured so the better of the two
    // can be picked for the marketing page.
    await page.goto(`${FITNESS_WEB}/log/history`, { waitUntil: 'domcontentloaded' })
    await shot(page, 'health-today-history')

    await page.goto(`${FITNESS_WEB}/stats`, { waitUntil: 'domcontentloaded' })
    await settle(page)
    // 7 days only covers ~5 sessions of the seeded block; 28 days fills
    // the tiles and the weekly-volume chart properly.
    // The range control is a role="tablist" of role="tab" buttons
    // (apps/fitness-web/src/ui/TrainingView.tsx:143), not plain buttons.
    const range28 = page.getByRole('tab', { name: /28\s*DAYS/i })
    await range28.first().click()
    await page.waitForTimeout(1500)
    const heading = await page.getByText(/LAST 28 DAYS/i).first().isVisible().catch(() => false)
    if (!heading) throw new Error('stats range did not switch to 28 days')
    await shot(page, 'health-stats')

    await page.close()
  },

  /** The attendee "Now" tab of a festival that is LIVE at capture time.
   *
   *  Three passes:
   *   1. `shiftFestivalToNow()` re-centres the seeded Harvest Moon
   *      Festival on the local clock in events-api's D1 (see that
   *      function) so the live widgets have real content.
   *   2. Organizer (demo@) uploads the site map + places the POIs. Kept
   *      even though the Map tab is no longer shipped: the stage POIs
   *      are part of a fully set-up demo event, the map tab is one tap
   *      from the shot, and the upload is skip-if-present so it costs
   *      nothing on a re-run.
   *   3. Attendee (admin@) joins the festival and we shoot
   *      /events/:slug/attending/now. */
  async events({ browser, demo }) {
    await shiftFestivalToNow()
    const mapPng = await renderFestivalMap(browser)

    // --- organizer pass (demo, owner-equivalent via ADMIN_USER_IDS) ---
    const org = await demo.newPage()
    await signIn(org, {
      email: DEMO_EMAIL,
      startUrl: `${EVENTS_WEB}/events/${FESTIVAL_SLUG}/map`,
      landingPrefix: EVENTS_WEB,
    })
    await org.goto(`${EVENTS_WEB}/events/${FESTIVAL_SLUG}/map`, {
      waitUntil: 'domcontentloaded',
    })
    await settle(org)

    const existing = org.locator('img[alt$="map"]')
    let freshMap = false
    if (!(await existing.first().isVisible().catch(() => false))) {
      log('uploading site map')
      freshMap = true
      const layer = org.locator('#map-layer')
      if (await layer.isVisible().catch(() => false)) await layer.selectOption('site')
      await org.locator('#map-file').setInputFiles(mapPng)
      await org.getByRole('button', { name: /Upload map/i }).click()
      await existing.first().waitFor({ state: 'visible', timeout: 60_000 })
      await settle(org, 1200)
    } else {
      log('site map already uploaded — skipping upload')
    }

    // Place POIs: type the name, then click the spot on the map image.
    const img = org.locator('img[alt$="map"]').first()
    const box = await img.boundingBox()
    if (!box) throw new Error('map image has no bounding box')
    // On a fresh map there is nothing to reconcile, so place all of them.
    // Otherwise read the existing pins ONCE from the marker elements
    // themselves — a per-POI getByRole('button', {name}) probe also
    // matches the POI *list* rows below the canvas and produced false
    // "already placed" skips.
    const placed = new Set<string>()
    if (!freshMap) {
      const names = await org.locator('img[alt$="map"] ~ button, .rounded-full').allInnerTexts()
      names.forEach((n) => placed.add(n.trim()))
      log(`existing pins: ${[...placed].join(', ') || '(none)'}`)
    }

    for (const poi of FESTIVAL_POIS) {
      if (placed.has(poi.name)) {
        log(`POI already placed: ${poi.name}`)
        continue
      }
      await org.getByRole('combobox', { name: 'POI category' }).selectOption(poi.category)
      await org.getByPlaceholder('POI name, then click the map').fill(poi.name)
      await img.click({
        position: { x: box.width * poi.xPct, y: box.height * poi.yPct },
      })
      await org.waitForTimeout(700)
      log(`placed POI: ${poi.name}`)
    }
    await settle(org, 800)
    await org.close()

    // --- attendee pass (admin@, joins then views the map) ---
    const attendeeCtx = await newMobileContext(browser)
    const att = await attendeeCtx.newPage()
    await signIn(att, {
      email: ADMIN_EMAIL,
      startUrl: `${EVENTS_WEB}/browse/${FESTIVAL_SLUG}`,
      landingPrefix: EVENTS_WEB,
    })
    await att.goto(`${EVENTS_WEB}/browse/${FESTIVAL_SLUG}`, { waitUntil: 'domcontentloaded' })
    await settle(att)

    const join = att.getByRole('button', { name: 'Join event' })
    if (await join.isVisible().catch(() => false)) {
      await join.click()
      await att.waitForTimeout(2500)
      log('joined the festival')
    } else {
      log('already attending')
    }

    await att.goto(`${EVENTS_WEB}/events/${FESTIVAL_SLUG}/attending/now`, {
      waitUntil: 'domcontentloaded',
    })
    await settle(att, 1500)
    // Guard the whole point of the shot: an empty "Lineup now" means the
    // time-shift did not take (stale day rows, clock drift, wrong event).
    // Both live widgets: "Nothing scheduled around now" (Lineup now) and
    // "Nothing happening right now" (Sessions now), SoloNowPage.tsx.
    const empty = await att
      .getByText(/Nothing scheduled around now|Nothing happening right now/i)
      .first()
      .isVisible()
      .catch(() => false)
    if (empty) {
      throw new Error(
        'the Now tab rendered an empty live widget — shiftFestivalToNow() did ' +
          'not land on the event this attendee is viewing.',
      )
    }
    await shot(att, 'events-now')

    await att.close()
    await attendeeCtx.close()
  },

  /** Mid-session live strength workout with the rest timer running.
   *  Deliberately last — it is the most brittle flow. */
  async 'health-live'({ demo }) {
    const page = await demo.newPage()
    await signIn(page, {
      email: DEMO_EMAIL,
      startUrl: `${FITNESS_WEB}/log`,
      landingPrefix: FITNESS_WEB,
    })
    await page.evaluate((keys: string[]) => {
      keys.forEach((k) => window.localStorage.removeItem(k))
    }, FITNESS_LIVE_KEYS)

    await buildAndStartLiveSession(page, [
      {
        exercise: 'Back Squat',
        sets: [
          { reps: '5', load: '225' },
          { reps: '5', load: '225' },
          { reps: '5', load: '225' },
          { reps: '5', load: '225' },
        ],
      },
      {
        exercise: 'Barbell Bench Press',
        sets: [
          { reps: '5', load: '175' },
          { reps: '5', load: '175' },
          { reps: '5', load: '175' },
        ],
      },
    ])

    // Let the session clock accumulate before logging anything —
    // otherwise the header reads "0:04" next to "3 / 7 SETS", which is
    // an obviously impossible mid-session. Override with LIVE_WARMUP_MS=0
    // when iterating on the flow.
    const warmupMs = Number(process.env.LIVE_WARMUP_MS ?? 105_000)
    if (warmupMs > 0) {
      log(`letting the session clock run for ${Math.round(warmupMs / 1000)}s`)
      await page.waitForTimeout(warmupMs)
    }

    // Complete a few sets. The last completion arms the rest timer, so
    // shoot immediately afterwards while it is counting down.
    const checks = page.locator('button[aria-label="Complete set"]')
    const total = await checks.count()
    log(`live session has ${total} completable sets`)
    const toComplete = Math.min(3, total)
    for (let i = 0; i < toComplete; i++) {
      const btn = page.locator('button[aria-label="Complete set"]').first()
      await btn.click()
      await page.waitForTimeout(500)
      // Skip the rest overlay between completions so the next check is
      // clickable; the final one is left running for the screenshot.
      if (i < toComplete - 1) {
        const skip = page.getByRole('button', { name: 'Skip rest' })
        if (await skip.isVisible().catch(() => false)) {
          await skip.click()
          await page.waitForTimeout(400)
        }
      }
    }

    const timer = page.getByRole('dialog', { name: 'Rest timer' })
    await timer.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
      log('WARNING: rest timer overlay not visible')
    })

    // The overlay is full-screen and hides the session entirely — a bare
    // countdown ring tells the reader nothing about the app. Minimize it
    // to the docked "REST m:ss" pill so the shot shows the set list, the
    // completed sets AND a visibly running timer.
    const hide = page.getByRole('button', { name: /HIDE/i }).first()
    if (await hide.isVisible().catch(() => false)) {
      await hide.click()
      await page.waitForTimeout(600)
      log('minimized rest timer to the docked pill')
    }
    const pill = page.getByRole('button', { name: 'Expand rest timer' })
    if (!(await pill.isVisible().catch(() => false))) {
      log('WARNING: docked rest pill not visible — timer may have expired')
    }

    // Keep this short: a long settle lets the countdown run out.
    await page
      .addStyleTag({
        content: `*, *::before, *::after { caret-color: transparent !important; }
                  *:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }`,
      })
      .catch(() => {})
    await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (el && typeof el.blur === 'function') el.blur()
      window.scrollTo(0, 0)
    })
    await page.mouse.move(2, 2)
    await page.waitForTimeout(300)
    // This step screenshots directly (no settle — the countdown is
    // running), so it needs its own touch-media guard.
    await assertTouchMedia(page, 'health-live-workout')
    const file = path.join(OUT_DIR, 'health-live-workout.png')
    await page.screenshot({ path: file })
    log(`shot -> ${file}`)

    await page.close()
  },
}

interface BlockSpec {
  exercise: string
  /** One entry per set: reps and load in the composer's display unit. */
  sets: { reps: string; load: string }[]
}

/** Fill one exercise card in the strength composer. Set inputs repeat
 *  their aria-labels ("Set 1 amount in reps") across every card, so the
 *  locators must be scoped to the card, not the page. */
async function fillComposerBlock(page: Page, card: Locator, spec: BlockSpec): Promise<void> {
  const picker = card.getByRole('combobox').first()
  await picker.waitFor({ state: 'visible', timeout: 15_000 })
  await picker.fill(spec.exercise)
  await page.waitForTimeout(1200)

  // Option rows carry more than the bare name, so match contained text.
  const option = page.getByRole('option').filter({ hasText: spec.exercise }).first()
  if (!(await option.isVisible().catch(() => false))) {
    const all = await page.getByRole('option').allInnerTexts()
    throw new Error(
      `exercise "${spec.exercise}" not in picker. Options: ${JSON.stringify(all.slice(0, 12))}`,
    )
  }
  await option.click()
  await page.waitForTimeout(600)

  for (let i = 0; i < spec.sets.length; i++) {
    if (i > 0) {
      await card.getByRole('button', { name: '+ Add set' }).click()
      await page.waitForTimeout(400)
    }
    // Unit suffix varies (lb / kg), so match the label prefix.
    await card.getByLabel(new RegExp(`^Set ${i + 1} amount in`)).fill(spec.sets[i].reps)
    await card.getByLabel(new RegExp(`^Set ${i + 1} load in`)).fill(spec.sets[i].load)
    await page.waitForTimeout(200)
  }
  log(`composed block: ${spec.exercise} (${spec.sets.length} sets)`)
}

/** Build a strength workout in the composer and hit "Start now".
 *
 *  /live/strength/new no longer has an in-page exercise picker: with no
 *  session in the localStorage slot and no ?templateId it redirects to
 *  /composer?mode=strength (StrengthSessionPage.tsx:648). The composer's
 *  "Start now" seeds the live session slot and navigates back.
 */
async function buildAndStartLiveSession(page: Page, blocks: BlockSpec[]): Promise<void> {
  await page.goto(`${FITNESS_WEB}/composer?mode=strength`, { waitUntil: 'domcontentloaded' })
  await settle(page)

  await page.getByPlaceholder('e.g. Lower body A').fill('Lower A — Squat focus')

  const cards = page.locator('.fit-card').filter({ has: page.getByRole('combobox') })
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) {
      await page.getByRole('button', { name: '+ Add exercise' }).click()
      await page.waitForTimeout(700)
    }
    await fillComposerBlock(page, cards.nth(i), blocks[i])
  }

  const start = page.getByRole('button', { name: 'Start now' })
  await start.scrollIntoViewIfNeeded().catch(() => {})
  await start.click()

  // If a live session was already parked in the slot the composer asks
  // before discarding it.
  const replace = page.getByRole('button', { name: 'Start new session' })
  if (await replace.isVisible().catch(() => false)) {
    await replace.click()
  }

  await page.waitForURL((u) => u.pathname.includes('/live/strength'), { timeout: 30_000 })
  await settle(page)
  log('live session started')
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Run order for a full pass. Not `Object.keys(steps)`: 'health-live' is
 *  deliberately last (most brittle flow) and the seeding steps want to go
 *  first. Kept honest by fullPassOrder() below rather than by convention —
 *  a step added to `steps` and forgotten here would otherwise silently
 *  never run in a full pass. */
const ORDER = ['planner', 'health', 'events', 'health-live']

function fullPassOrder(): string[] {
  const defined = Object.keys(steps)
  const unordered = defined.filter((s) => !ORDER.includes(s))
  const phantom = ORDER.filter((s) => !defined.includes(s))
  const problems = [
    unordered.length ? `missing from ORDER [${unordered.join(', ')}]` : null,
    phantom.length ? `named in ORDER but not defined in steps [${phantom.join(', ')}]` : null,
  ].filter((p): p is string => p !== null)
  if (problems.length) {
    throw new Error(`ORDER is out of sync with \`steps\`: ${problems.join('; ')}`)
  }
  return ORDER
}

async function main(): Promise<void> {
  // Startup guard, run even for a single-step retake or --list.
  const order = fullPassOrder()

  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    // Print `order`, not Object.keys(steps): a full pass runs ORDER, so
    // listing the raw object keys would advertise a different sequence
    // than the one the script actually executes.
    console.warn(order.join('\n'))
    return
  }
  const requested = args.filter((a) => !a.startsWith('-'))
  const toRun = requested.length ? requested : order
  for (const name of toRun) {
    if (!steps[name]) throw new Error(`unknown step "${name}" (try --list)`)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    headless: !process.env.HEADED,
    args: [TOUCH_BLINK_SETTINGS],
  })
  const demo = await newMobileContext(browser)

  try {
    for (const name of toRun) {
      log(`=== step: ${name} ===`)
      await steps[name]({ browser, demo })
    }
  } finally {
    await demo.close().catch(() => {})
    await browser.close().catch(() => {})
  }
  log('done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
