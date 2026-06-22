import { Hono } from 'hono'
import { ulid } from 'ulid'
import type { Context } from 'hono'
import {
  CreateListItemSchema,
  UpdateListItemSchema,
  CreateSeriesSchema,
  UpdateSeriesSchema,
} from '@rallypoint/lists-shared'
import { eventTimezoneField } from '@rallypoint/events-shared'
import type { ListsClient } from '@rallypoint/lists-client'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'
import { proxyLists } from '../lib/sdk-error.js'
import { resolveChoresList, findChoresList } from '../lib/personal-scope.js'
import { resolveRecurrenceDues } from '../lib/recurrence-time.js'
import { syncChoreSeriesNotification, type NotifiableChoreSeries } from '../lib/notifications.js'

// Best-effort: keep a chore series' scheduled push notification (its next
// occurrence) in sync with a series write. Only runs when the client passed a
// valid IANA `tz` (the Chores UI does). A timed series schedules; a day-only
// one cancels. A notification failure must never fail the user's write.
async function syncChoreNotificationSafe(
  c: Context<HonoApp>,
  actor: string,
  series: NotifiableChoreSeries,
  tz: string,
): Promise<void> {
  try {
    await syncChoreSeriesNotification(c.var.repos, actor, series, {
      now: new Date(),
      tz,
      appUrl: c.var.env.PLANNER_UI_ORIGIN,
      newId: () => `psn_${ulid()}`,
    })
  } catch (err) {
    c.var.logger.warn({ err, seriesId: series.id }, 'failed to sync chore notification')
  }
}

// Planner Chores BFF (#546) — a single system-managed `chores`-type list per
// user, holding recurring household items. The list is auto-provisioned on
// first access (resolveChoresList) and is NOT deletable (lists-api rejects
// deletions of system-managed list types at the SDK boundary). No
// create-list / delete-list endpoints are exposed — the list is fully managed
// by the BFF.
//
// Recurring is the primary flow: the series routes here are the chores
// analogue of the series routes in lists.ts, but locked to the actor's single
// chores list. lists-api's loadListForActor checks group membership but NOT
// list type, and the series update/delete SDK calls are not actor-scoped, so
// the BFF owns BOTH the ownership guard (is this the actor's list?) AND the
// type guard (is it the chores list, not their tasks/notes/shopping list?).

// Ownership + type guard shared by every write route. Without the type check an
// actor could drive chores writes against their own tasks/notes/shopping list
// via this path (cross-type confusion). Mirrors shopping.ts's
// assertIsActorShoppingList exactly.
async function assertIsActorChoresList(
  lists: ListsClient,
  actor: string,
  listId: string,
): Promise<void> {
  const theList = await findChoresList(lists, actor)
  if (!theList || theList.id !== listId) throw errors.notFound('List not found.')
}

export const choresRoutes = new Hono<HonoApp>()
  // --- get THE caller's chores list (auto-provision on first access) ---
  .get('/api/v1/ui/chores/list', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const list = await proxyLists(() => resolveChoresList(lists, actor))
    return c.json(list)
  })

  // --- items in the caller's chores list ---------------------------
  // Ownership + type guard on READ: the Lists READ surface trusts its caller
  // for scope access, so the BFF confirms the list is the actor's chores list
  // before listing items.
  .get('/api/v1/ui/chores/:listId/items', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    // Recurring occurrences carry a FLOATING local wall-clock due. Resolve it
    // into the request tz HERE — the single resolver — so the client receives a
    // genuine instant and renders it with plain local formatters (no client-side
    // re-anchor). tz defaults to UTC, where resolution is the identity.
    const tzParsed = eventTimezoneField.safeParse(c.req.query('tz') ?? 'UTC')
    if (!tzParsed.success) throw errors.validation({ tz: 'must be a valid IANA timezone' })
    const items = await proxyLists(async () => {
      await assertIsActorChoresList(lists, actor, listId)
      return lists.listItems(listId)
    })
    return c.json(resolveRecurrenceDues(items, tzParsed.data))
  })

  // --- create an item ----------------------------------------------
  // One-offs are allowed; the recurring path goes through the series routes
  // below. chores items carry priority + dueDate (lists-api treats `chores`
  // like `tasks` for those columns).
  .post('/api/v1/ui/chores/:listId/items', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const parsed = CreateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(async () => {
      await assertIsActorChoresList(lists, actor, listId)
      return lists.createListItem(listId, parsed.data, actor)
    })
    return c.json(created, 201)
  })

  // --- update / check-off an item ----------------------------------
  .patch('/api/v1/ui/chores/:listId/items/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    const parsed = UpdateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await proxyLists(async () => {
      await assertIsActorChoresList(lists, actor, listId)
      return lists.updateListItem(listId, itemId, parsed.data, actor)
    })
    return c.json(updated)
  })

  // --- soft-delete an item -----------------------------------------
  .delete('/api/v1/ui/chores/:listId/items/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    await proxyLists(async () => {
      await assertIsActorChoresList(lists, actor, listId)
      await lists.deleteListItem(listId, itemId, actor)
    })
    return c.body(null, 204)
  })

  // --- recurring series in the caller's chores list ----------------
  // List series for the chores list.
  .get('/api/v1/ui/chores/:listId/series', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const rows = await proxyLists(async () => {
      await assertIsActorChoresList(lists, actor, listId)
      return lists.listSeries(listId)
    })
    return c.json(rows)
  })

  // --- create a recurring series -----------------------------------
  // Materializes occurrence items downstream, each carrying seriesId + dueDate
  // so the chore lands on a calendar day and the UI can badge it as recurring.
  .post('/api/v1/ui/chores/:listId/series', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const parsed = CreateSeriesSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(async () => {
      await assertIsActorChoresList(lists, actor, listId)
      return lists.createListItemSeries(listId, parsed.data, actor)
    })
    const tz = c.req.query('tz')
    if (tz) await syncChoreNotificationSafe(c, actor, created, tz)
    return c.json(created, 201)
  })

  // --- update a recurring series -----------------------------------
  // Two-step guard: confirm the list is the actor's chores list, then confirm
  // the seriesId belongs to it before patching (updateSeries is not
  // actor-scoped downstream).
  .patch('/api/v1/ui/chores/:listId/series/:seriesId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const seriesId = c.req.param('seriesId')
    const lists = c.var.services.listsClient
    const parsed = UpdateSeriesSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await proxyLists(async () => {
      await assertIsActorChoresList(lists, actor, listId)
      const series = await lists.listSeries(listId)
      if (!series.some((s) => s.id === seriesId)) throw errors.notFound('Series not found.')
      return lists.updateSeries(seriesId, parsed.data, actor)
    })
    const tz = c.req.query('tz')
    if (tz) await syncChoreNotificationSafe(c, actor, updated, tz)
    return c.json(updated)
  })

  // --- delete a recurring series -----------------------------------
  .delete('/api/v1/ui/chores/:listId/series/:seriesId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const seriesId = c.req.param('seriesId')
    const lists = c.var.services.listsClient
    await proxyLists(async () => {
      await assertIsActorChoresList(lists, actor, listId)
      const series = await lists.listSeries(listId)
      if (!series.some((s) => s.id === seriesId)) throw errors.notFound('Series not found.')
      return lists.deleteSeries(seriesId, actor)
    })
    try {
      await c.var.repos.scheduledNotifications.cancel(actor, `series:${seriesId}`, new Date())
    } catch (err) {
      c.var.logger.warn({ err, seriesId }, 'failed to cancel chore notification')
    }
    return c.body(null, 204)
  })
