import { ulid } from 'ulid'
import {
  buildCreateOptions,
  mergeUpdateOptions,
  isSelectFieldType,
  uniqueFieldKey,
  validateCustomFields,
  validateParentAssignment,
  categorize,
  isCategory,
  CATEGORY_KEY,
  SYSTEM_MANAGED_LIST_TYPES,
  DEFAULT_STATUS_SEEDS,
  defaultStatusForCategory,
  type FieldType,
  type ListType,
  type ScopeType,
  type SelectChoiceInput,
  type StatusCategory,
  type SystemManagedListType,
  type TaskStatus,
  type Visibility,
} from '@rallypoint/lists-shared'
import { hashToken } from '@rallypoint/crypto'
import type { Env } from '../env.js'
import type { Logger } from '../logger.js'
import type {
  CreateListItemInput,
  CreateListItemSeriesInput,
  FieldDefRecord,
  GroupRecord,
  ListItemCommentRecord,
  ListItemRecord,
  ListItemSeriesRecord,
  ListLabelRecord,
  ListRecord,
  ListStatusRecord,
  Repos,
  UpdateFieldDefInput,
  UpdateListItemInput,
  UpdateListItemSeriesInput,
} from '../repos/types.js'
import { UniqueConstraintError, buildPage } from '@rallypoint/api-kit'
import { cleanCustomFieldsForTarget, resolveStatusIdForTarget } from '../routes/_move.js'
import { errors } from '../errors.js'
import { isItemRestorable } from '../lib/item-restore.js'
import { itemCursorCodec } from '../lib/item-cursor.js'
import { fieldDefCreateInput, itemCreateInput, planFieldDefs, seriesCreateInput } from './_merge.js'

// Paged-items limit bounds (SDK surface; the RPC clamps rather than 400s
// because it isn't an HTTP edge — a caller that over-asks gets the max page).
export const LIST_ITEMS_PAGE_DEFAULT = 100
export const LIST_ITEMS_PAGE_MAX = 200

// Cross-Worker RPC core for lists-api (feat/rpc-bindings PR 1).
// Mirrors the 25 SDK endpoints under apps/lists-api/src/routes/sdk-*.ts as
// typed *Core fns. The `ListsRPC` WorkerEntrypoint at rpc.ts delegates here.
// In PR 1 the legacy HTTP handlers continue to use their inline logic
// (and the `_statuses.ts` / `_hierarchy.ts` / `_move.ts` helpers); PR 3
// deletes them. Both surfaces remain in sync because they call the same
// shared `_move.ts` helpers, `@rallypoint/lists-shared` rules, and repos.

const TENANT = 'rallypoint'
const LISTS_OWNED_SCOPES = new Set(['list_group'])

export interface ListsRpcDeps {
  env: Env
  logger: Logger
  repos: Repos
}

// --- Discriminated returns -------------------------------------------------

export type Ok<T> = { kind: 'ok'; data: T }
export type ListsNotFound = { kind: 'list_not_found' }
export type ItemNotFound = { kind: 'item_not_found' }
export type ItemNotDeleted = { kind: 'item_not_deleted' }
export type ItemPurgeWindowElapsed = { kind: 'item_purge_window_elapsed' }
export type FieldNotFound = { kind: 'field_not_found' }
export type SeriesNotFound = { kind: 'series_not_found' }
export type SystemManaged = { kind: 'system_managed_list' }
export type NameConflict = { kind: 'list_name_conflict' }
export type ScopeForbidden = { kind: 'list_not_found' } // intentional opaque alias
export type SeriesOccurrenceImmovable = { kind: 'series_occurrence_immovable' }
export type SameSourceTarget = { kind: 'same_source_target' }
export type Unauthorized = { kind: 'unauthorized' }
export type Forbidden = { kind: 'forbidden' }

// --- DTOs (camelCase wire shapes) -----------------------------------------

export interface ListDto {
  id: string
  scopeType: string
  scopeId: string
  listType: string
  name: string
  visibility: string
  color: string | null
  createdBy: string
  incompleteCount: number
  createdAt: string
  updatedAt: string
}
export function serializeListDto(l: ListRecord): ListDto {
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

export interface ListItemDto {
  id: string
  listId: string
  title: string
  notes: string | null
  assignedTo: string | null
  completed: boolean
  completedAt: string | null
  status: string | null
  statusId: string | null
  parentId: string | null
  priority: string | null
  dueDate: string | null
  position: number
  customFields: Record<string, unknown>
  seriesId: string | null
  ref: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}
export function serializeListItemDto(i: ListItemRecord): ListItemDto {
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
    ref: i.ref,
    createdBy: i.createdBy,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  }
}

export interface DeletedListItemDto extends ListItemDto {
  deletedAt: string
}
export function serializeDeletedListItemDto(i: ListItemRecord): DeletedListItemDto {
  if (!i.deletedAt) throw new Error('Deleted item serializer requires deletedAt.')
  return { ...serializeListItemDto(i), deletedAt: i.deletedAt.toISOString() }
}

export interface FieldDefDto {
  id: string
  listId: string
  key: string
  label: string
  fieldType: string
  options: unknown
  required: boolean
  defaultValue: unknown
  position: number
  createdBy: string
  createdAt: string
  updatedAt: string
}
export function serializeFieldDefDto(d: FieldDefRecord): FieldDefDto {
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

export interface ListStatusDto {
  id: string
  listId: string
  name: string
  color: string | null
  category: string
  position: number
  createdBy: string
  createdAt: string
  updatedAt: string
}
export function serializeListStatusDto(s: ListStatusRecord): ListStatusDto {
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

export interface LabelDto {
  id: string
  listId: string
  name: string
  color: string | null
  position: number
  createdAt: string
  updatedAt: string
}
export function serializeLabelDto(l: ListLabelRecord): LabelDto {
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

export interface CommentDto {
  id: string
  itemId: string
  authorId: string
  body: string
  createdAt: string
  updatedAt: string
}
export function serializeCommentDto(c: ListItemCommentRecord): CommentDto {
  return {
    id: c.id,
    itemId: c.itemId,
    authorId: c.authorId,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

export interface GroupDto {
  id: string
  name: string
  description: string | null
  origin: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}
export function serializeGroupDto(g: GroupRecord): GroupDto {
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

export interface SeriesDto {
  id: string
  listId: string
  title: string
  notes: string | null
  assignedTo: string | null
  priority: string | null
  freq: string
  interval: number
  byDay: string[] | null
  dtstart: string
  until: string | null
  count: number | null
  timeOfDay: string | null
  ref: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}
export function serializeSeriesDto(s: ListItemSeriesRecord): SeriesDto {
  return {
    id: s.id,
    listId: s.listId,
    title: s.title,
    notes: s.notes,
    assignedTo: s.assignedTo,
    priority: s.priority,
    freq: s.freq,
    interval: s.interval,
    byDay: s.byDay,
    dtstart: s.dtstart,
    until: s.until,
    count: s.count,
    timeOfDay: s.timeOfDay,
    ref: s.ref,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

// --- Helpers (deps-shaped ports of routes/_*.ts) --------------------------

async function assertActorInScope(
  actor: string,
  scopeType: string,
  scopeId: string,
  deps: ListsRpcDeps,
): Promise<ListsNotFound | null> {
  if (!LISTS_OWNED_SCOPES.has(scopeType)) return null
  const group = await deps.repos.groups.findById(scopeId)
  if (!group || group.deletedAt) return { kind: 'list_not_found' }
  const membership = await deps.repos.groups.findMembership(scopeId, actor)
  if (!membership) return { kind: 'list_not_found' }
  return null
}

// Read-side authz: deps-shaped port of routes/_list-access.ts `canRead`,
// minus the scope-ownership gate — non-owned scopes (events 'group') are
// trusted to the consumer Worker, matching assertActorInScope above.
async function canActorReadList(
  actor: string,
  list: ListRecord,
  deps: ListsRpcDeps,
): Promise<boolean> {
  if (!LISTS_OWNED_SCOPES.has(list.scopeType)) return true
  const group = await deps.repos.groups.findById(list.scopeId)
  if (!group || group.deletedAt) return false
  if (list.visibility === 'private') {
    if (list.createdBy === actor) return true
    return (await deps.repos.listShares.findByListAndUser(list.id, actor)) !== null
  }
  if (list.visibility !== 'all') return false
  return (await deps.repos.groups.findMembership(list.scopeId, actor)) !== null
}

async function loadListForRead(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<{ ok: true; list: ListRecord } | ListsNotFound> {
  const list = await deps.repos.lists.findById(listId)
  if (!list || list.deletedAt) return { kind: 'list_not_found' }
  if (!(await canActorReadList(actor, list, deps))) return { kind: 'list_not_found' }
  return { ok: true, list }
}

// Item-level write authz: read access is the floor (port of routes/
// _list-access.ts `loadListForItemWrite`, minus `assertScopeMutable` —
// planner-api is the legitimate RPC writer for planner-origin scopes).
// Any reader may create/edit items and comments; visibility='private'
// denies fellow members without a share, opaquely (list_not_found).
async function loadListForItemWrite(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<{ ok: true; list: ListRecord } | ListsNotFound> {
  return loadListForRead(actor, listId, deps)
}

// Structural write authz: read floor + creator-only (port of routes/
// _list-access.ts `loadListForWrite`, minus `assertScopeMutable`, see
// above). Non-owned scopes (events 'group') stay trusted to the consumer
// Worker, matching canActorReadList. Not opaque — the actor can already
// read the list, so a distinct 'forbidden' leaks nothing (same reasoning
// as the HTTP 403).
async function loadListForStructuralWrite(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<{ ok: true; list: ListRecord } | ListsNotFound | Forbidden> {
  const r = await loadListForRead(actor, listId, deps)
  if (!('ok' in r)) return r
  if (LISTS_OWNED_SCOPES.has(r.list.scopeType) && r.list.createdBy !== actor) {
    return { kind: 'forbidden' }
  }
  return r
}

function seedIdFor(listId: string, category: string): string {
  return `lst_seed_${listId}_${category}`
}

async function ensureStatuses(
  listId: string,
  actor: string,
  deps: ListsRpcDeps,
): Promise<ListStatusRecord[]> {
  const existing = await deps.repos.listStatuses.listForList(listId)
  if (existing.length > 0) return existing
  return deps.repos.listStatuses.seedDefaults(
    listId,
    TENANT,
    actor,
    DEFAULT_STATUS_SEEDS.map((s) => ({
      id: seedIdFor(listId, s.category),
      name: s.name,
      color: s.color,
      category: s.category,
    })),
  )
}

interface ResolvedStatus {
  statusId: string | null
  status: TaskStatus | null
}

function resolveStatus(
  statuses: ListStatusRecord[],
  opts: {
    statusId?: string | null | undefined
    category?: TaskStatus | null | undefined
    fallbackCategory?: StatusCategory
  },
): ResolvedStatus {
  if (opts.statusId !== undefined) {
    if (opts.statusId === null) return { statusId: null, status: null }
    const found = statuses.find((s) => s.id === opts.statusId && s.deletedAt === null)
    if (!found) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['statusId'], message: 'Unknown status for this list.' }],
      })
    }
    return { statusId: found.id, status: found.category }
  }
  const category =
    opts.category !== undefined && opts.category !== null
      ? opts.category
      : (opts.fallbackCategory ?? null)
  if (category === null) return { statusId: null, status: null }
  const def = defaultStatusForCategory(statuses, category)
  return { statusId: def?.id ?? null, status: category }
}

async function assertValidParent(
  listId: string,
  itemId: string | null,
  parentId: string,
  deps: ListsRpcDeps,
): Promise<void> {
  const NEW_ITEM = '__new__'
  const items = await deps.repos.listItems.listForList(listId)
  const parentOf = new Map(items.map((i) => [i.id, i.parentId]))
  const result = validateParentAssignment(parentOf, itemId ?? NEW_ITEM, parentId)
  if (result === 'ok') return
  const message =
    result === 'self'
      ? 'An item cannot be its own parent.'
      : result === 'missing'
        ? 'Parent item not found in this list.'
        : result === 'cycle'
          ? 'That parent would create a cycle.'
          : 'Sub-item nesting is too deep.'
  throw errors.validation({ issues: [{ code: 'custom', path: ['parentId'], message }] })
}

function mintOptionId(): string {
  return `opt_${ulid()}`
}

// --- READ surface (sdk-lists.ts) ------------------------------------------

export async function listListsCore(
  actor: string,
  scopeType: ScopeType,
  scopeId: string,
  deps: ListsRpcDeps,
): Promise<ListDto[]> {
  const rows = await deps.repos.lists.listForScope({ tenantId: TENANT, scopeType, scopeId })
  const visible: ListRecord[] = []
  for (const list of rows) {
    if (await canActorReadList(actor, list, deps)) visible.push(list)
  }
  return visible.map(serializeListDto)
}

export async function listItemsCore(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<Ok<ListItemDto[]> | ListsNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const rows = await deps.repos.listItems.listForList(r.list.id)
  return { kind: 'ok', data: rows.map(serializeListItemDto) }
}

export interface ListItemsPage {
  items: ListItemDto[]
  nextCursor: string | null
}

// Keyset-paged sibling of listItemsCore, in the default (position, createdAt,
// id) order. `cursor` is the opaque token from a prior page; an undecodable
// value restarts from the beginning (brand-new surface — cursors are always
// lists-minted, so this only trips on tampering). `limit` is clamped, not
// rejected, since this is an RPC surface rather than an HTTP edge.
export async function listItemsPageCore(
  actor: string,
  listId: string,
  page: { limit?: number | undefined; cursor?: string | null | undefined },
  deps: ListsRpcDeps,
): Promise<Ok<ListItemsPage> | ListsNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const limit = Math.min(
    LIST_ITEMS_PAGE_MAX,
    Math.max(1, Math.floor(page.limit ?? LIST_ITEMS_PAGE_DEFAULT)),
  )
  const cursor = page.cursor ? itemCursorCodec.decode(page.cursor) : null
  const rows = await deps.repos.listItems.listPageForList(r.list.id, { limit: limit + 1, cursor })
  const built = buildPage(rows, limit, itemCursorCodec, (i) => ({
    position: i.position,
    createdAt: i.createdAt,
    id: i.id,
  }))
  return {
    kind: 'ok',
    data: { items: built.items.map(serializeListItemDto), nextCursor: built.nextCursor },
  }
}

export async function listDeletedItemsCore(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<Ok<DeletedListItemDto[]> | ListsNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const rows = await deps.repos.listItems.listForList(r.list.id, { includeDeleted: true })
  const restorable = rows
    .filter((item): item is ListItemRecord & { deletedAt: Date } =>
      item.deletedAt !== null && isItemRestorable(item.deletedAt),
    )
    .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
  return { kind: 'ok', data: restorable.map(serializeDeletedListItemDto) }
}

export async function getItemCore(
  actor: string,
  listId: string,
  itemId: string,
  deps: ListsRpcDeps,
): Promise<Ok<ListItemDto> | ListsNotFound | ItemNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const item = await deps.repos.listItems.findById(itemId)
  if (!item || item.listId !== r.list.id || item.deletedAt) return { kind: 'item_not_found' }
  return { kind: 'ok', data: serializeListItemDto(item) }
}

export async function listFieldDefsCore(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<Ok<FieldDefDto[]> | ListsNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const rows = await deps.repos.fieldDefs.listForList(r.list.id)
  return { kind: 'ok', data: rows.map(serializeFieldDefDto) }
}

export async function listStatusesCore(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<Ok<ListStatusDto[]> | ListsNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const rows = await ensureStatuses(r.list.id, r.list.createdBy, deps)
  return { kind: 'ok', data: rows.map(serializeListStatusDto) }
}

export async function listLabelsCore(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<Ok<LabelDto[]> | ListsNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const rows = await deps.repos.listLabels.listForList(r.list.id)
  return { kind: 'ok', data: rows.map(serializeLabelDto) }
}

export async function listCommentsCore(
  actor: string,
  listId: string,
  itemId: string,
  deps: ListsRpcDeps,
): Promise<Ok<CommentDto[]> | ListsNotFound | ItemNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const item = await deps.repos.listItems.findById(itemId)
  if (!item || item.listId !== r.list.id || item.deletedAt) return { kind: 'item_not_found' }
  const rows = await deps.repos.listItemComments.listForItem(item.id)
  return { kind: 'ok', data: rows.map(serializeCommentDto) }
}

// --- WRITE surface (sdk-writes.ts) ---------------------------------------

// No origin filtering here: planner-api resolves its personal scope
// through this same RPC (personal-scope.ts), so hiding origin='planner'
// groups at the core broke Planner's shopping/notes/diary resolution
// outright (post-#682 hotfix). The RPL<->RPP separation — agents/MCP not
// seeing Planner-managed groups (#675) — is enforced at the MCP tool
// layer (apps/lists-mcp/src/mcp/tools.ts), the only surface it applies to.
export async function listGroupsCore(actor: string, deps: ListsRpcDeps): Promise<GroupDto[]> {
  const rows = await deps.repos.groups.listForUser(actor)
  return rows.map(serializeGroupDto)
}

export interface CreateGroupInput {
  name: string
  description?: string | null | undefined
  origin?: string | null | undefined
}
export async function createGroupCore(
  actor: string,
  input: CreateGroupInput,
  deps: ListsRpcDeps,
): Promise<GroupDto> {
  const group = await deps.repos.groups.create({
    id: `lgr_${ulid()}`,
    tenantId: TENANT,
    name: input.name,
    description: input.description ?? null,
    origin: input.origin ?? null,
    createdBy: actor,
    ownerMemberId: `lgm_${ulid()}`,
  })
  return serializeGroupDto(group)
}

export interface CreateListInputCore {
  scopeType: ScopeType
  scopeId: string
  listType: ListType
  name: string
  visibility: Visibility
  color?: string | null | undefined
}
export async function createListCore(
  actor: string,
  input: CreateListInputCore,
  deps: ListsRpcDeps,
): Promise<Ok<ListDto> | ListsNotFound | NameConflict> {
  const denied = await assertActorInScope(actor, input.scopeType, input.scopeId, deps)
  if (denied) return denied
  try {
    const list = await deps.repos.lists.create({
      id: `lst_${ulid()}`,
      tenantId: TENANT,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      listType: input.listType,
      name: input.name,
      visibility: input.visibility,
      color: input.color ?? null,
      createdBy: actor,
    })
    return { kind: 'ok', data: serializeListDto(list) }
  } catch (err) {
    if (err instanceof UniqueConstraintError) return { kind: 'list_name_conflict' }
    throw err
  }
}

export async function deleteListCore(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<Ok<true> | ListsNotFound | Forbidden | SystemManaged> {
  const r = await loadListForStructuralWrite(actor, listId, deps)
  if ('kind' in r) return r
  if (SYSTEM_MANAGED_LIST_TYPES.has(r.list.listType as SystemManagedListType)) {
    // Notes folders are multiple notes-type lists. Preserve the oldest
    // default folder and any folder that still contains live/restorable
    // notes, but allow an empty secondary folder to be removed. This keeps
    // the general system-managed guard intact for Shopping/Chores/Diary
    // and fixes the Planner folder lifecycle after the RPC cutover.
    if (r.list.listType !== 'notes') return { kind: 'system_managed_list' }
    const folders = (await deps.repos.lists.listForScope({
      tenantId: r.list.tenantId,
      scopeType: r.list.scopeType,
      scopeId: r.list.scopeId,
    }))
      .filter((list) => list.listType === 'notes')
      .sort((a, b) =>
        a.createdAt.getTime() !== b.createdAt.getTime()
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.id.localeCompare(b.id),
      )
    if (folders[0]?.id === r.list.id) return { kind: 'system_managed_list' }
    const items = await deps.repos.listItems.listForList(r.list.id, { includeDeleted: true })
    if (
      items.some(
        (item) => item.deletedAt === null || isItemRestorable(item.deletedAt),
      )
    ) {
      return { kind: 'system_managed_list' }
    }
  }
  await deps.repos.lists.softDelete(r.list.id, new Date())
  return { kind: 'ok', data: true }
}

export interface CreateListItemInputCore extends CreateListItemInput {
  statusId?: string | null | undefined
  status?: TaskStatus | null | undefined
  parentId?: string | null | undefined
  labelIds?: string[] | undefined
  autoCategorize?: boolean | undefined
  customFields?: Record<string, unknown> | undefined
}
export async function createListItemCore(
  actor: string,
  listId: string,
  input: CreateListItemInputCore,
  deps: ListsRpcDeps,
): Promise<Ok<ListItemDto> | ListsNotFound> {
  const r = await loadListForItemWrite(actor, listId, deps)
  if ('kind' in r) return r
  const list = r.list

  const ref = input.ref ?? null

  // Idempotent-create on (list_id, ref): a caller retrying a timed-out
  // create (offline outbox replay) supplies the same stable ref and gets
  // the original row back instead of a duplicate. Pre-flight check skips
  // all the validation/side-effect work below when a steady-state
  // cascade replays the same ref. Mirrors money-api's expense ref dedup
  // (apps/money-api/src/routes/expenses.ts) — but deliberately placed
  // EARLIER than money's (which validates first): the access gate
  // (loadListForItemWrite, above) has already run, so nothing is skipped
  // that matters for authorization, and a replay must not fail validation
  // against field defs that changed since the original create succeeded.
  if (ref !== null) {
    const existing = await deps.repos.listItems.findByListAndRef(list.id, ref)
    if (existing) {
      if (existing.deletedAt !== null) {
        throw errors.itemRefTakenByDeleted({
          ref,
          item_id: existing.id,
          deleted_at: existing.deletedAt.toISOString(),
        })
      }
      return { kind: 'ok', data: serializeListItemDto(existing) }
    }
  }

  const isTasks = list.listType === 'tasks'
  const hasTaskScheduling = isTasks || list.listType === 'chores'
  const carriesDueDate = hasTaskScheduling || list.listType === 'diary'

  const rawCf = input.customFields ?? {}
  const clientCategory = rawCf[CATEGORY_KEY]
  const userFields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rawCf)) {
    if (k !== CATEGORY_KEY) userFields[k] = v
  }

  const defs = await deps.repos.fieldDefs.listForList(list.id)
  const cf = validateCustomFields(defs, userFields)
  if (!cf.ok) throw errors.validation({ issues: cf.issues })

  const persistedFields: Record<string, unknown> = { ...cf.values }
  if (list.listType === 'shopping') {
    if (isCategory(clientCategory)) persistedFields[CATEGORY_KEY] = clientCategory
    else if (input.autoCategorize !== false)
      persistedFields[CATEGORY_KEY] = categorize(input.title)
  }

  const resolved = isTasks
    ? resolveStatus(await ensureStatuses(list.id, list.createdBy, deps), {
        statusId: input.statusId,
        category: input.status,
        fallbackCategory: 'todo',
      })
    : { statusId: null, status: null }

  if (input.parentId !== undefined && input.parentId !== null) {
    await assertValidParent(list.id, null, input.parentId, deps)
  }

  const labelIds = input.labelIds ?? []
  if (labelIds.length > 0) {
    const liveLabels = await deps.repos.listLabels.listForList(list.id)
    const liveIds = new Set(liveLabels.map((l) => l.id))
    const unknown = labelIds.filter((id) => !liveIds.has(id))
    if (unknown.length > 0) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['labelIds'], message: `Unknown or deleted label ids: ${unknown.join(', ')}` }],
      })
    }
  }

  let item: ListItemRecord
  try {
    item = await deps.repos.listItems.create({
      id: `lit_${ulid()}`,
      tenantId: TENANT,
      listId: list.id,
      title: input.title,
      notes: input.notes ?? null,
      assignedTo: input.assignedTo ?? null,
      status: resolved.status,
      statusId: resolved.statusId,
      parentId: input.parentId ?? null,
      priority: hasTaskScheduling ? input.priority : null,
      dueDate: carriesDueDate && input.dueDate != null ? new Date(input.dueDate) : null,
      customFields: persistedFields,
      position: input.position,
      ref,
      createdBy: actor,
    })
  } catch (err) {
    // Race: two parallel creates with the same ref both got past the
    // pre-flight; the second hit the partial-unique index. Same
    // fall-back: fetch and return the winner.
    if (err instanceof UniqueConstraintError && ref !== null) {
      const existing = await deps.repos.listItems.findByListAndRef(list.id, ref)
      if (existing) {
        if (existing.deletedAt !== null) {
          throw errors.itemRefTakenByDeleted({
            ref,
            item_id: existing.id,
            deleted_at: existing.deletedAt.toISOString(),
          })
        }
        return { kind: 'ok', data: serializeListItemDto(existing) }
      }
    }
    throw err
  }
  if (labelIds.length > 0) {
    await deps.repos.listLabels.setItemLabels(item.id, labelIds)
  }
  return { kind: 'ok', data: serializeListItemDto(item) }
}

export interface UpdateListItemInputCore {
  title?: string | undefined
  notes?: string | null | undefined
  assignedTo?: string | null | undefined
  completed?: boolean | undefined
  statusId?: string | null | undefined
  status?: TaskStatus | null | undefined
  priority?: 'low' | 'medium' | 'high' | null | undefined
  dueDate?: string | null | undefined
  position?: number | undefined
  parentId?: string | null | undefined
  customFields?: Record<string, unknown> | undefined
  labelIds?: string[] | undefined
  listId?: string | undefined // rejected if different
}
export async function updateListItemCore(
  actor: string,
  listId: string,
  itemId: string,
  data: UpdateListItemInputCore,
  deps: ListsRpcDeps,
): Promise<Ok<ListItemDto> | ListsNotFound | ItemNotFound> {
  const r = await loadListForItemWrite(actor, listId, deps)
  if ('kind' in r) return r
  const list = r.list
  const item = await deps.repos.listItems.findById(itemId)
  if (!item || item.listId !== list.id || item.deletedAt) return { kind: 'item_not_found' }

  if (data.listId !== undefined && data.listId !== list.id) {
    throw errors.validation({
      issues: [{ path: ['listId'], message: 'Cross-list move is not supported on the SDK surface.' }],
    })
  }

  const isTasks = list.listType === 'tasks'
  const hasTaskScheduling = isTasks || list.listType === 'chores'
  const carriesDueDate = hasTaskScheduling || list.listType === 'diary'
  const patch: UpdateListItemInput = {}
  if (data.title !== undefined) patch.title = data.title
  if (data.notes !== undefined) patch.notes = data.notes
  if (data.assignedTo !== undefined) patch.assignedTo = data.assignedTo
  if (data.completed !== undefined) patch.completed = data.completed
  if (isTasks && (data.statusId !== undefined || data.status !== undefined)) {
    const resolved = resolveStatus(await ensureStatuses(list.id, list.createdBy, deps), {
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

  if (data.parentId !== undefined) {
    if (data.parentId === null) patch.parentId = null
    else {
      await assertValidParent(list.id, item.id, data.parentId, deps)
      patch.parentId = data.parentId
    }
  }

  if (data.customFields !== undefined && Object.keys(data.customFields).length > 0) {
    const defs = await deps.repos.fieldDefs.listForList(list.id)
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
    if (Object.keys(userFields).length > 0 || Object.keys(intended).length > 0) {
      const cf = validateCustomFields(defs, intended)
      if (!cf.ok) throw errors.validation({ issues: cf.issues })
      patch.customFields = { ...cf.values }
    } else {
      patch.customFields = {}
    }
    if (list.listType === 'shopping') {
      const existingCategory = item.customFields[CATEGORY_KEY]
      if (isCategory(existingCategory)) patch.customFields[CATEGORY_KEY] = existingCategory
      if (isCategory(categoryPatch)) patch.customFields[CATEGORY_KEY] = categoryPatch
      else if (categoryPatch === null) {
        patch.customFields[CATEGORY_KEY] = categorize(
          patch.title !== undefined ? patch.title : item.title,
        )
      }
    }
  }

  const labelIds = data.labelIds
  if (labelIds !== undefined && labelIds.length > 0) {
    const liveLabels = await deps.repos.listLabels.listForList(list.id)
    const liveIds = new Set(liveLabels.map((l) => l.id))
    const unknown = labelIds.filter((id) => !liveIds.has(id))
    if (unknown.length > 0) {
      throw errors.validation({
        issues: [{ code: 'custom', path: ['labelIds'], message: `Unknown or deleted label ids: ${unknown.join(', ')}` }],
      })
    }
  }

  if (Object.keys(patch).length === 0) {
    if (labelIds !== undefined) await deps.repos.listLabels.setItemLabels(item.id, labelIds)
    return { kind: 'ok', data: serializeListItemDto(item) }
  }
  const updated = await deps.repos.listItems.update(itemId, patch)
  if (!updated) return { kind: 'item_not_found' }
  if (labelIds !== undefined) await deps.repos.listLabels.setItemLabels(updated.id, labelIds)
  return { kind: 'ok', data: serializeListItemDto(updated) }
}

export async function deleteListItemCore(
  actor: string,
  listId: string,
  itemId: string,
  deps: ListsRpcDeps,
): Promise<Ok<true> | ListsNotFound | ItemNotFound> {
  const r = await loadListForItemWrite(actor, listId, deps)
  if ('kind' in r) return r
  const list = r.list
  const item = await deps.repos.listItems.findById(itemId)
  if (!item || item.listId !== list.id || item.deletedAt) return { kind: 'item_not_found' }
  await deps.repos.listItems.clearChildParent(list.id, itemId)
  await deps.repos.listItems.softDelete(itemId, new Date())
  return { kind: 'ok', data: true }
}

export async function restoreListItemCore(
  actor: string,
  listId: string,
  itemId: string,
  deps: ListsRpcDeps,
): Promise<Ok<ListItemDto> | ListsNotFound | ItemNotFound | ItemNotDeleted | ItemPurgeWindowElapsed> {
  const r = await loadListForItemWrite(actor, listId, deps)
  if ('kind' in r) return r
  const item = await deps.repos.listItems.findById(itemId)
  if (!item || item.listId !== r.list.id) return { kind: 'item_not_found' }
  if (!item.deletedAt) return { kind: 'item_not_deleted' }
  if (!isItemRestorable(item.deletedAt)) return { kind: 'item_purge_window_elapsed' }
  await deps.repos.listItems.restore(item.id)
  const restored = await deps.repos.listItems.findById(item.id)
  return { kind: 'ok', data: serializeListItemDto(restored ?? { ...item, deletedAt: null }) }
}

export async function moveListItemCore(
  actor: string,
  listId: string,
  itemId: string,
  targetListId: string,
  deps: ListsRpcDeps,
): Promise<Ok<ListItemDto> | ListsNotFound | ItemNotFound | SameSourceTarget | SeriesOccurrenceImmovable> {
  const s = await loadListForItemWrite(actor, listId, deps)
  if ('kind' in s) return s
  const t = await loadListForItemWrite(actor, targetListId, deps)
  if ('kind' in t) return t
  if (t.list.id === s.list.id) return { kind: 'same_source_target' }

  const item = await deps.repos.listItems.findById(itemId)
  if (!item || item.listId !== s.list.id || item.deletedAt) return { kind: 'item_not_found' }
  if (item.seriesId !== null) return { kind: 'series_occurrence_immovable' }

  const targetDefs = await deps.repos.fieldDefs.listForList(t.list.id)
  const targetDefIds = new Set(targetDefs.map((d) => d.id))
  const customFields = cleanCustomFieldsForTarget(
    item.customFields,
    targetDefIds,
    t.list.listType === 'shopping',
  )
  const targetStatuses = await deps.repos.listStatuses.listForList(t.list.id)
  const targetLiveStatusIds = new Set(
    targetStatuses.filter((s) => s.deletedAt === null).map((s) => s.id),
  )
  const statusId = resolveStatusIdForTarget(item.statusId, targetLiveStatusIds)

  const updated = await deps.repos.listItems.update(itemId, {
    listId: t.list.id,
    customFields,
    statusId,
  })
  if (!updated) return { kind: 'item_not_found' }
  return { kind: 'ok', data: serializeListItemDto(updated) }
}

export async function findItemInScopeCore(
  actor: string,
  scopeType: string,
  scopeId: string,
  itemId: string,
  deps: ListsRpcDeps,
): Promise<Ok<ListItemDto> | ItemNotFound | ListsNotFound> {
  const denied = await assertActorInScope(actor, scopeType, scopeId, deps)
  if (denied) return denied
  const item = await deps.repos.listItems.findById(itemId)
  if (!item || item.deletedAt) return { kind: 'item_not_found' }
  const list = await deps.repos.lists.findById(item.listId)
  if (!list || list.deletedAt || list.scopeType !== scopeType || list.scopeId !== scopeId) {
    return { kind: 'item_not_found' }
  }
  // Scope membership alone isn't enough: a member must not resolve another
  // member's private-list item by id (epic #675 R1). Gate on the same
  // per-list visibility as the other reads; opaque item_not_found.
  if (!(await canActorReadList(actor, list, deps))) return { kind: 'item_not_found' }
  return { kind: 'ok', data: serializeListItemDto(item) }
}

export interface CreateFieldDefInputCore {
  label: string
  fieldType: FieldType
  choices?: SelectChoiceInput[] | undefined
  multiline?: boolean | undefined
  required: boolean
  position?: number | undefined
}
export async function createFieldDefCore(
  actor: string,
  listId: string,
  input: CreateFieldDefInputCore,
  deps: ListsRpcDeps,
): Promise<Ok<FieldDefDto> | ListsNotFound | Forbidden> {
  const r = await loadListForStructuralWrite(actor, listId, deps)
  if ('kind' in r) return r
  const existing = await deps.repos.fieldDefs.listForList(r.list.id)
  const key = uniqueFieldKey(input.label, existing.map((d) => d.key))
  const options = buildCreateOptions(
    input.fieldType,
    {
      ...(input.choices !== undefined ? { choices: input.choices } : {}),
      ...(input.multiline !== undefined ? { multiline: input.multiline } : {}),
    },
    mintOptionId,
  )
  const def = await deps.repos.fieldDefs.create({
    id: `lfd_${ulid()}`,
    tenantId: TENANT,
    listId: r.list.id,
    key,
    label: input.label,
    fieldType: input.fieldType,
    options,
    required: input.required,
    ...(input.position !== undefined ? { position: input.position } : {}),
    createdBy: actor,
  })
  return { kind: 'ok', data: serializeFieldDefDto(def) }
}

export interface UpdateFieldDefInputCore {
  label?: string | undefined
  required?: boolean | undefined
  position?: number | undefined
  choices?: SelectChoiceInput[] | undefined
  multiline?: boolean | undefined
}
export async function updateFieldDefCore(
  actor: string,
  listId: string,
  fieldId: string,
  input: UpdateFieldDefInputCore,
  deps: ListsRpcDeps,
): Promise<Ok<FieldDefDto> | ListsNotFound | Forbidden | FieldNotFound> {
  const r = await loadListForStructuralWrite(actor, listId, deps)
  if ('kind' in r) return r
  const def = await deps.repos.fieldDefs.findById(fieldId)
  if (!def || def.deletedAt || def.listId !== r.list.id) return { kind: 'field_not_found' }

  const issues: Array<{ code: string; path: string[]; message: string }> = []
  if (input.choices !== undefined && !isSelectFieldType(def.fieldType)) {
    issues.push({ code: 'custom', path: ['choices'], message: 'Only select fields accept choices.' })
  }
  if (input.multiline !== undefined && def.fieldType !== 'text') {
    issues.push({ code: 'custom', path: ['multiline'], message: 'Only text fields accept the multiline flag.' })
  }
  if (issues.length > 0) throw errors.validation({ issues })

  const patch: UpdateFieldDefInput = {}
  if (input.label !== undefined) patch.label = input.label
  if (input.required !== undefined) patch.required = input.required
  if (input.position !== undefined) patch.position = input.position
  if (input.choices !== undefined || input.multiline !== undefined) {
    patch.options = mergeUpdateOptions(
      def.fieldType,
      def.options,
      {
        ...(input.choices !== undefined ? { choices: input.choices } : {}),
        ...(input.multiline !== undefined ? { multiline: input.multiline } : {}),
      },
      mintOptionId,
    )
  }
  const updated = await deps.repos.fieldDefs.update(def.id, patch)
  if (!updated) return { kind: 'field_not_found' }
  return { kind: 'ok', data: serializeFieldDefDto(updated) }
}

export async function deleteFieldDefCore(
  actor: string,
  listId: string,
  fieldId: string,
  deps: ListsRpcDeps,
): Promise<Ok<true> | ListsNotFound | Forbidden | FieldNotFound> {
  const r = await loadListForStructuralWrite(actor, listId, deps)
  if ('kind' in r) return r
  const def = await deps.repos.fieldDefs.findById(fieldId)
  if (!def || def.deletedAt || def.listId !== r.list.id) return { kind: 'field_not_found' }
  await deps.repos.fieldDefs.softDelete(def.id, new Date())
  return { kind: 'ok', data: true }
}

export async function createCommentCore(
  actor: string,
  listId: string,
  itemId: string,
  body: string,
  deps: ListsRpcDeps,
): Promise<Ok<CommentDto> | ListsNotFound | ItemNotFound> {
  const r = await loadListForItemWrite(actor, listId, deps)
  if ('kind' in r) return r
  const item = await deps.repos.listItems.findById(itemId)
  if (!item || item.listId !== r.list.id || item.deletedAt) return { kind: 'item_not_found' }
  const comment = await deps.repos.listItemComments.create({
    id: `lic_${ulid()}`,
    tenantId: TENANT,
    itemId,
    authorId: actor,
    body,
  })
  return { kind: 'ok', data: serializeCommentDto(comment) }
}

// --- SERIES (sdk-series.ts) ----------------------------------------------

export async function createSeriesCore(
  actor: string,
  listId: string,
  input: CreateListItemSeriesInput,
  deps: ListsRpcDeps,
): Promise<Ok<SeriesDto> | ListsNotFound | Forbidden> {
  const r = await loadListForStructuralWrite(actor, listId, deps)
  if ('kind' in r) return r
  const list = r.list

  const ref = input.ref ?? null

  // Idempotent-create on (list_id, ref) — same rationale as
  // createListItemCore above: a series-create retry with the same ref
  // returns the original series instead of projecting a duplicate set
  // of occurrences.
  if (ref !== null) {
    const existing = await deps.repos.series.findByListAndRef(list.id, ref)
    if (existing) {
      if (existing.deletedAt !== null) {
        throw errors.seriesRefTakenByDeleted({
          ref,
          series_id: existing.id,
          deleted_at: existing.deletedAt.toISOString(),
        })
      }
      return { kind: 'ok', data: serializeSeriesDto(existing) }
    }
  }

  let series: ListItemSeriesRecord
  try {
    series = await deps.repos.series.create(listId, input, actor, list.tenantId)
  } catch (err) {
    // Race: two parallel creates with the same ref both got past the
    // pre-flight; the second hit the partial-unique index.
    if (err instanceof UniqueConstraintError && ref !== null) {
      const existing = await deps.repos.series.findByListAndRef(list.id, ref)
      if (existing) {
        if (existing.deletedAt !== null) {
          throw errors.seriesRefTakenByDeleted({
            ref,
            series_id: existing.id,
            deleted_at: existing.deletedAt.toISOString(),
          })
        }
        return { kind: 'ok', data: serializeSeriesDto(existing) }
      }
    }
    throw err
  }
  return { kind: 'ok', data: serializeSeriesDto(series) }
}

export async function listSeriesCore(
  actor: string,
  listId: string,
  deps: ListsRpcDeps,
): Promise<Ok<SeriesDto[]> | ListsNotFound> {
  const r = await loadListForRead(actor, listId, deps)
  if ('kind' in r) return r
  const rows = await deps.repos.series.list(listId)
  return { kind: 'ok', data: rows.map(serializeSeriesDto) }
}

export async function updateSeriesCore(
  actor: string,
  seriesId: string,
  input: UpdateListItemSeriesInput,
  deps: ListsRpcDeps,
): Promise<Ok<SeriesDto> | SeriesNotFound | Forbidden> {
  const existing = await deps.repos.series.findById(seriesId)
  if (!existing || existing.deletedAt) return { kind: 'series_not_found' }
  const r = await loadListForStructuralWrite(actor, existing.listId, deps)
  // Collapse an unreadable-list denial to series_not_found so probing
  // series ids never reveals whether one exists (existence oracle).
  if ('kind' in r) return r.kind === 'list_not_found' ? { kind: 'series_not_found' } : r
  const series = await deps.repos.series.update(seriesId, input, actor)
  if (!series) return { kind: 'series_not_found' }
  deps.logger.info({ seriesId, actor }, 'series updated (sdk)')
  return { kind: 'ok', data: serializeSeriesDto(series) }
}

export async function deleteSeriesCore(
  actor: string,
  seriesId: string,
  deps: ListsRpcDeps,
): Promise<Ok<true> | SeriesNotFound | Forbidden> {
  const existing = await deps.repos.series.findById(seriesId)
  if (!existing || existing.deletedAt) return { kind: 'series_not_found' }
  const r = await loadListForStructuralWrite(actor, existing.listId, deps)
  // Same series_not_found collapse as updateSeriesCore (existence oracle).
  if ('kind' in r) return r.kind === 'list_not_found' ? { kind: 'series_not_found' } : r
  const deleted = await deps.repos.series.softDelete(seriesId, actor)
  if (!deleted) return { kind: 'series_not_found' }
  deps.logger.info({ seriesId, actor }, 'series soft-deleted (sdk)')
  return { kind: 'ok', data: true }
}

// --- MERGE (RPC-only; consumed by planner-api personal-scope) ------------

export interface MergeListsResult {
  fieldDefsCreated: number
  seriesMoved: number
  itemsMoved: number
}

// A caller-defensive cap on how many source lists one merge folds in.
const MERGE_SOURCE_CAP = 25

// Fold every source list's contents into the target list. Generic by design:
// the CALLER decides which lists are sources and which is the target (planner-
// api's personal-scope.ts picks the canonical Tasks list + its residual task
// lists; no Planner policy lives here). The source LIST rows are left in place
// (only their items + series move); items can't be cross-list moved on this
// surface, so "move" = recreate-in-target + soft-delete-source.
//
// Per source list, in the caller's order:
//  1. Field defs — unify the source's custom-field schema into the target by
//     (label, fieldType); reuse a matching target def or create a new one.
//     Build an old-def-id → target-def-id remap.
//  2. Series — recreate each recurring series in the target (which materializes
//     fresh occurrences under a target seriesId), then soft-delete the source
//     series (which removes its source occurrences). The recurrence RULE +
//     template are preserved; per-occurrence completion history is regenerated,
//     not copied (a series can only be preserved via re-materialization).
//  3. One-off items (seriesId == null) — recreate in the target with
//     title/notes/status/priority/dueDate + the remapped customFields, then
//     soft-delete the source item.
//
// Composes the existing *Core fns so authorization, position-append, status
// seeding, custom-field validation, and series materialization stay single-
// sourced (this is byte-for-byte what planner-api used to drive over N RPC
// round-trips). Idempotent: after a run the sources hold no live items/series,
// so a re-run reads empties and writes nothing — no marker table needed.
//
// Best-effort, no cross-entity transaction: each item/series is copied-then-
// deleted, so a mid-run failure leaves a resumable partial state (some items
// moved, the rest still live on the source) that the next call completes —
// never a lost or duplicated item.
export async function mergeListsCore(
  actor: string,
  targetListId: string,
  sourceListIds: string[],
  deps: ListsRpcDeps,
): Promise<Ok<MergeListsResult> | ListsNotFound | SameSourceTarget | Forbidden> {
  // Reject self-merge up front (any source == target).
  if (sourceListIds.some((id) => id === targetListId)) return { kind: 'same_source_target' }
  // De-dupe sources while preserving the caller's order; empty → no-op.
  const sources = [...new Set(sourceListIds)]
  if (sources.length === 0) {
    return { kind: 'ok', data: { fieldDefsCreated: 0, seriesMoved: 0, itemsMoved: 0 } }
  }
  if (sources.length > MERGE_SOURCE_CAP) {
    throw errors.validation({
      issues: [
        {
          code: 'custom',
          path: ['sourceListIds'],
          message: `Cannot merge more than ${MERGE_SOURCE_CAP} lists at once.`,
        },
      ],
    })
  }

  // Verify the target is readable up front (opaque list_not_found on a miss),
  // so an unreadable target fails before any source is mutated.
  const targetProbe = await listFieldDefsCore(actor, targetListId, deps)
  if (targetProbe.kind !== 'ok') return targetProbe

  const result: MergeListsResult = { fieldDefsCreated: 0, seriesMoved: 0, itemsMoved: 0 }

  for (const sourceId of sources) {
    // (1) Unify custom-field schema. Re-read target defs each source pass so a
    //     def created for an earlier source is reused, not duplicated.
    const sourceDefs = await listFieldDefsCore(actor, sourceId, deps)
    if (sourceDefs.kind !== 'ok') return sourceDefs
    const targetDefs = await listFieldDefsCore(actor, targetListId, deps)
    if (targetDefs.kind !== 'ok') return targetDefs
    const plan = planFieldDefs(sourceDefs.data, targetDefs.data)
    const remap = new Map(plan.remap)
    for (const def of plan.toCreate) {
      const created = await createFieldDefCore(actor, targetListId, fieldDefCreateInput(def), deps)
      if (created.kind !== 'ok') return created // list_not_found | forbidden
      remap.set(def.id, created.data.id)
      result.fieldDefsCreated++
    }

    // (2) Recreate recurring series, then delete each source series.
    const series = await listSeriesCore(actor, sourceId, deps)
    if (series.kind !== 'ok') return series
    for (const s of series.data) {
      const created = await createSeriesCore(actor, targetListId, seriesCreateInput(s), deps)
      if (created.kind !== 'ok') return created // list_not_found | forbidden
      const deleted = await deleteSeriesCore(actor, s.id, deps)
      // series_not_found is benign (already gone — a resumed/concurrent run);
      // a creator-only denial (forbidden) is a real stop.
      if (deleted.kind === 'forbidden') return deleted
      result.seriesMoved++
    }

    // (3) Recreate one-off items, then delete each source item. Series-
    //     occurrence items (seriesId != null) are NOT copied — they were
    //     regenerated by the recreated series — but they ARE deleted so the
    //     source list ends up empty.
    const items = await listItemsCore(actor, sourceId, deps)
    if (items.kind !== 'ok') return items
    for (const item of items.data) {
      if (item.seriesId == null) {
        // createListItemCore mints its own id/tenantId/listId/createdBy and
        // appends position, so itemCreateInput omits those infra fields — the
        // same shape planner-api passed over RPC (the adapter cast `as never`).
        const created = await createListItemCore(
          actor,
          targetListId,
          itemCreateInput(item, remap) as unknown as CreateListItemInputCore,
          deps,
        )
        if (created.kind !== 'ok') return created // list_not_found
        result.itemsMoved++
      }
      const deleted = await deleteListItemCore(actor, sourceId, item.id, deps)
      // item_not_found is benign (already deleted); a vanished source list
      // (list_not_found) is a real stop.
      if (deleted.kind === 'list_not_found') return deleted
    }
  }

  return { kind: 'ok', data: result }
}

// --- MCP (sdk-mcp.ts) ----------------------------------------------------

export interface ResolvedMcpToken {
  userId: string
  tokenId: string
}
export async function resolveMcpTokenCore(
  token: string,
  deps: ListsRpcDeps,
): Promise<Ok<ResolvedMcpToken> | Unauthorized> {
  const row = await deps.repos.mcpTokens.findByHash(hashToken(token))
  if (!row || row.revokedAt !== null) return { kind: 'unauthorized' }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    return { kind: 'unauthorized' }
  }
  const now = new Date()
  const STALE_MS = 5 * 60 * 1000
  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() > STALE_MS) {
    await deps.repos.mcpTokens.touchLastUsed(row.id, now)
  }
  return { kind: 'ok', data: { userId: row.userId, tokenId: row.id } }
}
