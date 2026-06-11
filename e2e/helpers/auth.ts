import { expect, type Page } from '@playwright/test'
import { clearMailpit, waitForSigninCode } from './mailpit.js'

export interface SignInOptions {
  // Identifier typed into the "Email or username" field.
  username?: string
  // Mailbox the 2FA code is delivered to (must match the user's email).
  email?: string
  password?: string
  // Protected events-web path to enter from; RequireSession bounces it
  // through the SSO chain to id-web sign-in.
  startAt?: string
}

// Drive the full cross-app sign-in: events-web RequireSession →
// id-web /sso/authorize → /signin (two-step: password, then emailed
// 6-digit code) → back through /sso/callback → events session set.
// Leaves the page on the events-web destination (default /me/events).
export async function signInViaSso(page: Page, opts: SignInOptions = {}): Promise<void> {
  const username = opts.username ?? 'demo'
  const email = opts.email ?? 'demo@example.com'
  const password = opts.password ?? 'password'
  const startAt = opts.startAt ?? '/me/events'

  // Clear first so the code we read after "Continue" is the fresh one.
  await clearMailpit()

  await page.goto(startAt)

  // RequireSession → beginSso → id-web /signin (full-page redirects).
  await page.waitForURL(/:5173\/signin/, { timeout: 30_000 })

  await page.getByLabel('Email or username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Continue' }).click()

  // Step 2: emailed 6-digit code.
  const codeField = page.getByLabel('6-digit code')
  await expect(codeField).toBeVisible({ timeout: 15_000 })
  const code = await waitForSigninCode(email)
  await codeField.fill(code)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Signin bounces back to /sso/authorize → mints code → /sso/callback →
  // exchange → lands on the events-web destination with a session.
  await page.waitForURL(`**${startAt}`, { timeout: 30_000 })
  // Sanity: we're on events-web, not stranded back in the SSO flow.
  expect(page.url()).toContain(':5174')
}

// planner-web's origin (the dev-stack port). The Playwright baseURL points at
// events-web, so Planner specs navigate with absolute URLs.
export const PLANNER_WEB_URL = 'http://localhost:5177'

export interface PlannerSignInOptions {
  username?: string
  email?: string
  password?: string
  // Protected planner-web path to enter from (default /me — My Day).
  startAt?: string
}

// Drive the full cross-app sign-in for Rallypoint Planner: planner-web
// RequireSession → RPID /sso/authorize (client=planner) → id-web /signin
// (password, then emailed 6-digit code) → back through planner-web
// /sso/callback → planner session set. Same RPID identity as events-web, but
// a distinct planner session cookie and the `planner` SSO client. Leaves the
// page on the planner-web destination (default /me).
export async function signInToPlanner(
  page: Page,
  opts: PlannerSignInOptions = {},
): Promise<void> {
  const username = opts.username ?? 'demo'
  const email = opts.email ?? 'demo@example.com'
  const password = opts.password ?? 'password'
  const startAt = opts.startAt ?? '/me'

  await clearMailpit()

  await page.goto(`${PLANNER_WEB_URL}${startAt}`)

  // RequireSession → beginSso → id-web /signin (full-page redirects).
  await page.waitForURL(/:5173\/signin/, { timeout: 30_000 })

  await page.getByLabel('Email or username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Continue' }).click()

  const codeField = page.getByLabel('6-digit code')
  await expect(codeField).toBeVisible({ timeout: 15_000 })
  const code = await waitForSigninCode(email)
  await codeField.fill(code)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Signin → /sso/authorize (planner) → mints code → planner /sso/callback →
  // exchange → lands on the planner-web destination with a session. Glob match
  // (like signInViaSso) tolerates a trailing slash / query the SPA may append.
  await page.waitForURL(`**${startAt}`, { timeout: 30_000 })
  // Sanity: we're on planner-web, not stranded back in the SSO flow.
  expect(page.url()).toContain(':5177')
}
