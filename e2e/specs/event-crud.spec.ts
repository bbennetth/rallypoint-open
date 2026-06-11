import { test, expect } from '@playwright/test'
import { STORAGE_STATE } from '../helpers/paths.js'
import { uniqueEvent } from '../helpers/data.js'

// Reuse the session minted by auth.setup.ts so this data-heavy spec skips
// the slow Mailpit sign-in dance. Covers the full create → edit → delete →
// restore lifecycle the manual walkthrough used to exercise by hand.
test.use({ storageState: STORAGE_STATE })

test('create, edit, delete, and restore an event', async ({ page }) => {
  const event = uniqueEvent()
  const renamed = `${event.name} (edited)`

  // --- Create -------------------------------------------------------
  await page.goto('/events/new')
  await expect(page.getByRole('heading', { name: 'New Event' })).toBeVisible()
  await page.locator('#name').fill(event.name)
  await page.locator('#timezone').fill('America/New_York')
  await page.locator('#slug').fill(event.slug)
  await page.getByRole('button', { name: 'Create event' }).click()

  await page.waitForURL(`**/events/${event.slug}`, { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: event.name })).toBeVisible()

  // --- Shows up in My Events ---------------------------------------
  await page.goto('/me/events')
  await expect(page.getByRole('link', { name: event.name })).toBeVisible()

  // --- Edit --------------------------------------------------------
  await page.goto(`/events/${event.slug}`)
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.locator('#edit-name').fill(renamed)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible()

  // --- Delete (browser confirm → navigates back to /me/events) -----
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete event' }).click()
  await page.waitForURL('**/me/events', { timeout: 15_000 })

  // Deleted events are hidden by default; reveal them and assert the
  // row now carries the "deleted" badge.
  await page.getByLabel('Show deleted events').check()
  const deletedRow = page.locator('li', { has: page.getByRole('link', { name: renamed }) })
  await expect(deletedRow).toBeVisible()
  await expect(deletedRow.getByText('deleted', { exact: true })).toBeVisible()

  // --- Restore (from the detail page danger zone) ------------------
  await page.goto(`/events/${event.slug}`)
  await expect(page.getByText('deleted', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Restore event' }).click()

  // Restored in place: the deleted badge is gone and the delete action
  // is available again.
  await expect(page.getByRole('button', { name: 'Delete event' })).toBeVisible()
  await expect(page.getByText('deleted', { exact: true })).toHaveCount(0)
})
