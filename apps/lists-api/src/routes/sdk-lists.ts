import { Hono } from 'hono'
import { scopeTypeField, scopeIdField } from '@rallypoint/lists-shared'
import type { HonoApp } from '../context.js'
import { errors } from '../errors.js'
import type { FieldDefRecord, ListItemCommentRecord, ListItemRecord, ListLabelRecord, ListRecord, ListStatusRecord } from '../repos/types.js'
import { ensureStatuses } from './_statuses.js'

// The /api/v1/sdk/lists surface peer apps (events-api) call server-to-server.
// Gated by requireSdkKey in build-app — cookieless, key-authenticated. The
// caller asserts authorization for the requested scope (e.g. events-api checks
// group membership before proxying), since a group scope_id is opaque here.
//
// Shape matches the already-published @rallypoint/lists-client: a flat
// camelCase ListDto[] (NOT the UI surface's snake_case {items} envelope).

const TENANT = 'rallypoint'

export function serializeListDto(l: ListRecord): Record<string, unknown> {
  return {
    id: l.id,
    scopeType: l.scopeType,
    scopeId: l.scopeId,
    listType: l.listType,
    name: l.name,
    visibility: l.visibility,
    color: l.color,
    createdBy: l.createdBy,
    incompleteCount: l.incompleteCount,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  }
}

// camelCase mirror of the UI surface's snake_case serializeItem
// (routes/list-items.ts). Live items only — soft-deleted rows are not
// surfaced to peer apps. due_date/status/priority are what My Day needs;
// customFields carries the v2 typed values (keyed by field-def id),
// interpreted against the defs from the /fields endpoint below.
export function serializeListItemDto(i: ListItemRecord): Record<string, unknown> {
  return {
    id: i.id,
    listId: i.listId,
    title: i.title,
    notes: i.notes,
    assignedTo: i.assignedTo,
    completed: i.completed,
    completedAt: i.completedAt ? i.completedAt.toISOString() : null,
    status: i.status,
    statusId: i.statusId,
    parentId: i.parentId,
    priority: i.priority,
    dueDate: i.dueDate ? i.dueDate.toISOString() : null,
    position: i.position,
    customFields: i.customFields,
    seriesId: i.seriesId,
    createdBy: i.createdBy,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  }
}

// camelCase mirror of the UI surface's snake_case serializeFieldDef
// (routes/field-defs.ts). A peer app needs the defs to interpret an item's
// customFields (option-id → label, type → render). Live defs only.
export function serializeFieldDefDto(d: FieldDefRecord): Record<string, unknown> {
  return {
    id: d.id,
    listId: d.listId,
    key: d.key,
    label: d.label,
    fieldType: d.fieldType,
    options: d.options,
    required: d.required,
    defaultValue: d.defaultValue,
    position: d.position,
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }
}

// camelCase mirror of the UI surface's snake_case serializeStatus
// (routes/statuses.ts). A peer app / the MCP server needs the status set
// to interpret an item's statusId (id → name/category/color).
export function serializeListStatusDto(s: ListStatusRecord): Record<string, unknown> {
  return {
    id: s.id,
    listId: s.listId,
    name: s.name,
    color: s.color,
    category: s.category,
    position: s.position,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

// camelCase wire shape for a label (mirrors the UI surface's snake_case
// serializeLabel in routes/labels.ts). No deletedAt surfaced.
export function serializeLabelDto(l: ListLabelRecord): Record<string, unknown> {
  return {
    id: l.id,
    listId: l.listId,
    name: l.name,
    color: l.color,
    position: l.position,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  }
}

// camelCase wire shape for a comment (mirrors the UI surface's snake_case
// serializeComment in routes/comments.ts). No deletedAt surfaced.
export function serializeCommentDto(c: ListItemCommentRecord): Record<string, unknown> {
  return {
    id: c.id,
    itemId: c.itemId,
    authorId: c.authorId,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

export const sdkListsRoutes = new Hono<HonoApp>()
  // --- list (by scope) ---------------------------------------------
  .get('/api/v1/sdk/lists', async (c) => {
    const scopeType = scopeTypeField.safeParse(c.req.query('scope_type'))
    const scopeId = scopeIdField.safeParse(c.req.query('scope_id'))
    if (!scopeType.success || !scopeId.success) {
      throw errors.validation({
        issues: [
          ...(scopeType.success ? [] : scopeType.error.issues),
          ...(scopeId.success ? [] : scopeId.error.issues),
        ],
      })
    }
    const rows = await c.var.repos.lists.listForScope({
      tenantId: TENANT,
      scopeType: scopeType.data,
      scopeId: scopeId.data,
    })
    // #128 defense-in-depth: list_shares is a Lists-app concept the
    // caller (events-api) can't resolve, so a private list under a
    // peer-app scope is unreachable through any path the peer
    // exposes. Filter them out so a misconfigured caller can't leak
    // them via the SDK either. UI writes already gate scope_type to
    // 'list_group', so this is belt-and-suspenders.
    const visible = rows.filter((l) => l.visibility !== 'private')
    return c.json(visible.map(serializeListDto))
  })
  // --- items (by list) ---------------------------------------------
  // The caller (events-api) has already confirmed the list belongs to a
  // scope it is authorized for; lists-api only verifies the list is live.
  // Private lists are not surfaced to peer apps (see /sdk/lists above)
  // and similarly aren't reachable as items here.
  .get('/api/v1/sdk/lists/:listId/items', async (c) => {
    const list = await c.var.repos.lists.findById(c.req.param('listId'))
    if (!list || list.deletedAt) throw errors.listNotFound()
    if (list.visibility === 'private') throw errors.listNotFound()
    const rows = await c.var.repos.listItems.listForList(list.id)
    return c.json(rows.map(serializeListItemDto))
  })
  // --- field defs (by list) ----------------------------------------
  // The schema for a list's custom-field values, needed to interpret an
  // item's customFields. Same live-only / non-private gating as items.
  .get('/api/v1/sdk/lists/:listId/fields', async (c) => {
    const list = await c.var.repos.lists.findById(c.req.param('listId'))
    if (!list || list.deletedAt) throw errors.listNotFound()
    if (list.visibility === 'private') throw errors.listNotFound()
    const rows = await c.var.repos.fieldDefs.listForList(list.id)
    return c.json(rows.map(serializeFieldDefDto))
  })
  // --- statuses (by list) ------------------------------------------
  // The per-list custom-status set, needed to interpret an item's
  // statusId. PLANNER_API_KEY-gated (not in the events read-set). Lazily
  // seeds the defaults using the list owner as the seeding actor.
  .get('/api/v1/sdk/lists/:listId/statuses', async (c) => {
    const list = await c.var.repos.lists.findById(c.req.param('listId'))
    if (!list || list.deletedAt) throw errors.listNotFound()
    if (list.visibility === 'private') throw errors.listNotFound()
    const rows = await ensureStatuses(c, list.id, list.createdBy)
    return c.json(rows.map(serializeListStatusDto))
  })
  // --- comments (by item) ------------------------------------------
  // Live comments for a specific item, oldest-first. PLANNER_API_KEY-
  // gated. The caller has already confirmed the item belongs to a list
  // it is authorized for; lists-api verifies the list and item are live.
  .get('/api/v1/sdk/lists/:listId/items/:itemId/comments', async (c) => {
    const list = await c.var.repos.lists.findById(c.req.param('listId'))
    if (!list || list.deletedAt) throw errors.listNotFound()
    if (list.visibility === 'private') throw errors.listNotFound()
    const item = await c.var.repos.listItems.findById(c.req.param('itemId'))
    if (!item || item.listId !== list.id || item.deletedAt) throw errors.itemNotFound()
    const rows = await c.var.repos.listItemComments.listForItem(item.id)
    return c.json(rows.map(serializeCommentDto))
  })
  // --- labels (by list) --------------------------------------------
  // The per-list label set, needed to interpret an item's label_ids.
  // PLANNER_API_KEY-gated. Same live-only / non-private gating as
  // statuses.
  .get('/api/v1/sdk/lists/:listId/labels', async (c) => {
    const list = await c.var.repos.lists.findById(c.req.param('listId'))
    if (!list || list.deletedAt) throw errors.listNotFound()
    if (list.visibility === 'private') throw errors.listNotFound()
    const rows = await c.var.repos.listLabels.listForList(list.id)
    return c.json(rows.map(serializeLabelDto))
  })
