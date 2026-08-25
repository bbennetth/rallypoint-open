import { test, expect } from '@playwright/test'
import { signInViaSso } from '../helpers/auth.js'
import { uniqueEvent } from '../helpers/data.js'

// The golden path: this spec owns the SSO sign-in flow itself (no saved
// storageState), so it's the regression guard for the cross-app auth
// round-trip — the exact flow that surfaced the slice-2a returnTo bug.
test('sign in via SSO and create an event', async ({ page }) => {
  await signInViaSso(page)

  const event = uniqueEvent()
  await page.goto('/events/new')
  await expect(page.getByRole('heading', { name: 'New Event' })).toBeVisible()

  await page.locator('#name').fill(event.name)
  await page.locator('#timezone').fill('America/New_York')
  await page.getByRole('button', { name: 'Create event' }).click()

  // Lands on the detail page for the new event. Slug is server-generated
  // (`<slugified-name>-<4 random chars>`), so we read it from the URL
  // rather than asserting on a client-minted value.
  await page.waitForURL(/\/events\/[^/]+$/, { timeout: 15_000 })
  const slug = new URL(page.url()).pathname.replace(/^.*\/events\//, '')
  expect(slug).toMatch(/^[a-z0-9-]+$/)
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible()
  await expect(page.getByText(slug, { exact: true })).toBeVisible()
})
