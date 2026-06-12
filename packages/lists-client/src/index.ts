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

export interface ListsClientConfig {
  // Base origin of lists-api, e.g. https://lists.rallypt.app or
  // http://localhost:8082. No trailing slash required.
  baseUrl: string
  // SDK bearer key minted by lists-api.
  apiKey: string
  // Optional fetch override (tests / non-browser runtimes).
  fetch?: typeof fetch
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
  listLists(scope: { scopeType: ScopeType; scopeId: string }): Promise<ListDto[]>
  listItems(listId: string): Promise<ListItemDto[]>
  // Custom field definitions for a list — the schema needed to interpret
  // each item's `customFields`.
  listFieldDefs(listId: string): Promise<FieldDefDto[]>
  // Per-list custom statuses — the set needed to interpret each item's
  // `statusId` (id → name/category/color). Lazily seeds defaults. RPL v1.0.0.
  listStatuses(listId: string): Promise<ListStatusDto[]>
  // Per-list labels — the set needed to interpret each item's `label_ids`.
  // RPL v1.0.0.
  listLabels(listId: string): Promise<LabelDto[]>
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
  // --- series (recurring items) -------------------------------------
  // Create a recurring series for a list. `actor` is the user_<ulid>
  // the calling app has already authorized; sent as x-actor header.
  createListItemSeries(listId: string, input: CreateSeriesInput, actor: string): Promise<ListItemSeriesDto>
  // List all active (non-deleted) series for a list.
  listSeries(listId: string): Promise<ListItemSeriesDto[]>
  // Sparse-update a series rule/template; re-projects future occurrences.
  updateSeries(seriesId: string, patch: UpdateSeriesInput, actor: string): Promise<ListItemSeriesDto>
  // Soft-delete a series + its future non-exception occurrences.
  deleteSeries(seriesId: string, actor: string): Promise<void>
  // --- comments -----------------------------------------------------
  // Live comments for a list item, oldest-first (PLANNER_API_KEY-gated).
  listComments(listId: string, itemId: string): Promise<CommentDto[]>
  // Create a comment on a list item. `actor` is the user_<ulid> the
  // calling peer app has already authenticated.
  createComment(
    listId: string,
    itemId: string,
    input: { body: string },
    actor: string,
  ): Promise<CommentDto>
}

export function createListsClient(config: ListsClientConfig): ListsClient {
  const base = config.baseUrl.replace(/\/$/, '')
  const doFetch = config.fetch ?? globalThis.fetch

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    const json: unknown = text ? JSON.parse(text) : {}
    if (!res.ok) {
      const env = (json as { error?: { code?: string; message?: string; details?: unknown } })
        .error
      throw new ListsClientError(
        res.status,
        env?.code ?? 'unknown_error',
        env?.message ?? `Request failed with status ${res.status}`,
        env?.details,
      )
    }
    return json as T
  }

  return {
    health() {
      return request<{ status: string }>('GET', '/api/v1/health')
    },
    listLists(scope) {
      const qs = new URLSearchParams({
        scope_type: scope.scopeType,
        scope_id: scope.scopeId,
      })
      return request<ListDto[]>('GET', `/api/v1/sdk/lists?${qs.toString()}`)
    },
    listItems(listId) {
      return request<ListItemDto[]>(
        'GET',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/items`,
      )
    },
    listFieldDefs(listId) {
      return request<FieldDefDto[]>(
        'GET',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/fields`,
      )
    },
    listStatuses(listId) {
      return request<ListStatusDto[]>(
        'GET',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/statuses`,
      )
    },
    listLabels(listId) {
      return request<LabelDto[]>(
        'GET',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/labels`,
      )
    },
    createFieldDef(listId, input, actor) {
      return request<FieldDefDto>(
        'POST',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/fields`,
        input,
        { 'x-actor': actor },
      )
    },
    updateFieldDef(listId, fieldId, patch, actor) {
      return request<FieldDefDto>(
        'PATCH',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/fields/${encodeURIComponent(fieldId)}`,
        patch,
        { 'x-actor': actor },
      )
    },
    deleteFieldDef(listId, fieldId, actor) {
      return request<void>(
        'DELETE',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/fields/${encodeURIComponent(fieldId)}`,
        undefined,
        { 'x-actor': actor },
      )
    },
    listGroups(actor) {
      return request<GroupDto[]>('GET', '/api/v1/sdk/groups', undefined, {
        'x-actor': actor,
      })
    },
    createGroup(input, actor) {
      return request<GroupDto>('POST', '/api/v1/sdk/groups', input, {
        'x-actor': actor,
      })
    },
    createList(input, actor) {
      return request<ListDto>('POST', '/api/v1/sdk/lists', input, {
        'x-actor': actor,
      })
    },
    deleteList(listId, actor) {
      return request<void>(
        'DELETE',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}`,
        undefined,
        { 'x-actor': actor },
      )
    },
    createListItem(listId, input, actor) {
      return request<ListItemDto>(
        'POST',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/items`,
        input,
        { 'x-actor': actor },
      )
    },
    updateListItem(listId, itemId, patch, actor) {
      return request<ListItemDto>(
        'PATCH',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
        patch,
        { 'x-actor': actor },
      )
    },
    deleteListItem(listId, itemId, actor) {
      return request<void>(
        'DELETE',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
        undefined,
        { 'x-actor': actor },
      )
    },
    createListItemSeries(listId, input, actor) {
      return request<ListItemSeriesDto>(
        'POST',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/series`,
        input,
        { 'x-actor': actor },
      )
    },
    listSeries(listId) {
      return request<ListItemSeriesDto[]>(
        'GET',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/series`,
      )
    },
    updateSeries(seriesId, patch, actor) {
      return request<ListItemSeriesDto>(
        'PATCH',
        `/api/v1/sdk/series/${encodeURIComponent(seriesId)}`,
        patch,
        { 'x-actor': actor },
      )
    },
    deleteSeries(seriesId, actor) {
      return request<void>(
        'DELETE',
        `/api/v1/sdk/series/${encodeURIComponent(seriesId)}`,
        undefined,
        { 'x-actor': actor },
      )
    },
    listComments(listId, itemId) {
      return request<CommentDto[]>(
        'GET',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/comments`,
      )
    },
    createComment(listId, itemId, input, actor) {
      return request<CommentDto>(
        'POST',
        `/api/v1/sdk/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/comments`,
        input,
        { 'x-actor': actor },
      )
    },
  }
}
