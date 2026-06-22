import { Hono } from 'hono'
import {
  CreateListItemSchema,
  UpdateListItemSchema,
} from '@rallypoint/lists-shared'
import type { ListsClient } from '@rallypoint/lists-client'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import { requireSession } from '../middleware/session.js'
import { readJsonBody } from './_body.js'
import { proxyLists } from '../lib/sdk-error.js'
import {
  resolveShoppingList,
  findShoppingList,
} from '../lib/personal-scope.js'

// Planner Shopping BFF — single system-managed shopping list per user.
// The list is auto-provisioned on first access (resolveShoppingList) and
// is NOT deletable (lists-api rejects deletions of system-managed list
// types at the SDK boundary). No create-list or delete-list endpoints
// are exposed from here — the list is fully managed by the BFF.
//
// Category auto-assignment (categorize() in lists-shared) happens inside
// lists-api on item create — the BFF passes the `autoCategorize` flag from
// the user's planner settings (`shoppingAutoCategorize`). When the setting
// is false the flag is forwarded as false and lists-api skips the keyword
// assignment. Clients may override any category via item PATCH by including
// { customFields: { 'rp:category': '<category>' } }.

// Setting key for the shopping auto-categorize preference (stored in the
// 'planner' namespace of the RPID generic user-settings store).
const SETTING_AUTO_CATEGORIZE = 'shoppingAutoCategorize'

// Ownership + type guard for write routes. lists-api's loadListForActor
// checks group membership but NOT list type, so without this guard an actor
// could write to their own tasks or notes list via the shopping path
// (cross-type confusion; shopping auto-categorization would fire on a tasks
// list). Mirrors the GET /items posture exactly.
async function assertIsActorShoppingList(
  lists: ListsClient,
  actor: string,
  listId: string,
): Promise<void> {
  const theList = await findShoppingList(lists, actor)
  if (!theList || theList.id !== listId) throw errors.notFound('List not found.')
}

export const shoppingRoutes = new Hono<HonoApp>()
  // --- get THE caller's shopping list (auto-provision on first access) ---
  // Returns the single system-managed shopping list for the actor,
  // provisioning it if it doesn't exist yet. Never returns an array —
  // the shopping surface is always a single list.
  .get('/api/v1/ui/shopping/list', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const lists = c.var.services.listsClient
    const list = await proxyLists(() => resolveShoppingList(lists, actor))
    return c.json(list)
  })

  // --- items in the caller's shopping list ---------------
  // Ownership guard on READ: the Lists READ surface trusts its caller for
  // scope access, so the BFF must confirm the list belongs to the actor's
  // personal scope AND is a shopping list before listing items. The listType
  // check prevents cross-type reads (e.g. reading a tasks list via this path).
  .get('/api/v1/ui/shopping/:listId/items', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const items = await proxyLists(async () => {
      const theList = await findShoppingList(lists, actor)
      if (!theList || theList.id !== listId)
        throw errors.notFound('List not found.')
      return lists.listItems(listId)
    })
    return c.json(items)
  })

  // --- create an item in a shopping list -------------------------
  // BFF guards list ownership AND list type before forwarding: lists-api
  // checks group membership but NOT list type, so without this guard an actor
  // could create items (triggering shopping auto-categorization) on their own
  // tasks or notes list via this path. Auto-categorization is controlled by
  // the user's `shoppingAutoCategorize` planner setting (true = on, false =
  // off). The flag is forwarded to lists-api as `autoCategorize` so the
  // keyword assignment can be skipped server-side. When the setting is absent
  // (new users) the default is true (existing behavior).
  .post('/api/v1/ui/shopping/:listId/items', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const parsed = CreateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })

    // Read the user's auto-categorize preference from the planner settings
    // store. Default to true (on) when the key is absent.
    let autoCategorize = true
    try {
      const settings = await c.var.services.settings.get(actor, 'planner')
      if (settings[SETTING_AUTO_CATEGORIZE] === false) {
        autoCategorize = false
      }
    } catch {
      // Settings fetch failure is non-fatal — fall back to default (on).
    }

    const created = await proxyLists(async () => {
      await assertIsActorShoppingList(lists, actor, listId)
      // autoCategorize is always settings-derived (server-side authority);
      // it overwrites any client-supplied value in the body.
      return lists.createListItem(listId, { ...parsed.data, autoCategorize }, actor)
    })
    return c.json(created, 201)
  })

  // --- update / check-off an item --------------------------------
  // Clients use this to override the auto-assigned category by sending
  // { customFields: { 'rp:category': '<category>' } }. List type guard
  // mirrors POST — see comment there.
  .patch('/api/v1/ui/shopping/:listId/items/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    const parsed = UpdateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const updated = await proxyLists(async () => {
      await assertIsActorShoppingList(lists, actor, listId)
      return lists.updateListItem(listId, itemId, parsed.data, actor)
    })
    return c.json(updated)
  })

  // --- soft-delete an item ---------------------------------------
  // List type guard mirrors POST — see comment there.
  .delete('/api/v1/ui/shopping/:listId/items/:itemId', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const itemId = c.req.param('itemId')
    const lists = c.var.services.listsClient
    await proxyLists(async () => {
      await assertIsActorShoppingList(lists, actor, listId)
      await lists.deleteListItem(listId, itemId, actor)
    })
    return c.body(null, 204)
  })
