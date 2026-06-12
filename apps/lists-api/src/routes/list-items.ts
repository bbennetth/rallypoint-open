import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  BulkItemActionSchema,
  CreateListItemSchema,
  UpdateListItemSchema,
  ownerTransferForMove,
  parseListQuery,
  validateCustomFields,
  validateListQuery,
  categorize,
  isCategory,
  CATEGORY_KEY,
  childRollup,
} from '@rallypoint/lists-shared'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { ListItemRecord, ListRecord, UpdateListItemInput } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { envelope, listChannel } from '../realtime/channels.js'
import { publish } from '../realtime/publish.js'
import { loadListForItemWrite, loadListForRead } from './_list-access.js'
import { ensureStatuses, resolveStatus } from './_statuses.js'
import { assertValidParent } from './_hierarchy.js'
import { ITEM_SCAN_CAP, applyScanCap } from '../lib/scan-cap.js'

const TENANT = 'rallypoint'

// 30-day soft-delete window; restoring past it is a conflict (the pruner
// hard-purges the row at the boundary).
const RESTORE_GRACE_MS = 30 * 24 * 60 * 60 * 1000

function serializeItem(
  i: ListItemRecord,
  labelIds: string[] = [],
): Record<string, unknown> {
  return {
    id: i.id,
    list_id: i.listId,
    title: i.title,
    notes: i.notes,
    assigned_to: i.assignedTo,
    completed: i.completed,
    completed_at: i.completedAt ? i.completedAt.toISOString() : null,
    status: i.status,
    status_id: i.statusId,
    parent_id: i.parentId,
    priority: i.priority,
    due_date: i.dueDate ? i.dueDate.toISOString() : null,
    custom_fields: i.customFields,
    label_ids: labelIds,
    position: i.position,
    created_by: i.createdBy,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
    deleted_at: i.deletedAt ? i.deletedAt.toISOString() : null,
  }
}

// Load the parent list with full read-authz (#128) — 404 if missing,
// soft-deleted, owned by another app, the caller isn't a scope member,
// or the caller can't see the list under its visibility policy. Items
// are only reachable through a readable parent.
async function loadList(c: Context<HonoApp>, listId: string): Promise<ListRecord> {
  return loadListForRead(c, listId)
}

// Mutation variant: additionally rejects planner-origin scopes, which
// are read-only on the UI surface (#531).
async function loadListMutable(c: Context<HonoApp>, listId: string): Promise<ListRecord> {
  return loadListForItemWrite(c, listId)
}

// Load an item and confirm it belongs to the parent list (Events
// "load parent then check child.parentId" convention). 404 otherwise.
// When allowDeleted is false, a soft-deleted item also 404s.
async function loadItem(
  c: Context<HonoApp>,
  listId: string,
  itemId: string,
  allowDeleted = false,
): Promise<ListItemRecord> {
  const item = await c.var.repos.listItems.findById(itemId)
  if (!item || item.listId !== listId) throw errors.itemNotFound()
  if (item.deletedAt && !allowDeleted) throw errors.itemNotFound()
  return item
}

// Validate that every id in `labelIds` belongs to the list's live labels.
// Returns a 400 validation error if any unknown/deleted label id is found.
async function validateLabelIds(
  c: Context<HonoApp>,
  listId: string,
  labelIds: string[],
): Promise<void> {
  if (labelIds.length === 0) return
  const liveLabels = await c.var.repos.listLabels.listForList(listId)
  const liveIds = new Set(liveLabels.map((l) => l.id))
  const unknown = labelIds.filter((id) => !liveIds.has(id))
  if (unknown.length > 0) {
    throw errors.validation({
      issues: [
        {
          code: 'custom',
          path: ['labelIds'],
          message: `Unknown or deleted label ids: ${unknown.join(', ')}`,
        },
      ],
    })
  }
}

export const listItemsRoutes = new Hono<HonoApp>()
  // --- create ------------------------------------------------------
  .post('/api/v1/ui/lists/:listId/items', async (c) => {
    const userId = c.var.session!.userId
    const list = await loadListMutable(c, c.req.param('listId'))
    const parsed = CreateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Task lists default status→'todo' and an omitted priority→'medium'
    // (port of festival-planner taskCreateDefaults), while an explicit
    // priority:null persists as no-priority. Non-task lists ignore any
    // client-supplied task fields — the columns are task-only and stay
    // null until a later slice owns them.
    const isTasks = list.listType === 'tasks'

    // Strip the reserved `rp:category` key BEFORE validateCustomFields —
    // it is not a field-def id so the validator would reject it. Handled
    // separately below (shopping auto-categorization).
    const rawCf = body.customFields ?? {}
    const clientCategory = rawCf[CATEGORY_KEY]
    const userFields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rawCf)) {
      if (k !== CATEGORY_KEY) userFields[k] = v
    }

    // Validate any custom-field values against the list's active field
    // defs. On a v1 list (no defs) this is `validateCustomFields([], {})`
    // → no-op, so v1 behaviour is unchanged. `required` is enforced here:
    // a create that omits a required field's value is rejected.
    const defs = await c.var.repos.fieldDefs.listForList(list.id)
    const cf = validateCustomFields(defs, userFields)
    if (!cf.ok) throw errors.validation({ issues: cf.issues })

    // Shopping lists: auto-assign category under the reserved system key
    // `rp:category` AFTER validateCustomFields (parity with sdk-writes).
    const persistedFields: Record<string, unknown> = { ...cf.values }
    if (list.listType === 'shopping') {
      if (isCategory(clientCategory)) {
        persistedFields[CATEGORY_KEY] = clientCategory
      } else {
        persistedFields[CATEGORY_KEY] = categorize(body.title)
      }
    }

    // Custom statuses (RPL v1.0.0): resolve the item's status against the
    // list's status set (lazily seeded on first use). An explicit
    // status_id wins; else the legacy `status` category maps to that
    // category's default status; else a task item defaults to `todo`. The
    // resolved category is dual-written to the legacy `status` text for the
    // completed mirror. Non-task lists ignore status entirely.
    const resolved = isTasks
      ? resolveStatus(await ensureStatuses(c, list.id, list.createdBy), {
          statusId: body.statusId,
          category: body.status,
          fallbackCategory: 'todo',
        })
      : { statusId: null, status: null }

    // Sub-item parent (RPL v1.0.0): validate it belongs to this list and
    // doesn't exceed the depth cap before creating. A new item has no
    // descendants, so self/cycle can't apply — only existence + depth.
    if (body.parentId !== undefined) {
      await assertValidParent(c, list.id, null, body.parentId)
    }

    // Validate label ids BEFORE creating the item so we don't create an
    // orphaned item if a label id is invalid.
    const labelIds = body.labelIds ?? []
    if (labelIds.length > 0) {
      await validateLabelIds(c, list.id, labelIds)
    }

    const item = await c.var.repos.listItems.create({
      id: `lit_${ulid()}`,
      tenantId: TENANT,
      listId: list.id,
      title: body.title,
      notes: body.notes ?? null,
      assignedTo: body.assignedTo ?? null,
      status: resolved.status,
      statusId: resolved.statusId,
      parentId: body.parentId ?? null,
      // body.priority is already resolved: schema default('medium') fills
      // undefined → 'medium'; explicit null passes through as null (no-priority).
      // The old `body.priority ?? 'medium'` would coerce null→'medium', so use
      // direct assignment — the schema guarantee covers the default.
      priority: isTasks ? body.priority : null,
      dueDate: isTasks && body.dueDate != null ? new Date(body.dueDate) : null,
      customFields: persistedFields,
      position: body.position,
      createdBy: userId,
    })

    // Apply the label set AFTER item creation (labels are many-to-many via
    // the join table; the item row must exist first).
    if (labelIds.length > 0) {
      await c.var.repos.listLabels.setItemLabels(item.id, labelIds)
    }

    publish(c, listChannel(list.id), envelope('list_items', 'create', item.id, userId))
    return c.json(serializeItem(item, labelIds), 201)
  })

  // --- bulk action (Lists v2 slice 6) ------------------------------
  // POST /lists/:listId/items/bulk — apply one action (update | delete)
  // across a set of items in a single repo transaction, emitting ONE
  // coalesced realtime frame. Authz matches single-item mutation
  // (loadListForRead + membership — any reader can mutate items, NOT the
  // creator-guard). Ids outside this list (or already soft-deleted) are
  // silently skipped server-side. The response carries the ids actually
  // affected so the client can reconcile its selection.
  .post('/api/v1/ui/lists/:listId/items/bulk', async (c) => {
    const userId = c.var.session!.userId
    const list = await loadListMutable(c, c.req.param('listId'))
    const parsed = BulkItemActionSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    if (body.action === 'delete') {
      const ids = await c.var.repos.listItems.bulkSoftDelete(list.id, body.itemIds, new Date())
      if (ids.length > 0) {
        // Orphan children of every deleted parent to top-level (RPL v1.0.0),
        // parity with the single-item delete — a bulk delete must not leave
        // a child dangling on a soft-deleted parent.
        await c.var.repos.listItems.bulkClearChildParent(list.id, ids)
        publish(c, listChannel(list.id), envelope('list_items', 'delete', list.id, userId))
      }
      return c.json({ count: ids.length, ids })
    }

    // action === 'update'. Map the bulk patch to a repo patch; task-only
    // fields apply only on task lists (parity with the single-item PATCH).
    const isTasks = list.listType === 'tasks'
    const base: UpdateListItemInput = {}
    if (body.patch.completed !== undefined) base.completed = body.patch.completed
    if (body.patch.assignedTo !== undefined) base.assignedTo = body.patch.assignedTo
    // Custom statuses (RPL v1.0.0): one shared status resolution for the
    // whole batch (statuses are list-level, identical for every item).
    if (isTasks && (body.patch.statusId !== undefined || body.patch.status !== undefined)) {
      const resolved = resolveStatus(await ensureStatuses(c, list.id, list.createdBy), {
        statusId: body.patch.statusId,
        category: body.patch.status,
      })
      base.statusId = resolved.statusId
      base.status = resolved.status
    }
    if (isTasks && body.patch.priority !== undefined) base.priority = body.patch.priority
    if (isTasks && body.patch.dueDate !== undefined)
      base.dueDate = body.patch.dueDate === null ? null : new Date(body.patch.dueDate)

    const hasBase = Object.keys(base).length > 0
    const cfPatch = body.patch.customFields
    const hasCustom = cfPatch !== undefined && Object.keys(cfPatch).length > 0

    // Nothing survived mapping (e.g. task-only fields sent to a non-task
    // list, with no custom-field change): no-op, touch nothing.
    if (!hasBase && !hasCustom) return c.json({ count: 0, ids: [] })

    // Resolve the live, in-list targets once (excludes soft-deleted +
    // cross-list ids). The repo re-scopes too; this also gives us each
    // item's existing custom_fields for the per-item merge.
    const live = await c.var.repos.listItems.listForList(list.id)
    const byId = new Map(live.map((i) => [i.id, i]))

    const defs = hasCustom ? await c.var.repos.fieldDefs.listForList(list.id) : []
    const activeIds = new Set(defs.map((d) => d.id))

    // Build a per-item patch. For custom fields, merge the bulk patch onto
    // each item's existing values (a `null` clears that key) then validate
    // the FINAL intended state per item so `required` holds row-by-row. A
    // bad value on ANY item throws before any write — the batch is
    // all-or-nothing (the repo runs the updates in one transaction).
    const isShopping = list.listType === 'shopping'

    // Hoist cfPatch-derived values out of the per-item loop — they depend only
    // on the loop-invariant cfPatch, not on any individual item.
    const clientCategory = hasCustom ? cfPatch![CATEGORY_KEY] : undefined
    const userCfPatch: Record<string, unknown> = {}
    if (hasCustom) {
      for (const [k, v] of Object.entries(cfPatch!)) {
        if (k !== CATEGORY_KEY) userCfPatch[k] = v
      }
    }

    const items: { id: string; fields: UpdateListItemInput }[] = []
    for (const id of body.itemIds) {
      const item = byId.get(id)
      if (!item) continue
      const fields: UpdateListItemInput = { ...base }
      if (hasCustom) {
        // Strip rp:category from the client patch before validateCustomFields —
        // it is a reserved system key (not a field-def id) and the validator
        // would reject it. Handled separately below (shopping re-carry).
        // (clientCategory and userCfPatch are hoisted above the loop.)

        const intended: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(item.customFields)) {
          if (activeIds.has(k)) intended[k] = v
        }
        for (const [k, v] of Object.entries(userCfPatch)) {
          if (v === null) delete intended[k]
          else intended[k] = v
        }
        const cf = validateCustomFields(defs, intended)
        if (!cf.ok) throw errors.validation({ issues: cf.issues })
        fields.customFields = { ...cf.values }

        // Shopping lists: re-carry the per-item existing rp:category so it
        // is not silently dropped by the activeIds filter above (which only
        // retains field-def ids). If the client also supplied an explicit
        // category in this patch, honour it (overrides existing); otherwise
        // keep whatever the item already had. Non-shopping lists: no-op.
        if (isShopping) {
          const existingCategory = item.customFields[CATEGORY_KEY]
          if (isCategory(existingCategory)) {
            fields.customFields[CATEGORY_KEY] = existingCategory
          }
          if (isCategory(clientCategory)) {
            fields.customFields[CATEGORY_KEY] = clientCategory
          }
        }
      } else if (isShopping) {
        // No custom-field patch from the client — base-only bulk update.
        // The repo only writes columns present in `fields`; since
        // customFields is absent, D1 will keep the stored value. Nothing
        // to do: the re-carry is implicit when customFields is not set.
      }
      items.push({ id, fields })
    }

    const ids = await c.var.repos.listItems.bulkUpdate(list.id, items)
    if (ids.length > 0) {
      publish(c, listChannel(list.id), envelope('list_items', 'update', list.id, userId))
    }
    return c.json({ count: ids.length, ids })
  })

  // --- list --------------------------------------------------------
  .get('/api/v1/ui/lists/:listId/items', async (c) => {
    const list = await loadList(c, c.req.param('listId'))
    // Filter/sort (Lists v2 slice 4): repeatable `filter`/`sort` query
    // params, parsed then validated against the list's active defs so no
    // raw field name reaches the query builder. Stale/invalid specs are
    // dropped rather than rejected (tolerant of deleted-field drift).
    const query = parseListQuery(c.req.queries('filter') ?? [], c.req.queries('sort') ?? [])
    const defs = await c.var.repos.fieldDefs.listForList(list.id)
    const { filters, sort } = validateListQuery(query, defs)
    // Fetch CAP+1 to detect (without scanning unbounded) whether the list
    // exceeds the cap; `applyScanCap` trims to CAP and flags truncation.
    const rows = await c.var.repos.listItems.listForList(list.id, {
      filters,
      sort,
      limit: ITEM_SCAN_CAP + 1,
    })
    const { items, truncated } = applyScanCap(rows, ITEM_SCAN_CAP)
    if (truncated) {
      c.var.logger.warn(
        { listId: list.id, cap: ITEM_SCAN_CAP, filterCount: filters.length },
        'list items scan hit the cap; results truncated',
      )
    }
    // Parent progress rollup (RPL v1.0.0): count direct children + done
    // children per parent in one pass so the UI can render sub-item
    // progress without N extra reads. Computed over the (capped) returned
    // set — children beyond the scan cap aren't counted, same bound as the
    // list itself.
    const roll = childRollup(items)
    // Label ids (RPL v1.0.0 slice 12): one batch query for all items so
    // the list GET doesn't fan out per item.
    const labelMap = await c.var.repos.listLabels.labelsForItems(items.map((i) => i.id))
    return c.json({
      items: items.map((it) => {
        const child = roll.get(it.id)
        return {
          ...serializeItem(it, labelMap.get(it.id) ?? []),
          child_count: child?.total ?? 0,
          child_done_count: child?.done ?? 0,
        }
      }),
      filter_truncated: truncated,
    })
  })

  // --- update (check-off / edit / reorder / assign / move) ---------
  .patch('/api/v1/ui/lists/:listId/items/:itemId', async (c) => {
    const list = await loadListMutable(c, c.req.param('listId'))
    const item = await loadItem(c, list.id, c.req.param('itemId'))
    const parsed = UpdateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const data = parsed.data

    // A cross-list move only counts when the target differs from the
    // current parent (PATCH-ing the same listId is a no-op).
    const isMove = data.listId !== undefined && data.listId !== list.id
    const isTasks = list.listType === 'tasks'

    // Map the validated body to the repo patch. dueDate arrives as an ISO
    // string and is cast to a Date for the timestamptz column. Task-only
    // fields are applied only on task lists.
    const patch: UpdateListItemInput = {}
    if (data.title !== undefined) patch.title = data.title
    if (data.notes !== undefined) patch.notes = data.notes
    if (data.assignedTo !== undefined) patch.assignedTo = data.assignedTo
    if (data.completed !== undefined) patch.completed = data.completed
    // Custom statuses (RPL v1.0.0): a status_id or legacy category change
    // resolves against the list's status set and dual-writes both columns.
    if (isTasks && (data.statusId !== undefined || data.status !== undefined)) {
      const resolved = resolveStatus(await ensureStatuses(c, list.id, list.createdBy), {
        statusId: data.statusId,
        category: data.status,
      })
      patch.statusId = resolved.statusId
      patch.status = resolved.status
    }
    if (isTasks && data.priority !== undefined) patch.priority = data.priority
    if (isTasks && data.dueDate !== undefined)
      patch.dueDate = data.dueDate === null ? null : new Date(data.dueDate)
    // Sub-item parent (RPL v1.0.0). null detaches to top-level. A real
    // parent is validated (same-list, no self/cycle, within depth). On a
    // cross-list move the source-list parent is meaningless — the move
    // branch below forces parentId to null, so skip the client value here.
    if (data.parentId !== undefined && !isMove) {
      if (data.parentId === null) {
        patch.parentId = null
      } else {
        await assertValidParent(c, list.id, item.id, data.parentId)
        patch.parentId = data.parentId
      }
    }
    // A position is honoured only when staying put; a move always
    // re-appends at the target's end (the repo computes max+1).
    if (data.position !== undefined && !isMove) patch.position = data.position

    // Custom-field values: a same-list PATCH merges onto the item's
    // existing values (a `null` value clears that key), then validates the
    // FINAL intended state against the list's active defs so `required` is
    // enforced on the result, not the partial patch. Existing values for
    // now-deleted defs are dropped before merging (they can't be
    // re-validated and would orphan). A cross-list move skips this — the
    // move branch below clears custom_fields wholesale (defs are per-list).
    // An empty `{}` patch can't change anything (and the stored state was
    // already validated when set), so skip it to avoid a no-op write.
    // Shopping lists: `rp:category` is a system-reserved key — separate it
    // from user-defined custom fields before validateCustomFields (which
    // rejects unknown keys) and re-merge after (parity with sdk-writes).
    if (data.customFields !== undefined && !isMove && Object.keys(data.customFields).length > 0) {
      const defs = await c.var.repos.fieldDefs.listForList(list.id)
      const activeIds = new Set(defs.map((d) => d.id))

      const categoryPatch = data.customFields[CATEGORY_KEY]
      const userFields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data.customFields)) {
        if (k !== CATEGORY_KEY) userFields[k] = v
      }

      const intended: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(item.customFields)) {
        if (activeIds.has(k)) intended[k] = v
      }
      for (const [k, v] of Object.entries(userFields)) {
        if (v === null) delete intended[k]
        else intended[k] = v
      }

      // Note: if a required field def is later added to the list AFTER item
      // creation, a rp:category-only PATCH (empty userFields + empty intended)
      // skips validateCustomFields and doesn't re-enforce the required field.
      // Acceptable for v1 shopping lists (no field defs expected).
      if (Object.keys(userFields).length > 0 || Object.keys(intended).length > 0) {
        const cf = validateCustomFields(defs, intended)
        if (!cf.ok) throw errors.validation({ issues: cf.issues })
        patch.customFields = { ...cf.values }
      } else {
        patch.customFields = {}
      }

      if (list.listType === 'shopping') {
        const existingCategory = item.customFields[CATEGORY_KEY]
        if (isCategory(existingCategory)) {
          patch.customFields[CATEGORY_KEY] = existingCategory
        }
        if (isCategory(categoryPatch)) {
          patch.customFields[CATEGORY_KEY] = categoryPatch
        } else if (categoryPatch === null) {
          patch.customFields[CATEGORY_KEY] = categorize(
            (patch.title !== undefined ? patch.title : item.title),
          )
        }
      }
    }

    // Cross-list move: validate the target list, then port ownership-on-
    // move (move to a private list reassigns created_by to its owner).
    if (isMove) {
      const target = await loadListMutable(c, data.listId!)
      patch.listId = target.id
      const newOwner = ownerTransferForMove({
        visibility: target.visibility,
        createdBy: target.createdBy,
      })
      if (newOwner !== null) patch.createdBy = newOwner
      // Task columns are task-only: moving into a non-task list clears
      // them so the "other types leave them NULL" invariant holds.
      if (target.listType !== 'tasks') {
        patch.status = null
        patch.statusId = null
        patch.priority = null
        patch.dueDate = null
      }
      // Field defs are per-list, so the moved item's values would
      // reference defs absent in the target — clear them (same precedent
      // as the task-column clearing above).
      patch.customFields = {}
      // The item's old parent lives in the source list; it joins the
      // target as a top-level item. Its own children stay in the source
      // list and are orphaned below (after the update commits).
      patch.parentId = null
    }

    // Labels (RPL v1.0.0 slice 12): validate before writing the item so an
    // invalid label doesn't partially succeed. On a cross-list move, drop
    // the labels (they reference defs from the source list).
    const labelIds = isMove ? undefined : data.labelIds
    if (labelIds !== undefined && labelIds.length > 0) {
      await validateLabelIds(c, list.id, labelIds)
    }

    // Nothing survived mapping (e.g. a self-move, or task-only fields sent
    // to a non-task list): handle label-only updates and return. A label
    // change is still a real change, so publish so viewers live-update.
    if (Object.keys(patch).length === 0) {
      if (labelIds !== undefined) {
        await c.var.repos.listLabels.setItemLabels(item.id, labelIds)
        publish(
          c,
          listChannel(list.id),
          envelope('list_items', 'update', item.id, c.var.session!.userId),
        )
      }
      const currentLabels = await c.var.repos.listLabels.labelsForItems([item.id])
      return c.json(serializeItem(item, currentLabels.get(item.id) ?? []))
    }

    const updated = await c.var.repos.listItems.update(c.req.param('itemId'), patch)
    if (!updated) throw errors.itemNotFound()
    const userId = c.var.session!.userId
    // A moved item's children stay behind in the source list pointing at a
    // now-cross-list parent — orphan them to top-level so no item dangles.
    if (isMove) {
      await c.var.repos.listItems.clearChildParent(list.id, updated.id)
    }
    // Apply label set AFTER item update so the item row exists and the
    // join write is consistent.
    if (labelIds !== undefined) {
      await c.var.repos.listLabels.setItemLabels(updated.id, labelIds)
    }
    // On a cross-list move, clear any labels (they belonged to the source list).
    if (isMove) {
      await c.var.repos.listLabels.setItemLabels(updated.id, [])
    }
    const itemLabelMap = await c.var.repos.listLabels.labelsForItems([updated.id])
    publish(c, listChannel(list.id), envelope('list_items', 'update', updated.id, userId))
    // A move leaves the source list and joins the target; the target's
    // viewers need the new item, the source's need it gone.
    if (isMove) {
      publish(c, listChannel(patch.listId!), envelope('list_items', 'update', updated.id, userId))
    }
    return c.json(serializeItem(updated, itemLabelMap.get(updated.id) ?? []))
  })

  // --- soft-delete -------------------------------------------------
  .delete('/api/v1/ui/lists/:listId/items/:itemId', async (c) => {
    const list = await loadListMutable(c, c.req.param('listId'))
    const item = await loadItem(c, list.id, c.req.param('itemId'))
    // Orphan any children to top-level FIRST so a soft-deleted parent
    // never leaves a child pointing at it (RPL v1.0.0). Children survive
    // the parent's deletion; only the link is cleared.
    await c.var.repos.listItems.clearChildParent(list.id, item.id)
    await c.var.repos.listItems.softDelete(item.id, new Date())
    publish(c, listChannel(list.id), envelope('list_items', 'delete', item.id, c.var.session!.userId))
    return c.body(null, 204)
  })

  // --- restore (within the 30-day grace window) --------------------
  .post('/api/v1/ui/lists/:listId/items/:itemId/restore', async (c) => {
    const list = await loadListMutable(c, c.req.param('listId'))
    const item = await loadItem(c, list.id, c.req.param('itemId'), true)
    if (!item.deletedAt) {
      throw errors.conflict('item_not_deleted', 'Item is not deleted.')
    }
    if (Date.now() - item.deletedAt.getTime() > RESTORE_GRACE_MS) {
      throw errors.conflict('item_purge_window_elapsed', 'Restore window has elapsed.')
    }
    await c.var.repos.listItems.restore(item.id)
    const fresh = await c.var.repos.listItems.findById(item.id)
    const restoredItem = fresh ?? item
    const restoreLabelMap = await c.var.repos.listLabels.labelsForItems([restoredItem.id])
    publish(c, listChannel(list.id), envelope('list_items', 'create', item.id, c.var.session!.userId))
    return c.json(serializeItem(restoredItem, restoreLabelMap.get(restoredItem.id) ?? []))
  })
