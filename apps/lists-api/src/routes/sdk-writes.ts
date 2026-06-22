import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  SdkCreateGroupSchema,
  CreateListSchema,
  CreateListItemSchema,
  CreateFieldDefSchema,
  UpdateFieldDefSchema,
  UpdateListItemSchema,
  MoveListItemSchema,
  CreateCommentSchema,
  buildCreateOptions,
  mergeUpdateOptions,
  isSelectFieldType,
  uniqueFieldKey,
  validateCustomFields,
  categorize,
  isCategory,
  CATEGORY_KEY,
  SYSTEM_MANAGED_LIST_TYPES,
  type SystemManagedListType,
} from '@rallypoint/lists-shared'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { GroupRecord, ListRecord, UpdateFieldDefInput, UpdateListItemInput } from '../repos/types.js'
import { UniqueConstraintError } from '../repos/errors.js'
import { readJsonBody } from './_body.js'
import { serializeListDto, serializeListItemDto, serializeFieldDefDto, serializeCommentDto } from './sdk-lists.js'
import { ensureStatuses, resolveStatus } from './_statuses.js'
import { assertValidParent } from './_hierarchy.js'
import { cleanCustomFieldsForTarget, resolveStatusIdForTarget } from './_move.js'

// Authenticated SDK WRITE surface peer apps (planner-api) call
// server-to-server to manage a user's personal task lists. Mounted under
// /api/v1/sdk/* (same requireSdkKey gate as the read surface). The acting
// user is a `user_<ulid>` asserted in the `x-actor` header — the calling
// peer app has already authenticated them via its own session. Unlike the
// read surface (sdk-lists.ts), Lists-owned `list_group` scopes are
// membership-checked HERE against the asserted actor, because lists-api
// owns that scope. Opaque non-Lists scopes (Events `group`) are trusted to
// the caller, matching the read surface's posture.

const TENANT = 'rallypoint'
const LISTS_OWNED_SCOPES = new Set(['list_group'])

function mintOptionId(): string {
  return `opt_${ulid()}`
}

// Expected format for an actor id: `user_` prefix + 26-character Crockford
// ULID alphabet (uppercase digits 0–9 and letters A–Z minus I, L, O, U).
// The regex is case-insensitive: callers in the wild occasionally send
// lowercase ULIDs, so we accept either case and normalise in the return value
// (actor.trim()) — downstream code compares with stored values which are
// uppercase, so this only matters if callers send lowercase; either way the
// regex will match and the stored createdBy value uses whatever case was sent.
const ACTOR_RE = /^user_[0-9A-HJKMNP-TV-Z]{26}$/i

// Read the x-actor header; 400 if absent or not in `user_<ulid>` format.
export function requireActor(c: Context<HonoApp>): string {
  const raw = c.req.header('x-actor')
  if (!raw || raw.trim().length === 0) {
    throw errors.validation({ issues: [{ path: ['x-actor'], message: 'x-actor header is required.' }] })
  }
  const actor = raw.trim()
  if (!ACTOR_RE.test(actor)) {
    throw errors.validation({ issues: [{ path: ['x-actor'], message: 'x-actor must be a valid user id (user_<ulid>).' }] })
  }
  return actor
}

// camelCase group wire shape (mirrors the read-surface DTOs). No
// tenantId/deletedAt surfaced.
function serializeGroupDto(g: GroupRecord): Record<string, unknown> {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    origin: g.origin,
    createdBy: g.createdBy,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }
}

// Assert the actor may act within a scope. For a Lists-owned `list_group`
// scope, require a live group + a membership row for the actor (404
// otherwise, never leaking existence). `list_group_members` has no
// soft-delete column today, so any row counts as membership; if a member-
// removal flow lands, findMembership must learn to exclude removed rows.
// For an opaque non-Lists scope, trust the calling peer app — it
// authorized the actor on its side (parity with the read surface, which
// can't resolve a group_id either).
async function assertActorInScope(
  c: Context<HonoApp>,
  actor: string,
  scopeType: string,
  scopeId: string,
): Promise<void> {
  if (!LISTS_OWNED_SCOPES.has(scopeType)) return
  const group = await c.var.repos.groups.findById(scopeId)
  if (!group || group.deletedAt) throw errors.listNotFound()
  const membership = await c.var.repos.groups.findMembership(scopeId, actor)
  if (!membership) throw errors.listNotFound()
}

// Load a live list and assert the actor may access its scope. Any member
// may mutate a list's items (matches the UI surface, where any reader can
// edit items — the creator-guard is reserved for structural changes).
export async function loadListForActor(
  c: Context<HonoApp>,
  actor: string,
  listId: string,
): Promise<ListRecord> {
  const list = await c.var.repos.lists.findById(listId)
  if (!list || list.deletedAt) throw errors.listNotFound()
  await assertActorInScope(c, actor, list.scopeType, list.scopeId)
  return list
}

export const sdkWritesRoutes = new Hono<HonoApp>()
  // --- list the actor's groups -------------------------------------
  // Backs Planner's personal-scope resolution: find the user's personal
  // list_group (or learn there is none yet, then create one).
  .get('/api/v1/sdk/groups', async (c) => {
    const actor = requireActor(c)
    const rows = await c.var.repos.groups.listForUser(actor)
    return c.json(rows.map(serializeGroupDto))
  })
  // --- create a group (actor auto-enrolled owner) ------------------
  .post('/api/v1/sdk/groups', async (c) => {
    const actor = requireActor(c)
    const parsed = SdkCreateGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const group = await c.var.repos.groups.create({
      id: `lgr_${ulid()}`,
      tenantId: TENANT,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      origin: parsed.data.origin ?? null,
      createdBy: actor,
      ownerMemberId: `lgm_${ulid()}`,
    })
    return c.json(serializeGroupDto(group), 201)
  })
  // --- create a list in a scope ------------------------------------
  .post('/api/v1/sdk/lists', async (c) => {
    const actor = requireActor(c)
    const parsed = CreateListSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    await assertActorInScope(c, actor, body.scopeType, body.scopeId)
    let list: ListRecord
    try {
      list = await c.var.repos.lists.create({
        id: `lst_${ulid()}`,
        tenantId: TENANT,
        scopeType: body.scopeType,
        scopeId: body.scopeId,
        listType: body.listType,
        name: body.name,
        visibility: body.visibility,
        color: body.color ?? null,
        createdBy: actor,
      })
    } catch (err) {
      // The lists_notes_folder_name_uq partial unique index (notes folders,
      // #559) is the DB backstop for the name race: two concurrent same-name
      // notes-folder creates both pass the Planner BFF pre-check, and the
      // loser hits the index here. Map it to a 409 the BFF turns into
      // folder_name_taken. Only notes lists carry this constraint, so other
      // list types never reach this branch.
      if (err instanceof UniqueConstraintError) {
        throw errors.conflict('list_name_conflict', 'A list with that name already exists in this scope.')
      }
      throw err
    }
    return c.json(serializeListDto(list), 201)
  })
  // --- soft-delete a list ------------------------------------------
  // Membership guard: any scope member may delete (parity with item/
  // series deletes — the calling app owns finer ownership policy).
  // System-managed list types (shopping, notes) are undeletable from
  // every surface — same invariant as the UI route.
  .delete('/api/v1/sdk/lists/:listId', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    if (SYSTEM_MANAGED_LIST_TYPES.has(list.listType as SystemManagedListType)) {
      throw errors.conflict(
        'system_managed_list',
        'System-managed lists cannot be deleted.',
      )
    }
    await c.var.repos.lists.softDelete(list.id, new Date())
    return new Response(null, { status: 204 })
  })
  // --- create an item in a list ------------------------------------
  .post('/api/v1/sdk/lists/:listId/items', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const parsed = CreateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data

    // Task lists default status→'todo', priority→'medium'; other types
    // leave the task-only columns null (parity with the UI create route).
    // body.priority is already resolved by the schema: omitted → 'medium',
    // explicit null → null (no-priority). Do NOT re-coerce with ?? 'medium'
    // here — that would turn an intentional null back into 'medium'.
    const isTasks = list.listType === 'tasks'

    // `chores` is tasks-shaped for the priority + due-date columns (recurring
    // chore occurrences must carry a dueDate so they land on a calendar day),
    // but it does NOT get the kanban status pipeline — only `tasks` resolves a
    // statusId. So the priority/dueDate persistence keys off this wider flag
    // while status resolution stays gated on isTasks. (#546)
    const hasTaskScheduling = isTasks || list.listType === 'chores'
    // `diary` entries carry a dueDate (the journal day) but NOT priority/status
    // — they're standard-shaped otherwise. So dueDate persistence widens to
    // this flag while priority stays gated on hasTaskScheduling. (Diary tab)
    const carriesDueDate = hasTaskScheduling || list.listType === 'diary'

    // Strip the reserved `rp:category` key BEFORE validateCustomFields —
    // it is not a field-def id so the validator would reject it. It is
    // handled separately below (shopping auto-categorization).
    const rawCf = body.customFields ?? {}
    const clientCategory = rawCf[CATEGORY_KEY]
    const userFields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rawCf)) {
      if (k !== CATEGORY_KEY) userFields[k] = v
    }

    const defs = await c.var.repos.fieldDefs.listForList(list.id)
    const cf = validateCustomFields(defs, userFields)
    if (!cf.ok) throw errors.validation({ issues: cf.issues })

    // Shopping lists: auto-assign a category when the client didn't supply
    // one. The category is stored under the reserved system key `rp:category`
    // (never a field-def id) AFTER validateCustomFields, so the unknown-key
    // rejection never fires. An explicit client-supplied category takes
    // precedence (the client passes it the same way, via update PATCH).
    // When autoCategorize is false, skip keyword assignment entirely (the
    // item will have no rp:category until the user manually sets one).
    const persistedFields: Record<string, unknown> = { ...cf.values }
    if (list.listType === 'shopping') {
      if (isCategory(clientCategory)) {
        // Explicit client-supplied category always wins.
        persistedFields[CATEGORY_KEY] = clientCategory
      } else if (body.autoCategorize !== false) {
        // Auto-categorize by title (default behavior; skipped when opt-out).
        persistedFields[CATEGORY_KEY] = categorize(body.title)
      }
      // autoCategorize === false with no explicit category → no rp:category set.
    }

    // Custom statuses (RPL v1.0.0): resolve + dual-write the same way the
    // UI create route does, so SDK-created items carry a status_id and the
    // legacy `status` text stays in lockstep.
    const resolved = isTasks
      ? resolveStatus(await ensureStatuses(c, list.id, list.createdBy), {
          statusId: body.statusId,
          category: body.status,
          fallbackCategory: 'todo',
        })
      : { statusId: null, status: null }

    // Sub-item parent (RPL v1.0.0): validate same-list + depth (parity
    // with the UI create route).
    if (body.parentId !== undefined) {
      await assertValidParent(c, list.id, null, body.parentId)
    }

    // Validate label ids before writing the item (parity with UI create).
    const sdkCreateLabelIds = body.labelIds ?? []
    if (sdkCreateLabelIds.length > 0) {
      const liveLabels = await c.var.repos.listLabels.listForList(list.id)
      const liveIds = new Set(liveLabels.map((l) => l.id))
      const unknown = sdkCreateLabelIds.filter((id) => !liveIds.has(id))
      if (unknown.length > 0) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['labelIds'], message: `Unknown or deleted label ids: ${unknown.join(', ')}` }],
        })
      }
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
      priority: hasTaskScheduling ? body.priority : null,
      dueDate: carriesDueDate && body.dueDate != null ? new Date(body.dueDate) : null,
      customFields: persistedFields,
      position: body.position,
      createdBy: actor,
    })
    if (sdkCreateLabelIds.length > 0) {
      await c.var.repos.listLabels.setItemLabels(item.id, sdkCreateLabelIds)
    }
    return c.json(serializeListItemDto(item), 201)
  })
  // --- update / check-off an item ----------------------------------
  // Cross-list move (a differing `listId` in the body) is NOT supported
  // on the SDK surface — Planner has no move affordance and the transfer
  // semantics (ownership-on-move, per-list field defs) are UI-surface
  // concerns. A move attempt is rejected rather than silently ignored.
  .patch('/api/v1/sdk/lists/:listId/items/:itemId', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const itemId = c.req.param('itemId')
    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== list.id || item.deletedAt) throw errors.itemNotFound()
    const parsed = UpdateListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const data = parsed.data
    if (data.listId !== undefined && data.listId !== list.id) {
      throw errors.validation({
        issues: [{ path: ['listId'], message: 'Cross-list move is not supported on the SDK surface.' }],
      })
    }

    const isTasks = list.listType === 'tasks'
    // chores are tasks-shaped for priority/dueDate (but not kanban status) —
    // see hasTaskScheduling on the create path above. (#546)
    const hasTaskScheduling = isTasks || list.listType === 'chores'
    // diary entries carry a dueDate (the journal day) but no priority/status.
    const carriesDueDate = hasTaskScheduling || list.listType === 'diary'
    const patch: UpdateListItemInput = {}
    if (data.title !== undefined) patch.title = data.title
    if (data.notes !== undefined) patch.notes = data.notes
    if (data.assignedTo !== undefined) patch.assignedTo = data.assignedTo
    if (data.completed !== undefined) patch.completed = data.completed
    // Custom statuses (RPL v1.0.0): resolve a status_id / legacy category
    // change and dual-write both columns (parity with the UI PATCH).
    if (isTasks && (data.statusId !== undefined || data.status !== undefined)) {
      const resolved = resolveStatus(await ensureStatuses(c, list.id, list.createdBy), {
        statusId: data.statusId,
        category: data.status,
      })
      patch.statusId = resolved.statusId
      patch.status = resolved.status
    }
    if (hasTaskScheduling && data.priority !== undefined) patch.priority = data.priority
    if (carriesDueDate && data.dueDate !== undefined)
      patch.dueDate = data.dueDate === null ? null : new Date(data.dueDate)
    if (data.position !== undefined) patch.position = data.position
    // Sub-item parent (RPL v1.0.0). null detaches; a real parent is
    // validated (same-list, no self/cycle, within depth). No cross-list
    // move on the SDK surface, so no orphaning branch is needed here.
    if (data.parentId !== undefined) {
      if (data.parentId === null) {
        patch.parentId = null
      } else {
        await assertValidParent(c, list.id, item.id, data.parentId)
        patch.parentId = data.parentId
      }
    }

    // Custom-field values merge onto the item's existing values (a `null`
    // clears that key), then the FINAL intended state is validated against
    // the list's active defs so `required` holds on the result. Same as the
    // UI PATCH; a no-op empty patch is skipped.
    // Shopping lists: `rp:category` is a system-reserved key — extract it
    // from the patch BEFORE validateCustomFields (which rejects unknown keys)
    // and re-merge it after so override writes persist.
    if (data.customFields !== undefined && Object.keys(data.customFields).length > 0) {
      const defs = await c.var.repos.fieldDefs.listForList(list.id)
      const activeIds = new Set(defs.map((d) => d.id))

      // Separate the system category key from user-defined custom fields.
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

      // Only run validateCustomFields when there are user-defined keys to
      // check (shopping-only patches that only touch rp:category skip it).
      // Note: if a required field def is later added to the list AFTER item
      // creation, a rp:category-only PATCH will not re-enforce the required
      // field. This is acceptable for v1 shopping lists (no field defs), but
      // should be revisited if required defs ever land on shopping lists.
      if (Object.keys(userFields).length > 0 || Object.keys(intended).length > 0) {
        const cf = validateCustomFields(defs, intended)
        if (!cf.ok) throw errors.validation({ issues: cf.issues })
        patch.customFields = { ...cf.values }
      } else {
        patch.customFields = {}
      }

      // Re-carry existing system category, then apply the patch override.
      if (list.listType === 'shopping') {
        const existingCategory = item.customFields[CATEGORY_KEY]
        if (isCategory(existingCategory)) {
          patch.customFields[CATEGORY_KEY] = existingCategory
        }
        if (isCategory(categoryPatch)) {
          patch.customFields[CATEGORY_KEY] = categoryPatch
        } else if (categoryPatch === null) {
          // null clears: fall back to auto-categorize from current title
          patch.customFields[CATEGORY_KEY] = categorize(
            (patch.title !== undefined ? patch.title : item.title),
          )
        }
      }
    }

    // Labels (RPL v1.0.0 slice 12): validate + apply after the patch (parity
    // with the UI PATCH route). SDK item DTO omits label_ids for now.
    const sdkPatchLabelIds = data.labelIds
    if (sdkPatchLabelIds !== undefined && sdkPatchLabelIds.length > 0) {
      const liveLabels = await c.var.repos.listLabels.listForList(list.id)
      const liveIds = new Set(liveLabels.map((l) => l.id))
      const unknown = sdkPatchLabelIds.filter((id) => !liveIds.has(id))
      if (unknown.length > 0) {
        throw errors.validation({
          issues: [{ code: 'custom', path: ['labelIds'], message: `Unknown or deleted label ids: ${unknown.join(', ')}` }],
        })
      }
    }

    if (Object.keys(patch).length === 0) {
      if (sdkPatchLabelIds !== undefined) {
        await c.var.repos.listLabels.setItemLabels(item.id, sdkPatchLabelIds)
      }
      return c.json(serializeListItemDto(item))
    }
    const updated = await c.var.repos.listItems.update(itemId, patch)
    if (!updated) throw errors.itemNotFound()
    if (sdkPatchLabelIds !== undefined) {
      await c.var.repos.listLabels.setItemLabels(updated.id, sdkPatchLabelIds)
    }
    return c.json(serializeListItemDto(updated))
  })
  // --- move an item to another list --------------------------------
  // The explicit cross-list move surface (the item PATCH route above keeps
  // rejecting a differing listId — move is the deliberate, validated path).
  // Backs Planner notes-folders (#549) but is generic: any peer app can move
  // an item between two lists the actor can access.
  //
  // Validation order (each its own test):
  //  1. actor authorized on the SOURCE list,
  //  2. actor authorized on the TARGET list (also asserts target is live —
  //     loadListForActor 404s a soft-deleted list),
  //  3. target != source,
  //  4. item live and belongs to :listId,
  //  5. series-occurrence items (seriesId != null) rejected 422 — move the
  //     series, not one materialized occurrence,
  //  6. custom-field values whose def-id isn't live in the target are dropped
  //     (rp:category dropped unless the target is a shopping list),
  //  7. statusId cleared unless it's a live status of the target (legacy
  //     `status` text is list-type-agnostic and stays).
  // The repo (buildUpdateSet) re-appends position at the target's max+1 when
  // listId changes and no explicit position is given.
  .post('/api/v1/sdk/lists/:listId/items/:itemId/move', async (c) => {
    const actor = requireActor(c)
    const source = await loadListForActor(c, actor, c.req.param('listId'))
    const parsed = MoveListItemSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const target = await loadListForActor(c, actor, parsed.data.targetListId)
    if (target.id === source.id) {
      throw errors.validation({
        issues: [{ path: ['targetListId'], message: 'Target list must differ from the source list.' }],
      })
    }
    const itemId = c.req.param('itemId')
    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== source.id || item.deletedAt) throw errors.itemNotFound()
    if (item.seriesId !== null) {
      throw errors.unprocessable(
        'series_occurrence_immovable',
        'A recurring-series occurrence cannot be moved on its own — move the series instead.',
      )
    }

    // Clean the custom-field map for the target's live defs (rp:category kept
    // only on a shopping target). Always write the cleaned map so stale keys
    // never survive the move.
    const targetDefs = await c.var.repos.fieldDefs.listForList(target.id)
    const targetDefIds = new Set(targetDefs.map((d) => d.id))
    const customFields = cleanCustomFieldsForTarget(
      item.customFields,
      targetDefIds,
      target.listType === 'shopping',
    )

    // Clear statusId unless it's a live status of the target list.
    const targetStatuses = await c.var.repos.listStatuses.listForList(target.id)
    const targetLiveStatusIds = new Set(
      targetStatuses.filter((s) => s.deletedAt === null).map((s) => s.id),
    )
    const statusId = resolveStatusIdForTarget(item.statusId, targetLiveStatusIds)

    const updated = await c.var.repos.listItems.update(itemId, {
      listId: target.id,
      customFields,
      statusId,
    })
    if (!updated) throw errors.itemNotFound()
    return c.json(serializeListItemDto(updated))
  })
  // --- find an item by id within a scope ---------------------------
  // Locate an item by id among ALL the actor's lists in a scope, without the
  // caller fanning out a per-list items read (the N+1 the Planner notes
  // PATCH/DELETE used to do — #559). Generic: any peer app can resolve an
  // item to its parent list within a scope the actor is authorized for.
  // Returns the live item DTO (which carries its listId) or 404. Mirrors the
  // write surface's actor-scope authz: the actor must be a member of the
  // scope, and the item's parent list must live in that exact scope (else
  // 404, never leaking an item that belongs to another scope).
  .get('/api/v1/sdk/scopes/:scopeType/:scopeId/items/:itemId', async (c) => {
    const actor = requireActor(c)
    const scopeType = c.req.param('scopeType')
    const scopeId = c.req.param('scopeId')
    await assertActorInScope(c, actor, scopeType, scopeId)
    const item = await c.var.repos.listItems.findById(c.req.param('itemId'))
    if (!item || item.deletedAt) throw errors.itemNotFound()
    const list = await c.var.repos.lists.findById(item.listId)
    if (!list || list.deletedAt || list.scopeType !== scopeType || list.scopeId !== scopeId) {
      throw errors.itemNotFound()
    }
    return c.json(serializeListItemDto(item))
  })
  // --- soft-delete an item -----------------------------------------
  .delete('/api/v1/sdk/lists/:listId/items/:itemId', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const itemId = c.req.param('itemId')
    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== list.id || item.deletedAt) throw errors.itemNotFound()
    // Orphan children to top-level before soft-deleting (RPL v1.0.0),
    // parity with the UI delete route.
    await c.var.repos.listItems.clearChildParent(list.id, itemId)
    await c.var.repos.listItems.softDelete(itemId, new Date())
    return new Response(null, { status: 204 })
  })
  // --- define a field (actor must be a member of the list's scope) --
  // Mirrors the UI surface's POST /ui/lists/:listId/fields (field-defs.ts)
  // but gates on x-actor scope membership instead of a session creator
  // check. The per-list-unique key is derived from the label; select/text
  // options are minted server-side. Backs Planner's full field management.
  .post('/api/v1/sdk/lists/:listId/fields', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const parsed = CreateFieldDefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    const existing = await c.var.repos.fieldDefs.listForList(list.id)
    const key = uniqueFieldKey(
      body.label,
      existing.map((d) => d.key),
    )
    const options = buildCreateOptions(
      body.fieldType,
      { choices: body.choices, multiline: body.multiline },
      mintOptionId,
    )
    const def = await c.var.repos.fieldDefs.create({
      id: `lfd_${ulid()}`,
      tenantId: TENANT,
      listId: list.id,
      key,
      label: body.label,
      fieldType: body.fieldType,
      options,
      required: body.required,
      ...(body.position !== undefined ? { position: body.position } : {}),
      createdBy: actor,
    })
    return c.json(serializeFieldDefDto(def), 201)
  })
  // --- update a field ----------------------------------------------
  // fieldType is immutable, so the type-dependent rules the create schema
  // enforces inline are re-checked here against the stored def (parity with
  // the UI PATCH in field-defs.ts).
  .patch('/api/v1/sdk/lists/:listId/fields/:fieldId', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const parsed = UpdateFieldDefSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const body = parsed.data
    const def = await c.var.repos.fieldDefs.findById(c.req.param('fieldId'))
    if (!def || def.deletedAt || def.listId !== list.id) throw errors.fieldDefNotFound()

    const issues: Array<{ code: string; path: string[]; message: string }> = []
    if (body.choices !== undefined && !isSelectFieldType(def.fieldType)) {
      issues.push({ code: 'custom', path: ['choices'], message: 'Only select fields accept choices.' })
    }
    if (body.multiline !== undefined && def.fieldType !== 'text') {
      issues.push({
        code: 'custom',
        path: ['multiline'],
        message: 'Only text fields accept the multiline flag.',
      })
    }
    if (issues.length > 0) throw errors.validation({ issues })

    const patch: UpdateFieldDefInput = {}
    if (body.label !== undefined) patch.label = body.label
    if (body.required !== undefined) patch.required = body.required
    if (body.position !== undefined) patch.position = body.position
    if (body.choices !== undefined || body.multiline !== undefined) {
      patch.options = mergeUpdateOptions(
        def.fieldType,
        def.options,
        { choices: body.choices, multiline: body.multiline },
        mintOptionId,
      )
    }

    const updated = await c.var.repos.fieldDefs.update(def.id, patch)
    if (!updated) throw errors.fieldDefNotFound()
    return c.json(serializeFieldDefDto(updated))
  })
  // --- soft-delete a field -----------------------------------------
  .delete('/api/v1/sdk/lists/:listId/fields/:fieldId', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const def = await c.var.repos.fieldDefs.findById(c.req.param('fieldId'))
    if (!def || def.deletedAt || def.listId !== list.id) throw errors.fieldDefNotFound()
    await c.var.repos.fieldDefs.softDelete(def.id, new Date())
    return new Response(null, { status: 204 })
  })
  // --- create a comment on an item ---------------------------------
  // Author is the x-actor (the calling peer app has already authenticated
  // them). The item must be live and belong to the list.
  .post('/api/v1/sdk/lists/:listId/items/:itemId/comments', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const itemId = c.req.param('itemId')
    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== list.id || item.deletedAt) throw errors.itemNotFound()
    const parsed = CreateCommentSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const comment = await c.var.repos.listItemComments.create({
      id: `lic_${ulid()}`,
      tenantId: TENANT,
      itemId,
      authorId: actor,
      body: parsed.data.body,
    })
    return c.json(serializeCommentDto(comment), 201)
  })
