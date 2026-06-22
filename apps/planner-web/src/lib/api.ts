// Typed planner-api client. The CSRF/transport machinery lives in
// @rallypoint/web-kit's createCsrfClient; this module keeps only the
// session/SSO layer — there are no domain-specific DTOs in slice 5.
// All calls go through the Vite dev proxy (and the production reverse
// proxy) at /api/v1/ui/*, always with credentials:'include' so the
// session + CSRF cookies ride along.

import { ApiError, createCsrfClient, resetAnalytics } from '@rallypoint/web-kit'
import type { SessionProfile } from '@rallypoint/web-kit'
import { hydrateThemeFromServer } from '@rallypoint/ui'

export { ApiError }
export type { SessionProfile }

const client = createCsrfClient({ basePath: '/api/v1/ui' })
const request = client.request

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

// Read the full settings document for a namespace. Used by the Settings page
// to load existing preferences on mount without a full session refresh.
export async function getSettings(namespace: string): Promise<Record<string, unknown>> {
  const res = await request<{ settings: Record<string, unknown> }>(
    'GET',
    `/api/v1/ui/settings/${encodeURIComponent(namespace)}`,
  )
  return res.settings
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

// --- push notifications --------------------------------------------

export interface PushSubscriptionPayload {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

// Register (or refresh) the browser's Web Push subscription with planner-api.
export async function registerPushSubscription(sub: PushSubscriptionPayload): Promise<void> {
  await request<void>('POST', '/api/v1/ui/push/subscription', sub)
}

// Remove the browser's Web Push subscription (notifications turned off).
export async function removePushSubscription(endpoint: string): Promise<void> {
  await request<void>('DELETE', '/api/v1/ui/push/subscription', { endpoint })
}

export interface TestPushResult {
  // Devices the user has registered.
  subscriptions: number
  // Devices that accepted the test push.
  sent: number
  // Dead devices reaped during the send.
  reaped: number
}

// Send a test notification to the user's registered devices right now.
export async function sendTestPush(): Promise<TestPushResult> {
  return request<TestPushResult>('POST', '/api/v1/ui/push/test')
}

export async function signout(): Promise<void> {
  await request<void>('POST', '/api/v1/ui/signout')
  resetAnalytics()
}

// --- task lists (slice 6b) ------------------------------------------
// Mirror the planner-api BFF responses, which pass the Lists SDK DTOs
// through verbatim (camelCase). The BFF owns scope + listType, so the
// client only ever sends user-facing fields.

export interface TaskListDto {
  id: string
  name: string
  color: string | null
  listType: string
  // Count of non-deleted, non-completed items in the list. Surfaced by the
  // Lists SDK list read (Phase B) and shown as the per-list badge in the
  // Tasks rail.
  incompleteCount: number
  createdAt: string
}

export interface TaskItemDto {
  id: string
  listId: string
  title: string
  notes: string | null
  completed: boolean
  status: string | null
  priority: string | null
  dueDate: string | null
  position: number
  // Non-null when this item is an occurrence of a recurring series; the UI
  // badges these as "Repeats".
  seriesId: string | null
  // Lists v2 typed custom-field values, keyed by field-def id (`lfd_…`).
  // Interpreted against the list's field defs (see listFieldDefs). Empty
  // object when the item has no custom values.
  customFields: Record<string, unknown>
  createdAt: string
}

// --- custom field definitions (slice 13) ----------------------------
// The per-list schema for typed custom values. Mirrors the Lists SDK
// FieldDefDto (camelCase) the BFF passes through. `fieldType` is immutable
// after creation; select types carry `options.choices`, text carries
// `options.multiline`.

export type FieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'single_select'
  | 'multi_select'
  | 'person'
  | 'url'

export interface SelectChoice {
  id: string
  label: string
  archived?: boolean
}

export interface FieldDefOptions {
  choices?: SelectChoice[]
  multiline?: boolean
}

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
  createdAt: string
}

// User-facing inputs for the field manager. The BFF/SDK derive the key +
// mint option ids; the UI only supplies label, type, choices, and flags.
export interface CreateFieldDefInput {
  label: string
  fieldType: FieldType
  required?: boolean
  choices?: { label: string }[]
  multiline?: boolean
  position?: number
}

// fieldType is immutable, so it is absent. `choices` replaces the live
// (non-archived) set; the server merges to keep historical values resolvable.
export interface UpdateFieldDefInput {
  label?: string
  required?: boolean
  choices?: { id?: string; label: string; archived?: boolean }[]
  multiline?: boolean
  position?: number
}

export async function listFieldDefs(listId: string): Promise<FieldDefDto[]> {
  return request<FieldDefDto[]>('GET', `/api/v1/ui/lists/${encodeURIComponent(listId)}/fields`)
}

export async function createFieldDef(
  listId: string,
  input: CreateFieldDefInput,
): Promise<FieldDefDto> {
  return request<FieldDefDto>(
    'POST',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/fields`,
    input,
  )
}

export async function updateFieldDef(
  listId: string,
  fieldId: string,
  patch: UpdateFieldDefInput,
): Promise<FieldDefDto> {
  return request<FieldDefDto>(
    'PATCH',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/fields/${encodeURIComponent(fieldId)}`,
    patch,
  )
}

export async function deleteFieldDef(listId: string, fieldId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/fields/${encodeURIComponent(fieldId)}`,
  )
}

// Wire shape of a recurring series (passed through from the Lists SDK).
export interface TaskSeriesDto {
  id: string
  listId: string
  title: string
  notes: string | null
  priority: string | null
  freq: 'daily' | 'weekly'
  interval: number
  byDay: string[] | null
  dtstart: string
  until: string | null
  count: number | null
  timeOfDay: string | null
  createdAt: string
}

// Input for creating a recurring series. Mirrors the subset of the Lists
// CreateSeriesSchema the Planner UI exposes. Exactly one of `until` / `count`
// bounds the series; `byDay` is weekly-only.
export interface CreateTaskSeriesInput {
  title: string
  freq: 'daily' | 'weekly'
  interval: number
  byDay?: string[]
  dtstart: string
  until?: string
  count?: number
  timeOfDay?: string
}

// Sparse patch for editing a recurring series rule or first-class fields.
// All fields optional; omit to leave unchanged.
export interface UpdateTaskSeriesInput {
  title?: string
  notes?: string
  priority?: string
  freq?: 'daily' | 'weekly'
  interval?: number
  // `null` clears byDay (switching to daily, or "dtstart's weekday").
  // An empty array would fail the server's min(1) guard — use null.
  byDay?: string[] | null
  dtstart?: string
  // `null` clears the bound. The server rejects '' for `until` (must be a
  // valid date) and ignores an omitted `count`, so null is the only way to
  // clear either. until/count are mutually exclusive.
  until?: string | null
  count?: number | null
  timeOfDay?: string
}

// BFF response for the Recurring section on the Upcoming page. Contains the
// series rule + a bounded preview of the next occurrences (up to 5 dates).
export interface RecurringSeriesDto extends TaskSeriesDto {
  listName: string
  next: string[]
}

export interface RecurringResponse {
  date: string
  recurring: RecurringSeriesDto[]
}

// Resolve the caller's single canonical Tasks list (#543). The BFF
// provisions it on first access and folds any legacy extra task lists into
// it, returning a one-element array — callers take the head.
export async function listTaskLists(): Promise<TaskListDto[]> {
  return request<TaskListDto[]>('GET', '/api/v1/ui/lists')
}

/** Set or clear the actor's "show in planner" flag on a group event. */
export async function setGroupEventPlannerPref(eventId: string, show: boolean): Promise<void> {
  await request<void>('PUT', `/api/v1/ui/events/${encodeURIComponent(eventId)}/planner-pref`, {
    show,
  })
}

export async function listTaskItems(listId: string): Promise<TaskItemDto[]> {
  // Pass the browser tz so the BFF resolves any recurring occurrence's floating
  // due into a genuine instant (the single resolver); the client renders it with
  // plain local formatters and never re-anchors.
  return request<TaskItemDto[]>(
    'GET',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items?tz=${encodeURIComponent(taskTz())}`,
  )
}

// The browser's IANA timezone, appended to task writes as `?tz=` so the BFF
// can tell a timed due from a day-only one and schedule notifications.
function taskTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export async function createTaskItem(
  listId: string,
  title: string,
  opts?: { dueDate?: string | null; priority?: string | null },
): Promise<TaskItemDto> {
  return request<TaskItemDto>(
    'POST',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items?tz=${encodeURIComponent(taskTz())}`,
    {
      title,
      ...(opts?.dueDate !== undefined ? { dueDate: opts.dueDate } : {}),
      ...(opts?.priority !== undefined ? { priority: opts.priority } : {}),
    },
  )
}

// Tasks are one-off only — recurrence lives on the Chores surface. The task
// `/series` create + list endpoints are no longer called from the UI; the
// update/delete helpers below remain so a legacy task series surfaced in
// My Day / Upcoming can still be edited or removed via SeriesEdit.
export async function deleteTaskSeries(listId: string, seriesId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/series/${encodeURIComponent(seriesId)}`,
  )
}

export async function updateTaskSeries(
  listId: string,
  seriesId: string,
  patch: UpdateTaskSeriesInput,
): Promise<TaskSeriesDto> {
  return request<TaskSeriesDto>(
    'PATCH',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/series/${encodeURIComponent(seriesId)}`,
    patch,
  )
}

export async function getRecurring(date: string, tz: string): Promise<RecurringResponse> {
  const q = new URLSearchParams({ date, tz })
  return request<RecurringResponse>('GET', `/api/v1/ui/recurring?${q.toString()}`)
}

export async function setTaskItemCompleted(
  listId: string,
  itemId: string,
  completed: boolean,
): Promise<TaskItemDto> {
  return request<TaskItemDto>(
    'PATCH',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}?tz=${encodeURIComponent(taskTz())}`,
    { completed },
  )
}

// Patch the editable first-class columns of a task item (title / priority /
// dueDate). Same PATCH endpoint as setTaskItemCompleted. dueDate accepts an
// ISO string, or null/'' to clear.
export async function updateTaskItem(
  listId: string,
  itemId: string,
  patch: { title?: string; priority?: string | null; dueDate?: string | null },
): Promise<TaskItemDto> {
  return request<TaskItemDto>(
    'PATCH',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}?tz=${encodeURIComponent(taskTz())}`,
    patch,
  )
}

export async function deleteTaskItem(listId: string, itemId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
  )
}

// --- shopping lists (issue #420) ------------------------------------
// Mirror the planner-api BFF responses, which pass the Lists SDK DTOs
// through verbatim (camelCase). The BFF owns scope + listType; the client
// sends only user-facing fields (name/color for lists, title for items).
// The auto-assigned category lives in customFields['rp:category'] and is
// readable verbatim. Override via PATCH { customFields: { 'rp:category': '<cat>' } }.

// Shopping category constants — canonical source is @rallypoint/lists-shared.
// Re-exported here under the names the rest of planner-web imports so call
// sites don't need to be updated.
export {
  CATEGORY_KEY,
  CATEGORY_LABELS as SHOPPING_CATEGORY_LABELS,
  CATEGORY_ORDER as SHOPPING_CATEGORY_ORDER,
} from '@rallypoint/lists-shared'
export type { Category as ShoppingCategory } from '@rallypoint/lists-shared'

// A shopping list row (same shape as TaskListDto).
export type ShoppingListDto = TaskListDto

// A shopping item — same shape as TaskItemDto but status/priority are always
// null; customFields['rp:category'] carries the shopping category.
export type ShoppingItemDto = TaskItemDto

// Resolve (auto-provision) the caller's single system-managed shopping list.
// The BFF creates it on first call; subsequent calls return the same list.
export async function getShoppingList(): Promise<ShoppingListDto> {
  return request<ShoppingListDto>('GET', '/api/v1/ui/shopping/list')
}

export async function listShoppingItems(listId: string): Promise<ShoppingItemDto[]> {
  return request<ShoppingItemDto[]>(
    'GET',
    `/api/v1/ui/shopping/${encodeURIComponent(listId)}/items`,
  )
}

export async function createShoppingItem(listId: string, title: string): Promise<ShoppingItemDto> {
  return request<ShoppingItemDto>(
    'POST',
    `/api/v1/ui/shopping/${encodeURIComponent(listId)}/items`,
    { title },
  )
}

export async function updateShoppingItem(
  listId: string,
  itemId: string,
  patch: { completed?: boolean; title?: string; customFields?: Record<string, unknown> },
): Promise<ShoppingItemDto> {
  return request<ShoppingItemDto>(
    'PATCH',
    `/api/v1/ui/shopping/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    patch,
  )
}

export async function deleteShoppingItem(listId: string, itemId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/shopping/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
  )
}

// --- chores list (#546) ---------------------------------------------
// A single system-managed `chores`-type list per user holding recurring
// household items. Mirrors the shopping helpers but, like tasks, chores items
// carry dueDate + priority and chores supports recurring series. The BFF owns
// scope + listType; the client sends only user-facing fields.

// A chores list row (same shape as TaskListDto).
export type ChoreListDto = TaskListDto

// A chores item — tasks-shaped (carries dueDate + priority), seriesId set when
// it is an occurrence of a recurring chore.
export type ChoreItemDto = TaskItemDto

// Resolve (auto-provision) the caller's single system-managed chores list.
export async function getChoresList(): Promise<ChoreListDto> {
  return request<ChoreListDto>('GET', '/api/v1/ui/chores/list')
}

export async function listChoreItems(listId: string): Promise<ChoreItemDto[]> {
  // Pass the browser tz so the BFF resolves each recurring occurrence's floating
  // due into a genuine instant (the single resolver); the client renders it with
  // plain local formatters and never re-anchors.
  return request<ChoreItemDto[]>(
    'GET',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/items?tz=${encodeURIComponent(taskTz())}`,
  )
}

export async function createChoreItem(
  listId: string,
  title: string,
  opts?: { dueDate?: string | null; priority?: string | null },
): Promise<ChoreItemDto> {
  return request<ChoreItemDto>('POST', `/api/v1/ui/chores/${encodeURIComponent(listId)}/items`, {
    title,
    ...(opts?.dueDate !== undefined ? { dueDate: opts.dueDate } : {}),
    ...(opts?.priority !== undefined ? { priority: opts.priority } : {}),
  })
}

export async function setChoreItemCompleted(
  listId: string,
  itemId: string,
  completed: boolean,
): Promise<ChoreItemDto> {
  return request<ChoreItemDto>(
    'PATCH',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    { completed },
  )
}

export async function deleteChoreItem(listId: string, itemId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
  )
}

export async function listChoreSeries(listId: string): Promise<TaskSeriesDto[]> {
  return request<TaskSeriesDto[]>('GET', `/api/v1/ui/chores/${encodeURIComponent(listId)}/series`)
}

export async function createChoreSeries(
  listId: string,
  input: CreateTaskSeriesInput,
): Promise<TaskSeriesDto> {
  return request<TaskSeriesDto>(
    'POST',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/series?tz=${encodeURIComponent(taskTz())}`,
    input,
  )
}

export async function deleteChoreSeries(listId: string, seriesId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/series/${encodeURIComponent(seriesId)}`,
  )
}

export async function updateChoreSeries(
  listId: string,
  seriesId: string,
  patch: UpdateTaskSeriesInput,
): Promise<TaskSeriesDto> {
  return request<TaskSeriesDto>(
    'PATCH',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/series/${encodeURIComponent(seriesId)}?tz=${encodeURIComponent(taskTz())}`,
    patch,
  )
}

// --- diary (Phase B, capture-only) ----------------------------------
// A single system-managed `diary`-type list per user. Entries are generic list
// items: title = a heading (defaults to the entry date), notes = the body,
// dueDate = the entry's day, customFields = mood + arbitrary metrics. Only the
// diary-list provisioner is diary-specific; entry + field CRUD reuse the
// generic /api/v1/ui/lists/:listId/{items,fields} endpoints.

// A diary list row (same shape as a task list).
export type DiaryListDto = TaskListDto
// A diary entry — a generic list item.
export type DiaryEntryDto = TaskItemDto

// Resolve (auto-provision + seed a default Mood field) the caller's diary list.
export async function getDiaryList(): Promise<DiaryListDto> {
  return request<DiaryListDto>('GET', '/api/v1/ui/diary/list')
}

export async function listDiaryEntries(listId: string): Promise<DiaryEntryDto[]> {
  return request<DiaryEntryDto[]>('GET', `/api/v1/ui/lists/${encodeURIComponent(listId)}/items`)
}

export interface DiaryEntryInput {
  title?: string
  notes?: string | null
  dueDate?: string | null
  customFields?: Record<string, unknown>
}

export async function createDiaryEntry(
  listId: string,
  input: DiaryEntryInput,
): Promise<DiaryEntryDto> {
  return request<DiaryEntryDto>(
    'POST',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items`,
    input,
  )
}

export async function updateDiaryEntry(
  listId: string,
  itemId: string,
  patch: DiaryEntryInput,
): Promise<DiaryEntryDto> {
  return request<DiaryEntryDto>(
    'PATCH',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    patch,
  )
}

export async function deleteDiaryEntry(listId: string, itemId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
  )
}

// --- chores feed setting (#546) -------------------------------------
// Whether chores items appear in My Day & Upcoming. Stored in the 'planner'
// settings namespace; absent → true (ON by default). Pure read/derive of the
// settings blob is unit-tested in chores-helpers.test.ts. Keep in lockstep
// with the BFF mirror `SETTING_SHOW_CHORES_IN_FEEDS` in
// apps/planner-api/src/lib/chores-feed.ts (separate build targets, same string).
export const SHOW_CHORES_IN_FEEDS_KEY = 'showChoresInFeeds'

// Whether the user has enabled push notifications. Stored in the 'planner'
// settings namespace; absent → false (OFF until the user opts in + grants
// browser permission). The actual delivery gate is the presence of a
// registered push_subscriptions row; this flag drives the Settings toggle's
// remembered state across devices.
export const PUSH_NOTIFICATIONS_KEY = 'pushNotificationsEnabled'

// --- weather unit setting -------------------------------------------
// Temperature unit for the My Day weather strip. Stored in the 'planner'
// settings namespace; absent → 'fahrenheit' (default). Only an explicit
// 'celsius' switches to Celsius. Pure read is unit-tested in
// weather-helpers.test.ts.
export const WEATHER_UNIT_KEY = 'weatherUnit'

// --- personal events + tickets (slice 7) ----------------------------
// Mirror the planner-api BFF responses, which pass the Events SDK DTOs
// through verbatim (camelCase). The BFF owns scope + actor; the client only
// sends user-facing fields.

export interface PersonalEventDto {
  id: string
  name: string
  description: string | null
  startAt: string | null
  endAt: string | null
  /** Issue #545: true = all-day event; false = timed. Resolved server-side with inference fallback. */
  allDay: boolean
  timezone: string
  locationLabel: string | null
  // Number of tickets attached to this event (Events SDK, Phase B). Drives
  // the "Ticket" chip on My Day / Upcoming and the rail badge on Events.
  ticketCount: number
  /** Platform where the ticket was purchased (e.g. 'ticketmaster'), or null. */
  ticketPlatform: string | null
  /** Account email used to purchase the ticket, or null. */
  ticketAccountEmail: string | null
  createdAt: string
}

export interface TicketDto {
  id: string
  eventId: string
  contentType: string
  bytes: number
  fileName: string | null
  uploadedAt: string
}

export interface CreatePersonalEventInput {
  name: string
  description?: string
  startAt?: string
  endAt?: string
  locationLabel?: string
  ticketPlatform?: string
  ticketAccountEmail?: string
  /** Issue #545: true = all-day; false = timed; omit to let server infer. */
  allDay?: boolean
}

export async function listPersonalEvents(): Promise<PersonalEventDto[]> {
  return request<PersonalEventDto[]>('GET', '/api/v1/ui/events')
}

export async function createPersonalEvent(
  input: CreatePersonalEventInput,
): Promise<PersonalEventDto> {
  return request<PersonalEventDto>('POST', '/api/v1/ui/events', input)
}

// Sparse edit of an owned personal event. Omit a field to leave it; pass
// null to clear a nullable one (startAt/endAt/locationLabel/description/
// ticketPlatform/ticketAccountEmail).
export interface UpdatePersonalEventInput {
  name?: string
  description?: string | null
  startAt?: string | null
  endAt?: string | null
  locationLabel?: string | null
  ticketPlatform?: string | null
  ticketAccountEmail?: string | null
  /** Issue #545: true = all-day; false = timed; null reverts to inference. */
  allDay?: boolean | null
}

export async function updatePersonalEvent(
  eventId: string,
  patch: UpdatePersonalEventInput,
): Promise<PersonalEventDto> {
  return request<PersonalEventDto>(
    'PATCH',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}`,
    patch,
  )
}

export async function deletePersonalEvent(eventId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${encodeURIComponent(eventId)}`)
}

export async function listTickets(eventId: string): Promise<TicketDto[]> {
  return request<TicketDto[]>('GET', `/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets`)
}

// Single same-origin multipart upload (#409): the BFF streams the file to
// events-api via its R2 binding. No presign, no cross-origin PUT. Mirrors
// events-web's uploadMap.
export async function uploadTicket(eventId: string, file: File): Promise<TicketDto> {
  const csrfToken = await client.fetchCsrf()
  const formData = new FormData()
  formData.append('file', file)
  formData.append('fileName', file.name)

  const res = await fetch(`/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'X-RP-CSRF': csrfToken },
    credentials: 'include',
    body: formData,
  })
  if (!res.ok) {
    let code = 'upload_failed'
    let message = `Upload failed (${res.status}).`
    try {
      const err = (await res.json()) as { error?: { code?: string; message?: string } }
      if (err.error?.code) code = err.error.code
      if (err.error?.message) message = err.error.message
    } catch {
      // ignore JSON parse failure
    }
    throw new ApiError(code, message, res.status)
  }
  return (await res.json()) as TicketDto
}

// The download route streams the bytes through the BFF (same-origin,
// credentialed) — `window.open` of this URL fetches it with the session
// cookie. No presigned URL anymore.
export function getTicketDownloadUrl(eventId: string, ticketId: string): string {
  return `/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets/${encodeURIComponent(ticketId)}/download`
}

// --- My Day (slice 8) -----------------------------------------------
// A roll-up of the tasks due today and personal events starting today,
// resolved in the caller's local timezone. The browser supplies its local
// `date` + IANA `tz`; the BFF returns the Lists/Events DTOs verbatim, so these
// interfaces describe only the fields the UI reads.

export interface MyDayTask {
  id: string
  listId: string
  title: string
  completed: boolean
  priority: string | null
  dueDate: string | null
  // Non-null when the task is an occurrence of a recurring series; the UI
  // badges these "Repeats". Forwarded verbatim from the Lists ListItemDto.
  seriesId: string | null
  // Lists v2 typed custom-field values, keyed by field-def id. Rendered as
  // chips where present.
  customFields: Record<string, unknown>
}

export interface MyDayEvent {
  id: string
  name: string
  startAt: string | null
  endAt: string | null
  /** Issue #545: true = all-day event; false = timed. Server-resolved. */
  allDay: boolean
  locationLabel: string | null
  // Tickets attached to the event (Phase B); drives the "Ticket" chip.
  ticketCount: number
  /** Platform where the ticket was purchased (e.g. 'ticketmaster'), or null. */
  ticketPlatform: string | null
  /** Account email used to purchase the ticket, or null. */
  ticketAccountEmail: string | null
}

// A single day of a group (festival) event the actor owns / collaborates on /
// attends, folded in by the BFF (mirrors planner-api's EventDayItem). One group
// event expands to one of these per day. `startTime`/`endTime` are wall-clock
// 'HH:MM[:SS]' in the event's day, both null = all-day. `owned` is
// server-stamped (actor owns the event in RP Events) and gates the edit pencil.
export interface EventDayDto {
  eventId: string
  slug: string
  name: string
  scopeType: string
  date: string
  dayLabel: string
  startTime: string | null
  endTime: string | null
  owned: boolean
  /** True when the event is a planner-flagged group event not otherwise reachable. */
  shared?: boolean
}

export interface MyDay {
  date: string
  timezone: string
  tasks: MyDayTask[]
  // Tasks with no dueDate; priority asc (high first) then title. Always
  // present (possibly empty []) — the server never omits this field.
  undatedTasks: MyDayTask[]
  events: MyDayEvent[]
  // Group event days falling on the day, all-day first (additive; [] when the
  // events fold-in degraded).
  eventDays: EventDayDto[]
}

export async function getMyDay(date: string, tz: string): Promise<MyDay> {
  const q = new URLSearchParams({ date, tz })
  return request<MyDay>('GET', `/api/v1/ui/my-day?${q.toString()}`)
}

// --- weather (Phase C) ----------------------------------------------
// My Day weather strip. The browser supplies the user's lat/lng (geolocation);
// planner-api proxies the events-api coordinate forecast (Open-Meteo). Nothing
// is stored. Only the fields the strip renders are typed here.

export interface WeatherForecast {
  units: { temperature: 'C'; precipitation: 'mm'; windSpeed: 'km/h' }
  current: {
    temperature: number | null
    apparentTemperature: number | null
    windSpeed: number | null
    weatherCode: number | null
    isDay: boolean | null
  } | null
  daily: Array<{
    date: string
    temperatureMax: number | null
    temperatureMin: number | null
    precipitationProbabilityMax: number | null
    uvIndexMax: number | null
    weatherCode: number | null
  }>
  // Opt-in per-hour series (the My Day coordinate endpoint requests it). Only
  // the fields the hourly strip renders are typed here.
  hourly?: Array<{
    time: string
    temperature: number | null
    uvIndex: number | null
    weatherCode: number | null
    isDay: boolean | null
    precipitationProbability: number | null
  }>
}

export interface WeatherResponse {
  forecast: WeatherForecast | null
  airQuality: unknown | null
}

export async function getMyDayWeather(
  lat: number,
  lng: number,
  tz: string,
  date?: string,
): Promise<WeatherResponse> {
  const q = new URLSearchParams({ lat: String(lat), lng: String(lng), tz })
  if (date) q.set('date', date)
  return request<WeatherResponse>('GET', `/api/v1/ui/my-day/weather?${q.toString()}`)
}

// --- Upcoming (slice 9) ---------------------------------------------
// A forward-looking, date-sorted merge of tasks + personal events. Items
// carrying a date at/after the start of the caller's local day land in
// `dated` (soonest first); items with no date float into `undated`. The BFF
// returns a discriminated union so the UI can render each kind; the wrapped
// DTOs are the same Lists/Events shapes as elsewhere.

export type UpcomingItem =
  | { kind: 'task'; task: MyDayTask }
  | { kind: 'event'; event: MyDayEvent }
  | { kind: 'eventDay'; eventDay: EventDayDto }
  | { kind: 'holiday'; holiday: HolidayDto }

export interface Upcoming {
  date: string
  timezone: string
  dated: UpcomingItem[]
  undated: UpcomingItem[]
}

export async function getUpcoming(date: string, tz: string): Promise<Upcoming> {
  const q = new URLSearchParams({ date, tz })
  return request<Upcoming>('GET', `/api/v1/ui/upcoming?${q.toString()}`)
}

// --- quick notes ----------------------------------------------------
// Notes live in Lists as items of a hidden per-user `notes` list (see the
// notes BFF). A note maps onto the generic item columns: `title` is the
// heading, `notes` the free-form body. The BFF owns the list resolution;
// the client only sends/reads these user-facing fields.

export interface NoteDto {
  id: string
  title: string
  notes: string | null
  createdAt: string
  // The folder (notes list) this note lives in. Always present on the
  // cross-folder GET; the BFF tags every note with its folder (#549).
  folderId: string
}

// A notes folder = a per-user notes-type list. The oldest is the undeletable
// default 'Notes' folder (isDefault).
export interface NoteFolderDto {
  id: string
  name: string
  createdAt: string
  isDefault: boolean
}

export interface CreateNoteInput {
  title: string
  notes?: string
}

// `folderId` scopes the read to a single folder; omit for notes across all.
export async function listNotes(folderId?: string): Promise<NoteDto[]> {
  const qs = folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''
  return request<NoteDto[]>('GET', `/api/v1/ui/notes${qs}`)
}

export async function createNote(input: CreateNoteInput): Promise<NoteDto> {
  return request<NoteDto>('POST', '/api/v1/ui/notes', input)
}

// `folderId` in the patch moves the note to another folder.
export async function updateNote(
  itemId: string,
  patch: { title?: string; notes?: string | null; folderId?: string },
): Promise<NoteDto> {
  return request<NoteDto>('PATCH', `/api/v1/ui/notes/${encodeURIComponent(itemId)}`, patch)
}

export async function deleteNote(itemId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/notes/${encodeURIComponent(itemId)}`)
}

// --- notes folders --------------------------------------------------

export async function listNoteFolders(): Promise<NoteFolderDto[]> {
  return request<NoteFolderDto[]>('GET', '/api/v1/ui/notes/folders')
}

export async function createNoteFolder(name: string): Promise<NoteFolderDto> {
  return request<NoteFolderDto>('POST', '/api/v1/ui/notes/folders', { name })
}

export async function deleteNoteFolder(folderId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/notes/folders/${encodeURIComponent(folderId)}`)
}

export async function moveNote(itemId: string, folderId: string): Promise<NoteDto> {
  return updateNote(itemId, { folderId })
}

// --- US federal holidays (#548) ------------------------------------
// Planner settings keys for holiday visibility.
export const HOLIDAYS_ENABLED_KEY = 'holidaysEnabled'
export const HIDDEN_HOLIDAYS_KEY = 'hiddenHolidays'

export interface HolidayDto {
  id: string
  name: string
  date: string // YYYY-MM-DD canonical date
  observedDate: string // YYYY-MM-DD with Sat→Fri, Sun→Mon shift
}

export async function listHolidays(from: string, to: string): Promise<HolidayDto[]> {
  const res = await request<{ holidays: HolidayDto[] }>(
    'GET',
    `/api/v1/ui/holidays?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  )
  return res.holidays
}
