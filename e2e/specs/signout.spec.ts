import { test } from '@playwright/test'
import { signInViaSso } from '../helpers/auth.js'

// Owns its own session (inline sign-in, no shared storageState) so tearing
// it down can't 401 the other specs. Regression guard for #93: signing out
// of events-web must genuinely drop the events session, so the next visit to
// a protected page is forced back through the SSO chain (a request to
// id-web's /sso/authorize). Note the RPID session is intentionally NOT
// cleared by an events-web signout today, so that re-auth completes silently
// — but it can only happen at all if the events session was actually gone.
test('sign out drops the events session', async ({ page }) => {
  await signInViaSso(page)
  await page.goto('/me/events')

  // Wait for the signout POST to land before navigating — otherwise the
  // next nav races a still-valid session cookie and never re-enters SSO.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/ui/signout')),
    page.getByRole('button', { name: 'Sign out' }).click(),
  ])

  // handleSignOut redirects to the public landing page once signout resolves.
  await page.waitForURL(/:5174\/$/, { timeout: 15_000 })

  // The events session is gone: visiting a protected page forces a fresh SSO
  // round-trip through id-web (:5173). The authorize request firing is proof.
  const authorizeHit = page.waitForRequest(/:5173\/sso\/authorize/, { timeout: 15_000 })
  await page.goto('/me/events')
  await authorizeHit
})
