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
// lists-api on item create — the BFF doesn't touch it. Clients may override
// the auto-assigned category via item PATCH by including
// { customFields: { 'rp:category': '<category>' } }.

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
  // tasks or notes list via this path. Auto-categorization happens server-side
  // in lists-api (categorize()) — the BFF doesn't touch it.
  .post('/api/v1/ui/shopping/:listId/items', requireSession(), async (c) => {
    const actor = c.var.session!.userId
    const listId = c.req.param('listId')
    const lists = c.var.services.listsClient
    const parsed = CreateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const created = await proxyLists(async () => {
      await assertIsActorShoppingList(lists, actor, listId)
      return lists.createListItem(listId, parsed.data, actor)
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
