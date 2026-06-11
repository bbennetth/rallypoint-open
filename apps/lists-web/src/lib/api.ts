// Typed lists-api client. The CSRF/transport machinery now lives in
// @rallypoint/web-kit's createCsrfClient (byte-identical across events
// and lists before extraction); this module keeps the lists-specific
// typed DTO layer on top of it. All calls go through the Vite dev proxy
// (and the production reverse proxy) at /api/v1/ui/*, always with
// credentials:'include' so the session + CSRF cookies ride along.
// State-changing requests bootstrap a CSRF token (GET /csrf) and echo
// it in X-RP-CSRF — the double-submit half the server checks.

import { ApiError, createCsrfClient, resetAnalytics } from '@rallypoint/web-kit'
import type { SessionProfile } from '@rallypoint/web-kit'
import { hydrateThemeFromServer } from '@rallypoint/ui'

export type { SessionProfile }
import { encodeFilterParam, encodeSortParam } from '@rallypoint/lists-shared'
import type {
  CreateFieldDefInput,
  CreateGroupInput,
  CreateListInput,
  CreateListItemInput,
  FieldDefOptions,
  FieldType,
  FilterSpec,
  GroupRole,
  ListType,
  ScopeType,
  SortSpec,
  TaskPriority,
  TaskStatus,
  UpdateFieldDefInput,
  UpdateGroupInput,
  UpdateListItemInput,
  ViewConfig,
  Visibility,
} from '@rallypoint/lists-shared'

export { ApiError }

const client = createCsrfClient({ basePath: '/api/v1/ui' })
const request = client.request

// Server DTO (snake_case) — mirrors lists-api's serializeList.
export interface ListDto {
  id: string
  scope_type: ScopeType
  scope_id: string
  list_type: ListType
  name: string
  visibility: Visibility
  color: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface ListPage {
  items: ListDto[]
}

// Server DTO (snake_case) — mirrors lists-api's serializeItem.
export interface ListItemDto {
  id: string
  list_id: string
  title: string
  notes: string | null
  assigned_to: string | null
  completed: boolean
  completed_at: string | null
  status: TaskStatus | null
  priority: TaskPriority | null
  due_date: string | null
  // Lists v2 typed values keyed by field-def id (`lfd_…`). `{}` on a list
  // with no field defs.
  custom_fields: Record<string, unknown>
  position: number
  created_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface ListItemPage {
  items: ListItemDto[]
  // True when the list exceeded lists-api's scan cap and `items` was
  // truncated (#472). Absent on older responses; treat undefined as false.
  filter_truncated?: boolean
}

// Server DTO (snake_case) — mirrors lists-api's serializeGroup.
export interface GroupDto {
  id: string
  name: string
  description: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface GroupPage {
  items: GroupDto[]
}

// Server DTO (snake_case) — mirrors lists-api's serializeMember.
export interface GroupMemberDto {
  id: string
  group_id: string
  user_id: string
  role: GroupRole
  joined_at: string
}

export interface GroupMemberPage {
  items: GroupMemberDto[]
}

// Server DTO (snake_case) — mirrors lists-api's serializeFieldDef.
// Lists v2 custom field definition. `options` carries select choices
// and/or the text `multiline` flag; `field_type` is immutable once set.
export interface FieldDefDto {
  id: string
  list_id: string
  key: string
  label: string
  field_type: FieldType
  options: FieldDefOptions
  required: boolean
  default_value: unknown | null
  position: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface FieldDefPage {
  items: FieldDefDto[]
}

// Server DTO (snake_case) — mirrors lists-api's serializeView. A saved
// view bundles a filter/sort/columns/mode config under a name. v2 views
// are per-list and shared (any reader sees them; only the creator edits).
export interface ListViewDto {
  id: string
  list_id: string
  name: string
  config: ViewConfig
  position: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface ListViewPage {
  items: ListViewDto[]
}

// --- session / SSO --------------------------------------------------

export interface SessionDto {
  user_id: string
  // The shared cross-app settings doc folded in by the BFF. Theme keys
  // (themeMode/themeColor) hydrate the store on load; other keys are
  // opaque to the client.
  settings?: Record<string, unknown>
  // The signed-in user's RPID profile (avatar + name) folded in by the
  // BFF for the user bar; `null`/absent when the fold-in degraded.
  profile?: SessionProfile | null
}

export async function getSession(): Promise<SessionDto> {
  const session = await request<SessionDto>('GET', '/api/v1/ui/session')
  // Side-effect: apply the server's theme before the first authed render
  // so the preference follows the user across devices/apps. Does not echo
  // a write back (hydrateThemeFromServer suppresses the persister).
  if (session.settings) {
    hydrateThemeFromServer({
      mode: session.settings.themeMode,
      color: session.settings.themeColor,
    })
  }
  return session
}

// Persist a shallow patch into a settings namespace (a `null`-valued key
// deletes it). Used by the theme persister (registered in main.tsx) and
// the Settings page. Returns the merged doc.
export async function updateSettings(
  namespace: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request<{ settings: Record<string, unknown> }>(
    'PATCH',
    `/api/v1/ui/settings/${encodeURIComponent(namespace)}`,
    patch,
  )
  return res.settings
}

export async function exchangeSso(code: string, state: string): Promise<void> {
  await request<void>('POST', '/api/v1/ui/sso/exchange', { code, state })
}

export async function signout(): Promise<void> {
  await request<void>('POST', '/api/v1/ui/signout')
  resetAnalytics()
}

// --- lists ----------------------------------------------------------

export async function createList(input: CreateListInput): Promise<ListDto> {
  return request<ListDto>('POST', '/api/v1/ui/lists', input)
}

export async function getList(listId: string): Promise<ListDto> {
  return request<ListDto>('GET', `/api/v1/ui/lists/${listId}`)
}

export async function listLists(scope: {
  scopeType: ScopeType
  scopeId: string
}): Promise<ListPage> {
  const q = new URLSearchParams({
    scope_type: scope.scopeType,
    scope_id: scope.scopeId,
  })
  return request<ListPage>('GET', `/api/v1/ui/lists?${q.toString()}`)
}

// Lists every list the caller has been shared on (i.e. has a row in
// list_shares). Backs the "Shared with me" surface in lists-web for
// recipients who aren't members of the host list_group.
export async function listSharedWithMe(): Promise<ListPage> {
  return request<ListPage>('GET', '/api/v1/ui/lists/shared-with-me')
}

// --- list items -----------------------------------------------------

// Optional filter/sort query (Lists v2 slice 4). Each spec is encoded to
// the repeatable `filter`/`sort` wire form the API parses; absent/empty
// arrays yield the unfiltered list (v1 behaviour).
export interface ListItemQuery {
  filters?: FilterSpec[]
  sort?: SortSpec[]
}

export async function listItems(listId: string, query?: ListItemQuery): Promise<ListItemPage> {
  const q = new URLSearchParams()
  for (const f of query?.filters ?? []) q.append('filter', encodeFilterParam(f))
  for (const s of query?.sort ?? []) q.append('sort', encodeSortParam(s))
  const qs = q.toString()
  return request<ListItemPage>('GET', `/api/v1/ui/lists/${listId}/items${qs ? `?${qs}` : ''}`)
}

export async function createItem(
  listId: string,
  input: CreateListItemInput,
): Promise<ListItemDto> {
  return request<ListItemDto>('POST', `/api/v1/ui/lists/${listId}/items`, input)
}

export async function updateItem(
  listId: string,
  itemId: string,
  patch: UpdateListItemInput,
): Promise<ListItemDto> {
  return request<ListItemDto>('PATCH', `/api/v1/ui/lists/${listId}/items/${itemId}`, patch)
}

export async function deleteItem(listId: string, itemId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/lists/${listId}/items/${itemId}`)
}

export async function restoreItem(listId: string, itemId: string): Promise<ListItemDto> {
  return request<ListItemDto>('POST', `/api/v1/ui/lists/${listId}/items/${itemId}/restore`)
}

// Bulk item action (Lists v2 slice 6). One request applies a single
// action across many items server-side, in one transaction, emitting one
// realtime frame. `update` carries the shared patch; `delete` soft-deletes
// the set. Returns the ids actually affected (cross-list / already-deleted
// ids are skipped server-side).
export interface BulkItemPatch {
  completed?: boolean
  assignedTo?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  dueDate?: string | null
  customFields?: Record<string, unknown>
}

export async function bulkItems(
  listId: string,
  action:
    | { action: 'update'; itemIds: string[]; patch: BulkItemPatch }
    | { action: 'delete'; itemIds: string[] },
): Promise<{ count: number; ids: string[] }> {
  return request<{ count: number; ids: string[] }>(
    'POST',
    `/api/v1/ui/lists/${listId}/items/bulk`,
    action,
  )
}

// --- list field defs (Lists v2 custom fields) -----------------------

export async function listFieldDefs(listId: string): Promise<FieldDefPage> {
  return request<FieldDefPage>('GET', `/api/v1/ui/lists/${listId}/fields`)
}

export async function createFieldDef(
  listId: string,
  input: CreateFieldDefInput,
): Promise<FieldDefDto> {
  return request<FieldDefDto>('POST', `/api/v1/ui/lists/${listId}/fields`, input)
}

export async function updateFieldDef(
  listId: string,
  fieldId: string,
  patch: UpdateFieldDefInput,
): Promise<FieldDefDto> {
  return request<FieldDefDto>('PATCH', `/api/v1/ui/lists/${listId}/fields/${fieldId}`, patch)
}

export async function deleteFieldDef(listId: string, fieldId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/lists/${listId}/fields/${fieldId}`)
}

// --- list views (Lists v2 saved views) ------------------------------

export async function listViews(listId: string): Promise<ListViewPage> {
  return request<ListViewPage>('GET', `/api/v1/ui/lists/${listId}/views`)
}

export async function createView(
  listId: string,
  input: { name: string; config?: ViewConfig },
): Promise<ListViewDto> {
  return request<ListViewDto>('POST', `/api/v1/ui/lists/${listId}/views`, input)
}

export async function updateView(
  listId: string,
  viewId: string,
  patch: { name?: string; config?: ViewConfig; position?: number },
): Promise<ListViewDto> {
  return request<ListViewDto>('PATCH', `/api/v1/ui/lists/${listId}/views/${viewId}`, patch)
}

export async function deleteView(listId: string, viewId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/lists/${listId}/views/${viewId}`)
}

// --- groups ---------------------------------------------------------

export async function listGroups(): Promise<GroupPage> {
  return request<GroupPage>('GET', '/api/v1/ui/groups')
}

export async function createGroup(input: CreateGroupInput): Promise<GroupDto> {
  return request<GroupDto>('POST', '/api/v1/ui/groups', input)
}

export async function updateGroup(
  groupId: string,
  patch: UpdateGroupInput,
): Promise<GroupDto> {
  return request<GroupDto>('PATCH', `/api/v1/ui/groups/${groupId}`, patch)
}

export async function listGroupMembers(groupId: string): Promise<GroupMemberPage> {
  return request<GroupMemberPage>('GET', `/api/v1/ui/groups/${groupId}/members`)
}

// --- list shares + share-by-email invites (#128) --------------------
//
// `'private'` lists carry per-list access in `list_shares`. Owners
// mint share invites by email; recipients land on `/share/:code` and
// auto-accept after RPID sign-in. Pattern mirrors events-api invites.

export interface ListShareDto {
  id: string
  list_id: string
  user_id: string
  added_by_user_id: string
  created_at: string
}

export interface ListShareCollection {
  items: ListShareDto[]
}

export interface ListInviteDto {
  id: string
  list_id: string
  invited_email: string
  invited_by_user_id: string
  created_at: string
  expires_at: string
  consumed_at: string | null
}

export interface ListInviteCollection {
  items: ListInviteDto[]
}

// The raw code leaves the API exactly once, in the create response.
export interface ListInviteWithCode extends ListInviteDto {
  code: string
}

export async function createListInvite(
  listId: string,
  invitedEmail: string,
): Promise<ListInviteWithCode> {
  return request<ListInviteWithCode>(
    'POST',
    `/api/v1/ui/lists/${listId}/invites`,
    { invitedEmail },
  )
}

export async function listListInvites(listId: string): Promise<ListInviteCollection> {
  return request<ListInviteCollection>('GET', `/api/v1/ui/lists/${listId}/invites`)
}

export async function revokeListInvite(
  listId: string,
  inviteId: string,
): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/lists/${listId}/invites/${inviteId}`)
}

export async function acceptListInvite(code: string): Promise<{ list_id: string }> {
  return request<{ list_id: string }>('POST', '/api/v1/ui/lists/invites/accept', { code })
}

export async function listListShares(listId: string): Promise<ListShareCollection> {
  return request<ListShareCollection>('GET', `/api/v1/ui/lists/${listId}/shares`)
}

export async function revokeListShare(
  listId: string,
  userId: string,
): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/lists/${listId}/shares/${userId}`)
}

// Soft-delete the list (creator-only; returns 404 for non-creators).
export async function deleteList(listId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/lists/${encodeURIComponent(listId)}`)
}

// --- planner prefs --------------------------------------------------
// Per-user "show this list in Planner" flag. The server gates on read
// access to the list, so shared lists can be flagged by the recipient.

export async function setListPlannerPref(listId: string, show: boolean): Promise<void> {
  await request<void>('PUT', `/api/v1/ui/lists/${encodeURIComponent(listId)}/planner-pref`, { show })
}

export async function listPlannerPrefs(): Promise<string[]> {
  const r = await request<{ listIds: string[] }>('GET', '/api/v1/ui/planner-prefs')
  return r.listIds
}
