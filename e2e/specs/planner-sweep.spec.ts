import { test, expect } from '@playwright/test'
import { PLANNER_WEB_URL, signInToPlanner } from '../helpers/auth.js'
import { todayAtNoonLocal, uniquePlanner } from '../helpers/data.js'

// Rallypoint Planner end-to-end sweep (slice 11). One signed-in journey across
// all four Planner surfaces, exercising the cross-app SSO round-trip
// (client=planner) and the BFF → Lists/Events SDK fan-out:
//
//   1. Sign in via SSO and land on My Day.
//   2. Create a personal task list + an (undated) task under it.
//   3. Create a personal event starting today at noon.
//   4. My Day shows today's event (and not the undated task).
//   5. Upcoming merges both: the event in "Scheduled", the task in "No date".
//
// This is the regression guard for the whole Planner stack wiring — it owns its
// own session (no saved storageState), so it covers the SSO chain too.

test('planner sweep — SSO, tasks, events, My Day, Upcoming', async ({ page }) => {
  const { listName, taskTitle, eventName } = uniquePlanner()

  // 1. SSO sign-in → My Day.
  await signInToPlanner(page)
  await expect(page.getByRole('heading', { name: 'My Day', level: 1 })).toBeVisible()

  // 2. The single canonical Tasks list (#543) + an undated task. Tasks is now
  // one system-managed list (like Shopping/Notes) — no "add list" step; the
  // list is auto-provisioned on load, so the task input is available straight
  // away. (`listName` from uniquePlanner is unused now that lists aren't created.)
  void listName
  await page.goto(`${PLANNER_WEB_URL}/tasks`)
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible()
  const taskField = page.getByLabel('New task title')
  await expect(taskField).toBeVisible({ timeout: 15_000 })
  await taskField.fill(taskTitle)
  await taskField.press('Enter')
  await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 15_000 })

  // 2b. A recurring task (slice 12). Toggle Repeat, then submit: the series
  // materializes occurrence items server-side, each badged "Repeats".
  const recurringTitle = `${taskTitle} weekly`
  await taskField.fill(recurringTitle)
  await page.getByLabel('Repeat this task').check()
  await expect(page.getByLabel('Frequency')).toBeVisible()
  await page.getByRole('button', { name: 'Add' }).last().click()
  await expect(page.getByText('Repeats').first()).toBeVisible({ timeout: 15_000 })

  // 2c. A custom field (slice 13). Open the field manager, define a text
  // field, then confirm its control renders under each task (the per-item
  // value editor labels each active def). Proves the BFF → Lists SDK
  // def-write chain end-to-end.
  await page.getByRole('button', { name: 'Manage custom fields' }).click()
  await page.getByLabel('New field label').fill('Location')
  await page.getByRole('button', { name: 'Add field' }).click()
  // The new def now drives a per-task control (aria-label "<label> value")
  // rendered under each task row.
  await expect(page.getByLabel('Location value').first()).toBeVisible({ timeout: 15_000 })

  // 3. Personal event starting today at noon.
  await page.goto(`${PLANNER_WEB_URL}/events`)
  await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible()
  await page.getByLabel('Event name').fill(eventName)
  await page.getByLabel('Event start').fill(todayAtNoonLocal())
  await page.getByRole('button', { name: 'Add event' }).click()
  await expect(page.getByRole('heading', { name: eventName })).toBeVisible({ timeout: 15_000 })

  // 3b. Events calendar view (#547): switch to month view on the Events tab and
  //     verify the created event's day shows a chip marker.
  await page.goto(`${PLANNER_WEB_URL}/events`)
  await page.getByRole('button', { name: 'Month' }).click()
  // At least one .cal-chip should appear (the event we just created falls today).
  await expect(page.locator('.cal-chip').first()).toBeVisible({ timeout: 15_000 })

  // 4. My Day reflects today's event under "Events today".
  await page.goto(`${PLANNER_WEB_URL}/me`)
  const eventsToday = page.locator('section', {
    has: page.getByRole('heading', { name: 'Events today' }),
  })
  await expect(eventsToday.getByText(eventName, { exact: true })).toBeVisible({ timeout: 15_000 })

  // 5. Upcoming merges both buckets: the dated event vs the undated task.
  await page.goto(`${PLANNER_WEB_URL}/upcoming`)
  await expect(page.getByRole('heading', { name: 'Upcoming', level: 1 })).toBeVisible()

  const scheduled = page.locator('section', {
    has: page.getByRole('heading', { name: 'Scheduled' }),
  })
  await expect(scheduled.getByText(eventName, { exact: true })).toBeVisible({ timeout: 15_000 })

  const noDate = page.locator('section', {
    has: page.getByRole('heading', { name: 'No date' }),
  })
  await expect(noDate.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 15_000 })

  // 6. Chores (#546): add a recurring chore, confirm it materializes on the
  //    Chores tab, appears in the Upcoming feed, then toggle it OFF inline and
  //    confirm it disappears from the feed.
  const choreTitle = `${taskTitle} chore`
  await page.goto(`${PLANNER_WEB_URL}/chores`)
  await expect(page.getByRole('heading', { name: 'Chores', level: 1 })).toBeVisible({ timeout: 15_000 })
  const choreField = page.getByLabel('New chore name')
  await expect(choreField).toBeVisible({ timeout: 15_000 })
  await choreField.fill(choreTitle)
  // Repeat is on by default on the Chores tab; daily so an occurrence lands today.
  await page.getByRole('button', { name: 'Day(s)' }).click()
  await page.getByRole('button', { name: 'Add' }).last().click()
  // Occurrence items materialize server-side and render badged "Recurring".
  await expect(page.getByText(choreTitle, { exact: true }).first()).toBeVisible({ timeout: 15_000 })

  // The chore appears in the Upcoming feed (My Day agenda) while the toggle is on.
  await page.goto(`${PLANNER_WEB_URL}/me`)
  await expect(page.getByText(choreTitle, { exact: true }).first()).toBeVisible({ timeout: 15_000 })

  // Toggle chores OFF inline near the feed header → the feed refetches and the
  // chore disappears.
  await page.getByLabel('Show chores in feed').uncheck()
  await expect(page.getByText(choreTitle, { exact: true })).toHaveCount(0, { timeout: 15_000 })
})
