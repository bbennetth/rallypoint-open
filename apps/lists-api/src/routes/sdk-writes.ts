import { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateGroupSchema,
  CreateListSchema,
  CreateListItemSchema,
  CreateFieldDefSchema,
  UpdateFieldDefSchema,
  UpdateListItemSchema,
  buildCreateOptions,
  mergeUpdateOptions,
  isSelectFieldType,
  uniqueFieldKey,
  validateCustomFields,
  categorize,
  isCategory,
  CATEGORY_KEY,
  SYSTEM_MANAGED_LIST_TYPES,
} from '@rallypoint/lists-shared'
import type { Context } from 'hono'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { GroupRecord, ListRecord, UpdateFieldDefInput, UpdateListItemInput } from '../repos/types.js'
import { readJsonBody } from './_body.js'
import { serializeListDto, serializeListItemDto, serializeFieldDefDto } from './sdk-lists.js'

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
    const parsed = CreateGroupSchema.safeParse(await readJsonBody(c))
    if (!parsed.success) throw errors.validation({ issues: parsed.error.issues })
    const group = await c.var.repos.groups.create({
      id: `lgr_${ulid()}`,
      tenantId: TENANT,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
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
    const list = await c.var.repos.lists.create({
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
    if (SYSTEM_MANAGED_LIST_TYPES.has(list.listType as 'shopping' | 'notes')) {
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
    const persistedFields: Record<string, unknown> = { ...cf.values }
    if (list.listType === 'shopping') {
      if (isCategory(clientCategory)) {
        persistedFields[CATEGORY_KEY] = clientCategory
      } else {
        persistedFields[CATEGORY_KEY] = categorize(body.title)
      }
    }

    const item = await c.var.repos.listItems.create({
      id: `lit_${ulid()}`,
      tenantId: TENANT,
      listId: list.id,
      title: body.title,
      notes: body.notes ?? null,
      assignedTo: body.assignedTo ?? null,
      status: isTasks ? (body.status ?? 'todo') : null,
      priority: isTasks ? body.priority : null,
      dueDate: isTasks && body.dueDate != null ? new Date(body.dueDate) : null,
      customFields: persistedFields,
      position: body.position,
      createdBy: actor,
    })
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
    const patch: UpdateListItemInput = {}
    if (data.title !== undefined) patch.title = data.title
    if (data.notes !== undefined) patch.notes = data.notes
    if (data.assignedTo !== undefined) patch.assignedTo = data.assignedTo
    if (data.completed !== undefined) patch.completed = data.completed
    if (isTasks && data.status !== undefined) patch.status = data.status
    if (isTasks && data.priority !== undefined) patch.priority = data.priority
    if (isTasks && data.dueDate !== undefined)
      patch.dueDate = data.dueDate === null ? null : new Date(data.dueDate)
    if (data.position !== undefined) patch.position = data.position

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

    if (Object.keys(patch).length === 0) return c.json(serializeListItemDto(item))
    const updated = await c.var.repos.listItems.update(itemId, patch)
    if (!updated) throw errors.itemNotFound()
    return c.json(serializeListItemDto(updated))
  })
  // --- soft-delete an item -----------------------------------------
  .delete('/api/v1/sdk/lists/:listId/items/:itemId', async (c) => {
    const actor = requireActor(c)
    const list = await loadListForActor(c, actor, c.req.param('listId'))
    const itemId = c.req.param('itemId')
    const item = await c.var.repos.listItems.findById(itemId)
    if (!item || item.listId !== list.id || item.deletedAt) throw errors.itemNotFound()
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
