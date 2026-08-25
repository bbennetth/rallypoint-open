// @rallypoint/lists-client — typed client SDK for the Rallypoint Lists
// SDK API surface (`/api/v1/sdk/lists/**`). Consumed by events-web (to
// render per-group lists inside Events) and third parties.
//
// Slice 1 ships a minimal client: health + list create/list. The full
// surface (items, groups, per-type operations) lands alongside the
// corresponding api slices. The SDK namespace authenticates with a
// bearer key (`Authorization: Bearer <apiKey>`) and does NOT send
// cookies — see docs/design/api-namespaces-cors.md.

import type {
  CreateFieldDefInput,
  CreateGroupInput,
  SdkCreateGroupInput,
  CreateListInput,
  CreateListItemInput,
  CreateSeriesInput,
  DayCode,
  FieldDefOptions,
  FieldType,
  ListBundle,
  ListImportResult,
  ListType,
  RecurrenceFreq,
  ScopeType,
  StatusCategory,
  TaskPriority,
  TaskStatus,
  UpdateFieldDefInput,
  UpdateListItemInput,
  UpdateSeriesInput,
  Visibility,
} from '@rallypoint/lists-shared'

export type {
  CreateFieldDefInput,
  CreateGroupInput,
  SdkCreateGroupInput,
  CreateListInput,
  CreateListItemInput,
  CreateSeriesInput,
  DayCode,
  FieldDefOptions,
  FieldType,
  ListType,
  RecurrenceFreq,
  ScopeType,
  StatusCategory,
  TaskPriority,
  TaskStatus,
  UpdateFieldDefInput,
  UpdateListItemInput,
  UpdateSeriesInput,
  Visibility,
}

// Wire shape of a list row returned by the API.
export interface ListDto {
  id: string
  scopeType: ScopeType
  scopeId: string
  listType: ListType
  name: string
  visibility: Visibility
  color: string | null
  createdBy: string
  /** Live (non-deleted, non-completed) item count for this list. */
  incompleteCount: number
  createdAt: string
  updatedAt: string
}

// Wire shape of a list item row returned by the SDK items endpoint.
// camelCase, flat (mirrors the api's serializeListItemDto). dueDate /
// status / priority are the fields My Day consumes. customFields holds the
// v2 typed values keyed by field-def id (`lfd_…`); pair with listFieldDefs
// to resolve labels / option ids.
export interface ListItemDto {
  id: string
  listId: string
  title: string
  notes: string | null
  assignedTo: string | null
  completed: boolean
  completedAt: string | null
  status: TaskStatus | null
  // Custom-status linkage (`lst_…`); pair with listStatuses to resolve
  // name/category/color. RPL v1.0.0.
  statusId: string | null
  // Sub-item parent (`lit_…`) in the same list; null for top-level. RPL v1.0.0.
  parentId: string | null
  priority: TaskPriority | null
  dueDate: string | null
  position: number
  customFields: Record<string, unknown>
  // Non-null when this item is an occurrence materialized from a recurring
  // series (`lse_…`); null for one-off items. Pairs with listSeries to
  // resolve the recurrence rule.
  seriesId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

// A soft-deleted item that is still inside the restore window. Live item
// reads deliberately omit deletedAt; the dedicated deleted-items surface
// makes it required so consumers can label and order trash views safely.
export interface DeletedListItemDto extends ListItemDto {
  deletedAt: string
}

// One keyset page of items. `nextCursor` is an opaque token (null at the end
// of the collection) minted by lists-api — consumers relay it verbatim, never
// parse it.
export interface ListItemsPage {
  items: ListItemDto[]
  nextCursor: string | null
}

// Wire shape of a recurring series row (mirrors the api's
// serializeSeriesDto). camelCase, no deletedAt/tenantId.
export interface ListItemSeriesDto {
  id: string
  listId: string
  title: string
  notes: string | null
  assignedTo: string | null
  priority: string | null
  freq: RecurrenceFreq
  interval: number
  byDay: DayCode[] | null
  dtstart: string
  until: string | null
  count: number | null
  timeOfDay: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

// Wire shape of a custom field definition (mirrors the api's
// serializeFieldDefDto). The schema for an item's customFields values.
export interface FieldDefDto {
  id: string
  listId: string
  key: string
  label: string
  fieldType: FieldType
  options: FieldDefOptions
  required: boolean
  defaultValue: unknown
  position: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

// Wire shape of a per-list custom status (mirrors the api's
// serializeListStatusDto). `category` is the load-bearing classifier;
// resolve an item's statusId against this set. RPL v1.0.0.
export interface ListStatusDto {
  id: string
  listId: string
  name: string
  color: string | null
  category: StatusCategory
  position: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

// Wire shape of a per-list label (mirrors the api's serializeLabelDto in
// routes/sdk-lists.ts). camelCase, no deletedAt. RPL v1.0.0.
export interface LabelDto {
  id: string
  listId: string
  name: string
  color: string | null
  position: number
  createdAt: string
  updatedAt: string
}

// Wire shape of a comment on a list item (mirrors the api's
// serializeCommentDto in routes/sdk-lists.ts). camelCase, no deletedAt.
export interface CommentDto {
  id: string
  itemId: string
  authorId: string
  body: string
  createdAt: string
  updatedAt: string
}

// Wire shape of a list_group row returned by the SDK write surface
// (mirrors the api's serializeGroupDto). A `list_group` is a multi-user
// container; Planner provisions one per user as a personal task-list
// scope. camelCase, no tenantId/deletedAt.
export interface GroupDto {
  id: string
  name: string
  description: string | null
  // Provenance: 'planner' for Planner-BFF-provisioned groups (served
  // read-only on the Lists UI surface); null for Lists-app groups.
  origin: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

// Thrown for any non-2xx response; carries the parsed error envelope
// (docs/design/error-shape.md) when present.
export class ListsClientError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ListsClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// The lists-api `/api/v1/sdk/*` namespace exposes GET reads (lists,
// items, field defs) plus an authenticated WRITE surface keyed on an
// `x-actor` (user_<ulid>) the calling peer app has already authorized.
// The write surface backs Rallypoint Planner: it provisions a per-user
// `list_group` as a personal task-list scope, then creates lists + items
// in it. A `list_group` scope is membership-checked server-side against
// the actor; opaque (Events `group`) scopes are trusted to the caller.
export interface ListsClient {
  health(): Promise<{ status: string }>
  // Reads are membership-checked against `actor` for `list_group` scopes
  // (private lists additionally require creator-or-share); opaque
  // (Events `group`) scopes are trusted to the caller.
  listLists(scope: { scopeType: ScopeType; scopeId: string }, actor: string): Promise<ListDto[]>
  listItems(listId: string, actor: string): Promise<ListItemDto[]>
  // Keyset-paged read in the default (position, createdAt, id) order. Prefer
  // this for large lists; `listItems` returns the whole set. `page.cursor` is
  // the opaque `nextCursor` from the previous page (null/absent → first page).
  listItemsPage(
    listId: string,
    actor: string,
    page?: { limit?: number; cursor?: string | null },
  ): Promise<ListItemsPage>
  listDeletedItems(listId: string, actor: string): Promise<DeletedListItemDto[]>
  // Fetch a single item by id, scoped to `listId`. Returns null when the
  // item doesn't exist, belongs to a different list, or is soft-deleted
  // (matches the findItemInScope not-found convention).
  getItem(listId: string, itemId: string, actor: string): Promise<ListItemDto | null>
  // Custom field definitions for a list — the schema needed to interpret
  // each item's `customFields`.
  listFieldDefs(listId: string, actor: string): Promise<FieldDefDto[]>
  // Per-list custom statuses — the set needed to interpret each item's
  // `statusId` (id → name/category/color). Lazily seeds defaults. RPL v1.0.0.
  listStatuses(listId: string, actor: string): Promise<ListStatusDto[]>
  // Per-list labels — the set needed to interpret each item's `label_ids`.
  // RPL v1.0.0.
  listLabels(listId: string, actor: string): Promise<LabelDto[]>
  // --- field defs (writes) ------------------------------------------
  // Define / update / remove a list's custom-field schema. `actor` must be
  // a member of the list's scope (sent as x-actor); fieldType is immutable
  // so UpdateFieldDefInput omits it.
  createFieldDef(listId: string, input: CreateFieldDefInput, actor: string): Promise<FieldDefDto>
  updateFieldDef(
    listId: string,
    fieldId: string,
    patch: UpdateFieldDefInput,
    actor: string,
  ): Promise<FieldDefDto>
  deleteFieldDef(listId: string, fieldId: string, actor: string): Promise<void>
  // --- groups (personal-scope provisioning) -------------------------
  // The list_groups the actor is a member of. Planner uses this to find
  // the user's existing personal group before creating one.
  listGroups(actor: string): Promise<GroupDto[]>
  // Create a list_group; the actor is auto-enrolled as its owner member.
  // `origin: 'planner'` stamps provenance so the Lists UI serves the
  // group read-only.
  createGroup(input: SdkCreateGroupInput, actor: string): Promise<GroupDto>
  // --- lists / items (writes) ---------------------------------------
  // Create a list in a scope. For a `list_group` scope the actor must be
  // a member (404 otherwise); opaque scopes are trusted to the caller.
  createList(input: CreateListInput, actor: string): Promise<ListDto>
  // Soft-delete a list. For a `list_group` scope the actor must be a
  // member (404 otherwise); opaque scopes are trusted to the caller.
  deleteList(listId: string, actor: string): Promise<void>
  // Create an item in a list the actor can access.
  createListItem(listId: string, input: CreateListItemInput, actor: string): Promise<ListItemDto>
  // Sparse-update / check-off an item. Cross-list move is rejected.
  updateListItem(
    listId: string,
    itemId: string,
    patch: UpdateListItemInput,
    actor: string,
  ): Promise<ListItemDto>
  // Soft-delete an item.
  deleteListItem(listId: string, itemId: string, actor: string): Promise<void>
  // Restore a soft-deleted item while it remains inside the restore window.
  restoreListItem(listId: string, itemId: string, actor: string): Promise<ListItemDto>
  // Move an item from `listId` to `targetListId` (the explicit cross-list
  // move surface — #549). Field values not meaningful in the target are
  // cleaned server-side; position is re-appended at the target's end.
  // Returns the updated item DTO (now bearing the target listId).
  moveListItem(
    listId: string,
    itemId: string,
    targetListId: string,
    actor: string,
  ): Promise<ListItemDto>
  // Find an item by id among ALL the actor's lists in a scope, returning the
  // live item DTO (which carries its parent listId) or `null` when no such
  // live item is in the scope. Lets a caller resolve an item to its parent
  // list without a per-list items fan-out (#559). `actor` is sent as x-actor.
  findItemInScope(
    scope: { scopeType: ScopeType; scopeId: string },
    itemId: string,
    actor: string,
  ): Promise<ListItemDto | null>
  // --- series (recurring items) -------------------------------------
  // Create a recurring series for a list. `actor` is the user_<ulid>
  // the calling app has already authorized; sent as x-actor header.
  createListItemSeries(listId: string, input: CreateSeriesInput, actor: string): Promise<ListItemSeriesDto>
  // List all active (non-deleted) series for a list.
  listSeries(listId: string, actor: string): Promise<ListItemSeriesDto[]>
  // Sparse-update a series rule/template; re-projects future occurrences.
  updateSeries(seriesId: string, patch: UpdateSeriesInput, actor: string): Promise<ListItemSeriesDto>
  // Soft-delete a series + its future non-exception occurrences.
  deleteSeries(seriesId: string, actor: string): Promise<void>
  // --- comments -----------------------------------------------------
  // Live comments for a list item, oldest-first (PLANNER_API_KEY-gated).
  listComments(listId: string, itemId: string, actor: string): Promise<CommentDto[]>
  // Create a comment on a list item. `actor` is the user_<ulid> the
  // calling peer app has already authenticated.
  createComment(
    listId: string,
    itemId: string,
    input: { body: string },
    actor: string,
  ): Promise<CommentDto>
  // --- merge --------------------------------------------------------
  // Fold every source list's items + series into `targetListId`, unifying
  // custom-field schemas by (label, fieldType) and soft-deleting the moved
  // source items/series (the source LIST rows stay). Generic: the CALLER
  // decides which lists are sources vs. target — no product policy lives in
  // lists-api. `actor` must be able to read each source and structurally
  // write the target (creator-only on `list_group` scopes). Idempotent — a
  // re-run over already-emptied sources is a no-op. Returns per-run counts.
  mergeLists(
    targetListId: string,
    sourceListIds: string[],
    actor: string,
  ): Promise<MergeListsResult>

  // Whole-list export/import, the generic capability an app-level
  // backup–restore composes. A bundle carries no row ids: items and series
  // travel by `ref` (so a re-import dedupes on the key the create path
  // already enforces) and statuses/labels/field defs are matched by name/key
  // on the target list. `actor` must be able to read the source list and
  // write into the target scope.
  exportListBundle(listId: string, actor: string): Promise<ListBundle>
  importListBundle(
    scope: { scopeType: ScopeType; scopeId: string },
    bundle: ListBundle,
    actor: string,
  ): Promise<ListImportResult>
}

// Per-run tallies from a mergeLists call (all zero when there was nothing to
// fold in). Advisory — the merge's effect is on the target/source lists.
export interface MergeListsResult {
  fieldDefsCreated: number
  seriesMoved: number
  itemsMoved: number
}
