// Typed planner-api client. The CSRF/transport machinery lives in
// @rallypoint/web-kit's createCsrfClient; this module keeps only the
// session/SSO layer — there are no domain-specific DTOs in slice 5.
// All calls go through the Vite dev proxy (and the production reverse
// proxy) at /api/v1/ui/*, always with credentials:'include' so the
// session + CSRF cookies ride along.

import { ApiError, captureEvent, createCsrfClient, resetAnalytics } from '@rallypoint/web-kit'
import type { ImportSummary } from '@rallypoint/lists-shared'
import type { SessionProfile } from '@rallypoint/web-kit'
import { hydrateThemeFromServer } from '@rallypoint/ui'
import {
  cachedFetch,
  getOfflineUser,
  mutateCachedArray,
  peekCache,
  readSession,
  setOfflineUser,
  writeCachedValue,
  writeSession,
} from './offline/cache.js'
import { bindPlannerApi, engine, enqueueOp, pendingOps } from './offline/engine.js'
import {
  distinctAffectedSurfaces,
  newTempId,
  type NoteSnapshot,
  type OutboxOp,
} from './offline/outbox-ops.js'
import {
  applyGlobalOpsToItems,
  applyOpsToDeletedNotes,
  applyOpsToItems,
} from './offline/outbox-reducers.js'
import { applySettingsPatch, mergeItemPatch } from './offline/merge.js'
import { warmCacheIfStale, type WarmerDeps } from './offline/cache-warmer.js'
import { purgeOfflineUser } from './offline/hooks.js'
import type { CachedQuery } from './offline/use-cached-query.js'
import { AI_ANALYSIS_FIELD_LABEL, findAnalysisField } from './braindump-helpers.js'

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

// Window event AppChrome listens for: the background session revalidation
// got a 401/403, so the app must kick the SSO bounce. Dispatched instead
// of calling session.beginSso() directly to avoid an api.ts ↔ session.ts
// circular import.
export const SESSION_REVOKED_EVENT = 'planner:session-revoked'

export async function getSession(): Promise<SessionDto> {
  // Instant boot: when a cached SessionDto exists (bootOfflineUser opened
  // the per-user DB from localStorage before any render), resolve it
  // immediately so RequireSession flips to authenticated in one frame —
  // no "Checking your session…" gate on the network. A background probe
  // then revalidates: 401/403 fires SESSION_REVOKED_EVENT (SSO bounce),
  // a different user_id purges the stale user's cache and reloads.
  // Accepted tradeoff: a revoked session shows cached UI for ~1 RTT
  // before bouncing — same behaviour as a native app.
  const cached = await readSession<SessionDto>('current')
  if (cached) {
    applySessionSideEffects(cached)
    void revalidateSession(cached)
    return cached
  }

  // Cold cache (first visit / post-signout): today's blocking behaviour.
  // The probe doubles as the offline-user bootstrap: a success sets the
  // userId (opens the per-user IndexedDB) and caches the SessionDto so
  // the next boot takes the instant path above. Failures — including a
  // 401/403 session-revoked — bubble up so RequireSession's SSO bounce
  // fires exactly as before.
  const session = await request<SessionDto>('GET', '/api/v1/ui/session')
  setOfflineUser(session.user_id)
  void writeSession('current', session)
  applySessionSideEffects(session)
  // Fire-and-forget the full-cache warmer (E4 O3 follow-up). On a
  // cold install or after a 7-day silence it pulls the full read
  // surface in the background so an immediate "DevTools Offline"
  // toggle finds every page populated, not just My Day.
  void warmCacheIfStale(warmerBindings())
  return session
}

// Background half of the instant boot: re-probe the server and reconcile.
async function revalidateSession(cached: SessionDto): Promise<void> {
  try {
    const session = await request<SessionDto>('GET', '/api/v1/ui/session')
    if (session.user_id !== cached.user_id) {
      // The cookie now belongs to a different account (signed in elsewhere
      // on this device). Purge the previous user's offline state — same
      // dispose-flusher-first hygiene as signout — and reload so every
      // module re-derives state from the new session.
      await purgeOfflineUser(cached.user_id)
      setOfflineUser(session.user_id)
      await writeSession('current', session)
      window.location.reload()
      return
    }
    setOfflineUser(session.user_id)
    void writeSession('current', session)
    applySessionSideEffects(session)
    void warmCacheIfStale(warmerBindings())
  } catch (err) {
    if (isTransportOrServerError(err)) return // offline / server sick — keep cached UI
    // 401/403: the session is genuinely revoked. Let the chrome bounce.
    window.dispatchEvent(new Event(SESSION_REVOKED_EVENT))
  }
}

function isTransportOrServerError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return true
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number') return true
  return status >= 500
}

function applySessionSideEffects(session: SessionDto): void {
  // Side-effect: apply the server's theme before the first authed render
  // so the preference follows the user across devices/apps. Does not echo
  // a write back (hydrateThemeFromServer suppresses the persister).
  if (session.settings) {
    hydrateThemeFromServer({
      mode: session.settings.themeMode,
      color: session.settings.themeColor,
    })
  }
}

// Read the full settings document for a namespace. Used by the Settings page
// to load existing preferences on mount without a full session refresh.
export async function getSettings(namespace: string): Promise<Record<string, unknown>> {
  return cachedFetch('settings', namespace, async () => {
    const res = await request<{ settings: Record<string, unknown> }>(
      'GET',
      `/api/v1/ui/settings/${encodeURIComponent(namespace)}`,
    )
    return res.settings
  })
}

// Persist a shallow patch into a settings namespace (a `null`-valued key
// deletes it). Used by the theme persister (registered in main.tsx) and
// the Settings page. Returns the merged doc. Local-first: the merged doc
// comes back immediately from the cached copy + patch; the PATCH rides
// the outbox (successive patches per namespace coalesce into one).
export async function updateSettings(
  namespace: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cached = (await peekCache<Record<string, unknown>>('settings', namespace))?.value ?? {}
  const merged = applySettingsPatch(cached, patch)
  if (!(await tryEnqueue({ type: 'settings:update', namespace, patch }))) {
    return remoteUpdateSettings(namespace, patch)
  }
  await writeCachedValue('settings', namespace, merged)
  return merged
}

async function remoteUpdateSettings(
  namespace: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request<{ settings: Record<string, unknown> }>(
    'PATCH',
    `/api/v1/ui/settings/${encodeURIComponent(namespace)}`,
    patch,
  )
  await writeCachedValue('settings', namespace, res.settings)
  return res.settings
}

export async function exchangeSso(code: string, state: string): Promise<void> {
  await request<void>('POST', '/api/v1/ui/sso/exchange', { code, state })
}

// --- push notifications --------------------------------------------

// The canonical shape lives with the shared push self-heal, which builds
// these payloads; re-exported so callers keep importing it from here.
export type { PushSubscriptionPayload } from '@rallypoint/web-kit'
import type { PushSubscriptionPayload } from '@rallypoint/web-kit'

// Register (or refresh) the browser's Web Push subscription with planner-api.
// `source` separates a deliberate opt-in from the background self-heal, so
// the heal's effect is visible in analytics without a second event name.
export async function registerPushSubscription(
  sub: PushSubscriptionPayload,
  source: 'enable' | 'resync' = 'enable',
): Promise<void> {
  await request<void>('POST', '/api/v1/ui/push/subscription', sub)
  captureEvent('push_subscription_registered', { source })
}

// Does planner-api still hold a row for this endpoint? See the route
// comment in planner-api/src/routes/push.ts — a `false` here is the
// client's evidence that the subscription was reaped and must be cycled.
export async function verifyPushSubscription(endpoint: string): Promise<boolean> {
  const res = await request<{ registered: boolean }>(
    'POST',
    '/api/v1/ui/push/subscription/verify',
    { endpoint },
  )
  return res.registered
}

// Remove the browser's Web Push subscription (notifications turned off).
export async function removePushSubscription(endpoint: string): Promise<void> {
  await request<void>('DELETE', '/api/v1/ui/push/subscription', { endpoint })
  captureEvent('push_subscription_removed')
}

export interface TestPushResult {
  ok: boolean
  // The user has at least one registered device.
  registered: boolean
  // At least one device accepted the test push.
  delivered: boolean
}

// Send a test notification to the user's registered devices right now.
export async function sendTestPush(): Promise<TestPushResult> {
  return request<TestPushResult>('POST', '/api/v1/ui/push/test')
}

export async function signout(): Promise<void> {
  await request<void>('POST', '/api/v1/ui/signout')
  resetAnalytics()
}

// --- AI Assist (free-text / voice capture) --------------------------
// planner-api's /assist/parse is a STATELESS AI categorizer: it returns a
// structured suggestion and saves nothing. The actual save then goes through
// the existing create helpers (createTaskItem / createPersonalEvent /
// createNote / addShoppingItemByTitle / createDiaryEntry), so it inherits the
// offline outbox + notification behaviour. Parse itself is online-only (an AI
// round-trip has no meaningful offline form).

export type AssistCategory = 'task' | 'shopping' | 'event' | 'food' | 'note' | 'diary'
export type AssistConfidence = 'low' | 'medium' | 'high'

/** food only: one AI-estimated food with TOTAL macros for its amount. */
export interface AssistFoodItem {
  name: string
  grams: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
}

export interface AssistSuggestion {
  category: AssistCategory
  title: string
  notes: string | null
  /** event: ISO instant (timed) or local-midnight instant (all-day), else null */
  startAt: string | null
  endAt: string | null
  allDay: boolean
  /** task/diary: ISO instant (timed) or 'YYYY-MM-DD' (day-only), else null */
  dueDate: string | null
  /** diary only: 1..5, else null */
  mood: number | null
  /** food only: the items to log, else null */
  items: AssistFoodItem[] | null
  confidence: AssistConfidence
  /**
   * Set when the confidence is low BECAUSE a date was lost or looks wrong
   * (rather than the model being unsure about the category). A backwards-
   * resolved date arrives WITH a startAt, so the fields alone can't say.
   */
  dateUncertain: boolean
  /** Trace ids for the feedback echo. */
  traceId: string
  responseId: string
}

export interface AssistRequestInput {
  text: string
  clientNow: string
  tz: string
}

// Categorize a free-text capture. Throws ApiError (422 = unusable model
// output → the caller falls back to the manual quick-add form; 503 = AI
// unavailable).
export async function parseAssist(input: AssistRequestInput): Promise<AssistSuggestion> {
  return request<AssistSuggestion>('POST', '/api/v1/ui/assist/parse', input)
}

export type AssistVerdict = 'accepted' | 'edited' | 'rejected'

// Record what the user did with a suggestion (accepted as-is / edited before
// saving / undone). Advisory + fire-and-forget: swallow every error so a
// trace-store hiccup never surfaces to the user.
export async function sendAssistFeedback(
  responseId: string,
  verdict: AssistVerdict,
  edited?: unknown,
): Promise<void> {
  try {
    await request<{ ok: boolean }>('POST', '/api/v1/ui/assist/feedback', {
      responseId,
      verdict,
      ...(edited !== undefined ? { edited } : {}),
    })
  } catch {
    // best-effort telemetry — never block the UI on it
  }
}

// A `food` suggestion saves into the FITNESS food diary through the
// planner-api write proxy (service-binding RPC to fitness-api) — planner
// stores no food data. Online-only, like the parse itself: there is no
// outbox story for a cross-app write, and the parse already needed the
// network. The subset of fitness's FoodLogEntryDto we read back.
export interface FitnessFoodLogEntry {
  id: string
  name: string
  kcal: number
}

export interface CreateFitnessFoodLogInput {
  loggedAt: string
  name: string
  quantityGrams: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  source: 'text'
  scanResponseId?: string
}

export async function createFitnessFoodLog(
  input: CreateFitnessFoodLogInput,
): Promise<FitnessFoodLogEntry> {
  return request<FitnessFoodLogEntry>('POST', '/api/v1/ui/fitness/food-log', input)
}

export async function deleteFitnessFoodLog(id: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/fitness/food-log/${encodeURIComponent(id)}`)
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
  return cachedFetch('fieldDefs', listId, () =>
    request<FieldDefDto[]>('GET', `/api/v1/ui/lists/${encodeURIComponent(listId)}/fields`),
  )
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

// Resolve-or-create the "AI Analysis" text field on an arbitrary list (used
// to analyze legacy diary entries in place). braindump-helpers.ts only
// `import type`s DTO shapes from this module — that's erased at compile
// time, so pulling its runtime AI_ANALYSIS_FIELD_LABEL/findAnalysisField
// back in here is a type-only cycle, not a real one (a real runtime cycle
// would explode immediately on import).
export async function ensureAnalysisField(listId: string): Promise<FieldDefDto> {
  const defs = await listFieldDefs(listId)
  const existing = findAnalysisField(defs)
  if (existing) return existing
  return createFieldDef(listId, { label: AI_ANALYSIS_FIELD_LABEL, fieldType: 'text' })
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
  // Client idempotency key for offline outbox retries (buildSend passes
  // op.tmpId here); the whole input rides through to planner-api as the
  // POST body, so a create that timed out post-commit dedups on retry.
  ref?: string
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
  return cachedFetch('taskLists', 'all', () =>
    request<TaskListDto[]>('GET', '/api/v1/ui/lists'),
  )
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
  const tz = taskTz()
  return cachedFetch(
    'taskItems',
    `${listId}|${tz}`,
    () =>
      request<TaskItemDto[]>(
        'GET',
        `/api/v1/ui/lists/${encodeURIComponent(listId)}/items?tz=${encodeURIComponent(tz)}`,
      ),
    { rebase: (fresh) => rebaseItemsRead(listId, fresh) },
  )
}

// The browser's IANA timezone, appended to task writes as `?tz=` so the BFF
// can tell a timed due from a day-only one and schedule notifications.
function taskTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

// --- local-first write plumbing ---------------------------------------
// Every task/shopping/chore mutation goes through the outbox regardless
// of connectivity (one write path): patch the read cache, enqueue, return
// a merged synth immediately. The engine flushes the queue right away
// when online, so the server sees the write within the same tick — the
// UI just doesn't wait for it.

// Re-apply queued ops on top of a fresh server response so a refetch
// racing a not-yet-flushed write can't wipe the optimistic rows.
async function rebaseItemsRead<T extends { id: string }>(
  listId: string,
  fresh: T[],
): Promise<T[]> {
  const userId = getOfflineUser()
  if (!userId) return fresh
  const queued = await pendingOps(userId)
  if (!queued.length) return fresh
  return applyOpsToItems(fresh, queued, listId)
}

// App-wide-surface variant of the rebase (notes 'all' channel, personal
// events) — the ops carry no listId, so they're matched by family.
async function rebaseGlobalRead<T extends { id: string }>(
  family: 'note' | 'event',
  fresh: T[],
): Promise<T[]> {
  const userId = getOfflineUser()
  if (!userId) return fresh
  const queued = await pendingOps(userId)
  if (!queued.length) return fresh
  return applyGlobalOpsToItems(fresh, queued, family)
}

async function rebaseDeletedNotesRead<T extends { id: string }>(fresh: T[]): Promise<T[]> {
  const userId = getOfflineUser()
  if (!userId) return fresh
  const queued = await pendingOps(userId)
  if (!queued.length) return fresh
  return applyOpsToDeletedNotes(fresh, queued)
}

// Enqueue an op for the active user. Returns false when there is no
// active user or the queue is unavailable (IndexedDB blocked) — callers
// fall back to the direct request/response path.
async function tryEnqueue(op: OutboxOp): Promise<boolean> {
  const userId = getOfflineUser()
  if (!userId) return false
  try {
    await enqueueOp(userId, op)
    return true
  } catch {
    return false
  }
}

// Refetch the item surfaces a batch of ops touched. Runs after the
// outbox drains (reconciles tmp ids → real ids and server-computed
// fields: shopping category, BFF tz-resolved dues) and after a hard op
// failure (restores server truth so the optimistic change visibly
// reverts). Each reader rewrites the cache, which notifies subscribers.
export async function reconcileOpSurfaces(ops: OutboxOp[]): Promise<void> {
  await Promise.all(
    distinctAffectedSurfaces(ops).map(async (s) => {
      try {
        switch (s.kind) {
          case 'task':
            await listTaskItems(s.listId)
            break
          case 'shopping':
            await listShoppingItems(s.listId)
            break
          case 'chore':
            await listChoreItems(s.listId)
            break
          case 'notes':
            await Promise.all([listNotes(), listDeletedNotes()])
            break
          case 'diary':
            await listDiaryEntries(s.listId)
            break
          case 'event':
            await listPersonalEvents()
            break
          case 'series':
            // The server materializes occurrences; pull both the rules
            // and the item list so new occurrences show up right away.
            await Promise.all([listChoreSeries(s.listId), listChoreItems(s.listId)])
            break
          case 'settings':
            await getSettings(s.listId /* = namespace */)
            break
        }
      } catch {
        // Best-effort: the next page-driven read reconciles instead.
      }
    }),
  )
}

// Direct request/response variant — the outbox flusher replays through
// this (bindPlannerApi below), and the public fn falls back to it when
// no user is active or the queue is unavailable. Routing the flusher
// through the public local-first fn would re-enqueue and recurse.
async function remoteCreateTaskItem(
  listId: string,
  title: string,
  opts?: {
    dueDate?: string | null
    priority?: string | null
    notes?: string | null
    ref?: string
  },
): Promise<TaskItemDto> {
  const dto = await request<TaskItemDto>(
    'POST',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items?tz=${encodeURIComponent(taskTz())}`,
    {
      title,
      ...(opts?.dueDate !== undefined ? { dueDate: opts.dueDate } : {}),
      ...(opts?.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts?.notes !== undefined ? { notes: opts.notes } : {}),
      ...(opts?.ref != null ? { ref: opts.ref } : {}),
    },
  )
  // Keep the cached items in sync so a subsequent offline reload reflects
  // the just-created item without a network round-trip.
  await mutateCachedArray<TaskItemDto>('taskItems', `${listId}|${taskTz()}`, (items) => [
    ...items,
    dto,
  ])
  return dto
}

export async function createTaskItem(
  listId: string,
  title: string,
  opts?: { dueDate?: string | null; priority?: string | null; notes?: string | null },
): Promise<TaskItemDto> {
  const tmpId = newTempId()
  const synth: TaskItemDto = {
    id: tmpId,
    listId,
    title,
    notes: opts?.notes ?? null,
    completed: false,
    status: null,
    priority: opts?.priority ?? null,
    dueDate: opts?.dueDate ?? null,
    position: 0,
    seriesId: null,
    customFields: {},
    createdAt: new Date().toISOString(),
  }
  captureEvent('task_created', {
    has_due_date: Boolean(opts?.dueDate),
    has_priority: Boolean(opts?.priority),
  })
  if (!(await tryEnqueue({ type: 'task:create', listId, tmpId, title, ...opts }))) {
    return remoteCreateTaskItem(listId, title, opts)
  }
  await mutateCachedArray<TaskItemDto>('taskItems', `${listId}|${taskTz()}`, (items) => [
    ...items,
    synth,
  ])
  return synth
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
  return cachedFetch('recurring', `${date}|${tz}`, () => {
    const q = new URLSearchParams({ date, tz })
    return request<RecurringResponse>('GET', `/api/v1/ui/recurring?${q.toString()}`)
  })
}

export async function setTaskItemCompleted(
  listId: string,
  itemId: string,
  completed: boolean,
): Promise<TaskItemDto> {
  if (completed) captureEvent('task_completed')
  return applyTaskItemPatch(listId, itemId, { completed })
}

// Patch the editable first-class columns of a task item (title / priority /
// dueDate). Same PATCH endpoint as setTaskItemCompleted. dueDate accepts an
// ISO string, or null/'' to clear.
export async function updateTaskItem(
  listId: string,
  itemId: string,
  patch: { title?: string; priority?: string | null; dueDate?: string | null },
): Promise<TaskItemDto> {
  return applyTaskItemPatch(listId, itemId, patch)
}

// Shared local-first PATCH path for task items (check-off + field edits
// share one outbox op shape, so rapid toggle+rename coalesce in-queue).
async function applyTaskItemPatch(
  listId: string,
  itemId: string,
  patch: {
    title?: string
    priority?: string | null
    dueDate?: string | null
    completed?: boolean
  },
): Promise<TaskItemDto> {
  const key = `${listId}|${taskTz()}`
  const cached = (await peekCache<TaskItemDto[]>('taskItems', key))?.value.find(
    (i) => i.id === itemId,
  )
  const synth = mergeItemPatch<TaskItemDto>(
    cached,
    { id: itemId, listId } as Partial<TaskItemDto> & { id: string },
    patch as Partial<TaskItemDto>,
  )
  if (!(await tryEnqueue({ type: 'task:update', listId, itemId, patch }))) {
    return remoteUpdateTaskItem(listId, itemId, patch)
  }
  await mutateCachedArray<TaskItemDto>('taskItems', key, (items) =>
    items.map((i) => (i.id === itemId ? synth : i)),
  )
  return synth
}

async function remoteUpdateTaskItem(
  listId: string,
  itemId: string,
  patch: Record<string, unknown>,
): Promise<TaskItemDto> {
  const dto = await request<TaskItemDto>(
    'PATCH',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}?tz=${encodeURIComponent(taskTz())}`,
    patch,
  )
  await mutateCachedArray<TaskItemDto>('taskItems', `${listId}|${taskTz()}`, (items) =>
    items.map((i) => (i.id === itemId ? dto : i)),
  )
  return dto
}

export async function deleteTaskItem(listId: string, itemId: string): Promise<void> {
  if (!(await tryEnqueue({ type: 'task:delete', listId, itemId }))) {
    return remoteDeleteTaskItem(listId, itemId)
  }
  await mutateCachedArray<TaskItemDto>('taskItems', `${listId}|${taskTz()}`, (items) =>
    items.filter((i) => i.id !== itemId),
  )
}

async function remoteDeleteTaskItem(listId: string, itemId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
  )
  await mutateCachedArray<TaskItemDto>('taskItems', `${listId}|${taskTz()}`, (items) =>
    items.filter((i) => i.id !== itemId),
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

// A shopping list row (TaskListDto plus the quantity field pointer).
//
// `quantityFieldId` is the id of the list's `quantity` custom-field def,
// provisioned by the BFF on first access. Item quantities live in the
// generic customFields blob, which is keyed by def id — so this is the key
// to read and write. Optional on the wire: a response cached before this
// shipped has no such key, and null means the BFF couldn't resolve the def.
// Either way the client hides the quantity chip and editor until a refresh
// supplies one.
export type ShoppingListDto = TaskListDto & {
  quantityFieldId?: string | null
}

// A shopping item — same shape as TaskItemDto but status/priority are always
// null; customFields['rp:category'] carries the shopping category.
export type ShoppingItemDto = TaskItemDto

// Resolve (auto-provision) the caller's single system-managed shopping list.
// The BFF creates it on first call; subsequent calls return the same list.
export async function getShoppingList(): Promise<ShoppingListDto> {
  return cachedFetch('shoppingList', 'current', () =>
    request<ShoppingListDto>('GET', '/api/v1/ui/shopping/list'),
  )
}

export async function listShoppingItems(listId: string): Promise<ShoppingItemDto[]> {
  return cachedFetch(
    'shoppingItems',
    listId,
    () =>
      request<ShoppingItemDto[]>(
        'GET',
        `/api/v1/ui/shopping/${encodeURIComponent(listId)}/items`,
      ),
    { rebase: (fresh) => rebaseItemsRead(listId, fresh) },
  )
}

async function remoteCreateShoppingItem(
  listId: string,
  title: string,
  opts?: { ref?: string },
): Promise<ShoppingItemDto> {
  const dto = await request<ShoppingItemDto>(
    'POST',
    `/api/v1/ui/shopping/${encodeURIComponent(listId)}/items`,
    { title, ...(opts?.ref != null ? { ref: opts.ref } : {}) },
  )
  await mutateCachedArray<ShoppingItemDto>('shoppingItems', listId, (items) => [...items, dto])
  return dto
}

export async function createShoppingItem(listId: string, title: string): Promise<ShoppingItemDto> {
  const tmpId = newTempId()
  const synth: ShoppingItemDto = {
    id: tmpId,
    listId,
    title,
    completed: false,
    customFields: {},
    createdAt: new Date().toISOString(),
  } as ShoppingItemDto
  captureEvent('shopping_item_added')
  if (!(await tryEnqueue({ type: 'shopping:create', listId, tmpId, title }))) {
    return remoteCreateShoppingItem(listId, title)
  }
  await mutateCachedArray<ShoppingItemDto>('shoppingItems', listId, (items) => [...items, synth])
  return synth
}

export async function updateShoppingItem(
  listId: string,
  itemId: string,
  patch: { completed?: boolean; title?: string; customFields?: Record<string, unknown> },
): Promise<ShoppingItemDto> {
  const cached = (await peekCache<ShoppingItemDto[]>('shoppingItems', listId))?.value.find(
    (i) => i.id === itemId,
  )
  const synth = mergeItemPatch<ShoppingItemDto>(
    cached,
    { id: itemId, listId } as Partial<ShoppingItemDto> & { id: string },
    patch as Partial<ShoppingItemDto>,
  )
  if (!(await tryEnqueue({ type: 'shopping:update', listId, itemId, patch }))) {
    return remoteUpdateShoppingItem(listId, itemId, patch)
  }
  await mutateCachedArray<ShoppingItemDto>('shoppingItems', listId, (items) =>
    items.map((i) => (i.id === itemId ? synth : i)),
  )
  return synth
}

async function remoteUpdateShoppingItem(
  listId: string,
  itemId: string,
  patch: Record<string, unknown>,
): Promise<ShoppingItemDto> {
  const dto = await request<ShoppingItemDto>(
    'PATCH',
    `/api/v1/ui/shopping/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    patch,
  )
  await mutateCachedArray<ShoppingItemDto>('shoppingItems', listId, (items) =>
    items.map((i) => (i.id === itemId ? dto : i)),
  )
  return dto
}

export async function deleteShoppingItem(listId: string, itemId: string): Promise<void> {
  if (!(await tryEnqueue({ type: 'shopping:delete', listId, itemId }))) {
    return remoteDeleteShoppingItem(listId, itemId)
  }
  await mutateCachedArray<ShoppingItemDto>('shoppingItems', listId, (items) =>
    items.filter((i) => i.id !== itemId),
  )
}

async function remoteDeleteShoppingItem(listId: string, itemId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/shopping/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
  )
  await mutateCachedArray<ShoppingItemDto>('shoppingItems', listId, (items) =>
    items.filter((i) => i.id !== itemId),
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
  return cachedFetch('choresList', 'current', () =>
    request<ChoreListDto>('GET', '/api/v1/ui/chores/list'),
  )
}

export async function listChoreItems(listId: string): Promise<ChoreItemDto[]> {
  // Pass the browser tz so the BFF resolves each recurring occurrence's floating
  // due into a genuine instant (the single resolver); the client renders it with
  // plain local formatters and never re-anchors.
  const tz = taskTz()
  return cachedFetch(
    'choreItems',
    `${listId}|${tz}`,
    () =>
      request<ChoreItemDto[]>(
        'GET',
        `/api/v1/ui/chores/${encodeURIComponent(listId)}/items?tz=${encodeURIComponent(tz)}`,
      ),
    { rebase: (fresh) => rebaseItemsRead(listId, fresh) },
  )
}

async function remoteCreateChoreItem(
  listId: string,
  title: string,
  opts?: { dueDate?: string | null; priority?: string | null; ref?: string },
): Promise<ChoreItemDto> {
  const dto = await request<ChoreItemDto>(
    'POST',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/items`,
    {
      title,
      ...(opts?.dueDate !== undefined ? { dueDate: opts.dueDate } : {}),
      ...(opts?.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts?.ref != null ? { ref: opts.ref } : {}),
    },
  )
  await mutateCachedArray<ChoreItemDto>('choreItems', `${listId}|${taskTz()}`, (items) => [
    ...items,
    dto,
  ])
  return dto
}

export async function createChoreItem(
  listId: string,
  title: string,
  opts?: { dueDate?: string | null; priority?: string | null },
): Promise<ChoreItemDto> {
  const tmpId = newTempId()
  const synth: ChoreItemDto = {
    id: tmpId,
    listId,
    title,
    notes: null,
    completed: false,
    status: null,
    priority: opts?.priority ?? null,
    dueDate: opts?.dueDate ?? null,
    position: 0,
    seriesId: null,
    customFields: {},
    createdAt: new Date().toISOString(),
  }
  if (!(await tryEnqueue({ type: 'chore:create', listId, tmpId, title, ...opts }))) {
    return remoteCreateChoreItem(listId, title, opts)
  }
  await mutateCachedArray<ChoreItemDto>('choreItems', `${listId}|${taskTz()}`, (items) => [
    ...items,
    synth,
  ])
  return synth
}

export async function setChoreItemCompleted(
  listId: string,
  itemId: string,
  completed: boolean,
): Promise<ChoreItemDto> {
  if (completed) captureEvent('chore_completed')
  const key = `${listId}|${taskTz()}`
  const cached = (await peekCache<ChoreItemDto[]>('choreItems', key))?.value.find(
    (i) => i.id === itemId,
  )
  const synth = mergeItemPatch<ChoreItemDto>(
    cached,
    { id: itemId, listId } as Partial<ChoreItemDto> & { id: string },
    { completed } as Partial<ChoreItemDto>,
  )
  if (!(await tryEnqueue({ type: 'chore:update', listId, itemId, patch: { completed } }))) {
    return remoteSetChoreItemCompleted(listId, itemId, completed)
  }
  await mutateCachedArray<ChoreItemDto>('choreItems', key, (items) =>
    items.map((i) => (i.id === itemId ? synth : i)),
  )
  return synth
}

async function remoteSetChoreItemCompleted(
  listId: string,
  itemId: string,
  completed: boolean,
): Promise<ChoreItemDto> {
  const dto = await request<ChoreItemDto>(
    'PATCH',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    { completed },
  )
  await mutateCachedArray<ChoreItemDto>('choreItems', `${listId}|${taskTz()}`, (items) =>
    items.map((i) => (i.id === itemId ? dto : i)),
  )
  return dto
}

export async function deleteChoreItem(listId: string, itemId: string): Promise<void> {
  if (!(await tryEnqueue({ type: 'chore:delete', listId, itemId }))) {
    return remoteDeleteChoreItem(listId, itemId)
  }
  await mutateCachedArray<ChoreItemDto>('choreItems', `${listId}|${taskTz()}`, (items) =>
    items.filter((i) => i.id !== itemId),
  )
}

async function remoteDeleteChoreItem(listId: string, itemId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
  )
  await mutateCachedArray<ChoreItemDto>('choreItems', `${listId}|${taskTz()}`, (items) =>
    items.filter((i) => i.id !== itemId),
  )
}

export async function listChoreSeries(listId: string): Promise<TaskSeriesDto[]> {
  return cachedFetch(
    'choreSeries',
    listId,
    () =>
      request<TaskSeriesDto[]>('GET', `/api/v1/ui/chores/${encodeURIComponent(listId)}/series`),
    { rebase: (fresh) => rebaseItemsRead(listId, fresh) },
  )
}

// Chore series are local-first like items, but the server materially
// transforms the write (it materializes occurrences into the chore item
// list), so the optimistic row is a best-effort preview of the series
// RULE only — the onDrained reconcile refetches both the series and the
// items so occurrences appear as soon as the create/update flushes.
export async function createChoreSeries(
  listId: string,
  input: CreateTaskSeriesInput,
): Promise<TaskSeriesDto> {
  const tmpId = newTempId()
  const synth: TaskSeriesDto = {
    id: tmpId,
    listId,
    title: input.title,
    notes: null,
    priority: null,
    freq: input.freq,
    interval: input.interval,
    byDay: input.byDay ?? null,
    dtstart: input.dtstart,
    until: input.until ?? null,
    count: input.count ?? null,
    timeOfDay: input.timeOfDay ?? null,
    createdAt: new Date().toISOString(),
  }
  captureEvent('chore_series_created', { freq: input.freq, has_time_of_day: Boolean(input.timeOfDay) })
  if (
    !(await tryEnqueue({
      type: 'series:create',
      listId,
      tmpId,
      input: input as unknown as Record<string, unknown>,
    }))
  ) {
    return remoteCreateChoreSeries(listId, input)
  }
  await mutateCachedArray<TaskSeriesDto>('choreSeries', listId, (rows) => [...rows, synth])
  return synth
}

async function remoteCreateChoreSeries(
  listId: string,
  input: CreateTaskSeriesInput,
): Promise<TaskSeriesDto> {
  const dto = await request<TaskSeriesDto>(
    'POST',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/series?tz=${encodeURIComponent(taskTz())}`,
    input,
  )
  await mutateCachedArray<TaskSeriesDto>('choreSeries', listId, (rows) => [...rows, dto])
  return dto
}

export async function deleteChoreSeries(listId: string, seriesId: string): Promise<void> {
  if (!(await tryEnqueue({ type: 'series:delete', listId, seriesId }))) {
    return remoteDeleteChoreSeries(listId, seriesId)
  }
  await mutateCachedArray<TaskSeriesDto>('choreSeries', listId, (rows) =>
    rows.filter((s) => s.id !== seriesId),
  )
}

async function remoteDeleteChoreSeries(listId: string, seriesId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/series/${encodeURIComponent(seriesId)}`,
  )
  await mutateCachedArray<TaskSeriesDto>('choreSeries', listId, (rows) =>
    rows.filter((s) => s.id !== seriesId),
  )
}

export async function updateChoreSeries(
  listId: string,
  seriesId: string,
  patch: UpdateTaskSeriesInput,
): Promise<TaskSeriesDto> {
  const cached = (await peekCache<TaskSeriesDto[]>('choreSeries', listId))?.value.find(
    (s) => s.id === seriesId,
  )
  const synth = mergeItemPatch<TaskSeriesDto>(
    cached,
    { id: seriesId, listId } as Partial<TaskSeriesDto> & { id: string },
    patch as Partial<TaskSeriesDto>,
  )
  if (
    !(await tryEnqueue({
      type: 'series:update',
      listId,
      seriesId,
      patch: patch as unknown as Record<string, unknown>,
    }))
  ) {
    return remoteUpdateChoreSeries(listId, seriesId, patch)
  }
  await mutateCachedArray<TaskSeriesDto>('choreSeries', listId, (rows) =>
    rows.map((s) => (s.id === seriesId ? synth : s)),
  )
  return synth
}

async function remoteUpdateChoreSeries(
  listId: string,
  seriesId: string,
  patch: UpdateTaskSeriesInput,
): Promise<TaskSeriesDto> {
  const dto = await request<TaskSeriesDto>(
    'PATCH',
    `/api/v1/ui/chores/${encodeURIComponent(listId)}/series/${encodeURIComponent(seriesId)}?tz=${encodeURIComponent(taskTz())}`,
    patch,
  )
  await mutateCachedArray<TaskSeriesDto>('choreSeries', listId, (rows) =>
    rows.map((s) => (s.id === seriesId ? dto : s)),
  )
  return dto
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
  return cachedFetch('diaryList', 'current', () =>
    request<DiaryListDto>('GET', '/api/v1/ui/diary/list'),
  )
}

export async function listDiaryEntries(listId: string): Promise<DiaryEntryDto[]> {
  return cachedFetch(
    'diaryEntries',
    listId,
    () => request<DiaryEntryDto[]>('GET', `/api/v1/ui/lists/${encodeURIComponent(listId)}/items`),
    { rebase: (fresh) => rebaseItemsRead(listId, fresh) },
  )
}

export interface DiaryEntryInput {
  title?: string
  notes?: string | null
  dueDate?: string | null
  customFields?: Record<string, unknown>
  // Client idempotency key for offline outbox retries (buildSend passes
  // op.tmpId here); rides through to planner-api as the POST body.
  ref?: string
}

export async function createDiaryEntry(
  listId: string,
  input: DiaryEntryInput,
): Promise<DiaryEntryDto> {
  const tmpId = newTempId()
  const synth: DiaryEntryDto = {
    id: tmpId,
    listId,
    title: input.title ?? '',
    notes: input.notes ?? null,
    completed: false,
    status: null,
    priority: null,
    dueDate: input.dueDate ?? null,
    position: 0,
    seriesId: null,
    customFields: input.customFields ?? {},
    createdAt: new Date().toISOString(),
  }
  captureEvent('diary_entry_created')
  if (!(await tryEnqueue({ type: 'diary:create', listId, tmpId, input }))) {
    return remoteCreateDiaryEntry(listId, input)
  }
  await mutateCachedArray<DiaryEntryDto>('diaryEntries', listId, (items) => [...items, synth])
  return synth
}

async function remoteCreateDiaryEntry(
  listId: string,
  input: DiaryEntryInput,
): Promise<DiaryEntryDto> {
  const dto = await request<DiaryEntryDto>(
    'POST',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items`,
    input,
  )
  await mutateCachedArray<DiaryEntryDto>('diaryEntries', listId, (items) => [...items, dto])
  return dto
}

export async function updateDiaryEntry(
  listId: string,
  itemId: string,
  patch: DiaryEntryInput,
): Promise<DiaryEntryDto> {
  const cached = (await peekCache<DiaryEntryDto[]>('diaryEntries', listId))?.value.find(
    (i) => i.id === itemId,
  )
  const synth = mergeItemPatch<DiaryEntryDto>(
    cached,
    { id: itemId, listId } as Partial<DiaryEntryDto> & { id: string },
    patch as Partial<DiaryEntryDto>,
  )
  if (!(await tryEnqueue({ type: 'diary:update', listId, itemId, patch }))) {
    return remoteUpdateDiaryEntry(listId, itemId, patch)
  }
  await mutateCachedArray<DiaryEntryDto>('diaryEntries', listId, (items) =>
    items.map((i) => (i.id === itemId ? synth : i)),
  )
  return synth
}

async function remoteUpdateDiaryEntry(
  listId: string,
  itemId: string,
  patch: DiaryEntryInput,
): Promise<DiaryEntryDto> {
  const dto = await request<DiaryEntryDto>(
    'PATCH',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    patch,
  )
  await mutateCachedArray<DiaryEntryDto>('diaryEntries', listId, (items) =>
    items.map((i) => (i.id === itemId ? dto : i)),
  )
  return dto
}

// Save an AI-analysis blob onto an arbitrary list item's custom fields,
// bypassing updateDiaryEntry deliberately: analyzing a legacy diary entry is
// online-only (enrichBraindump already is), so this skips the offline
// outbox op and the optimistic cache mutation — the caller refetches once
// the save resolves. Callers must pass ONLY the analysis field's own key
// (e.g. `{ [def.id]: encoded }`), never the full customFields map spread —
// the lists API merges patch keys over the stored map server-side (see
// apps/lists-api/src/services/rpc-core.ts), so re-sending the whole map
// risks reverting a concurrent edit from a stale client cache, or 400ing on
// a field def that's since been deleted.
export async function saveEntryAnalysis(
  listId: string,
  itemId: string,
  customFields: Record<string, unknown>,
): Promise<void> {
  await request<DiaryEntryDto>(
    'PATCH',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    { customFields },
  )
}

// Create a list item directly against the server, bypassing the offline
// outbox and optimistic cache mutation — deliberately, like
// saveEntryAnalysis above: online-only, caller refetches once the create
// resolves. Needed wherever a create must be server-confirmed before a
// dependent step runs (e.g. converting a note into a braindump entry, where
// deleteNote must not fire until the replacement entry actually exists) —
// createDiaryEntry's outbox path would return a synthetic tmp-id row and
// let the caller race ahead of the real save.
// Pass `input.ref` as the server-side idempotency key (same role as the
// outbox's tmpId): a retry after a lost response re-resolves to the
// already-created row instead of duplicating it. Deliberately no cache
// write and no analytics event (unlike createDiaryEntry) — the caller
// refetches.
export async function createEntryDirect(
  listId: string,
  input: DiaryEntryInput,
): Promise<DiaryEntryDto> {
  return request<DiaryEntryDto>(
    'POST',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items`,
    input,
  )
}

export async function deleteDiaryEntry(listId: string, itemId: string): Promise<void> {
  if (!(await tryEnqueue({ type: 'diary:delete', listId, itemId }))) {
    return remoteDeleteDiaryEntry(listId, itemId)
  }
  await mutateCachedArray<DiaryEntryDto>('diaryEntries', listId, (items) =>
    items.filter((i) => i.id !== itemId),
  )
}

async function remoteDeleteDiaryEntry(listId: string, itemId: string): Promise<void> {
  await request<void>(
    'DELETE',
    `/api/v1/ui/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
  )
  await mutateCachedArray<DiaryEntryDto>('diaryEntries', listId, (items) =>
    items.filter((i) => i.id !== itemId),
  )
}

// --- brain dump ------------------------------------------------------
// One free-text capture surface replacing the separate Diary/Notes tools. A
// single system-managed `braindump`-type list per user; entries are generic
// list items (title = AI heading, notes = the dump body, dueDate = capture
// day) with the AI category + analysis riding the seeded custom fields.
//
// Entry CRUD deliberately REUSES the diary helpers + `diary:*` outbox ops:
// those are generic /lists/:listId/items CRUD keyed by listId (nothing in
// them is diary-specific), so the braindump list inherits the offline outbox,
// reconcile and tmp-id resolution for free instead of duplicating the whole
// op family. Entries cache in the `diaryEntries` table keyed by listId, same
// as any other dated list.
//
// Enrichment (categorize + themes/entities/summary + task/event suggestions)
// and range summaries are STATELESS online-only AI calls (assist pattern):
// the server saves nothing; the client writes results through the entry
// create/update path above.

export type BraindumpListDto = TaskListDto
export type BraindumpEntryDto = DiaryEntryDto
export type BraindumpEntryInput = DiaryEntryInput

// Resolve (auto-provision + seed Category / AI Analysis fields) the caller's
// brain-dump list.
export async function getBraindumpList(): Promise<BraindumpListDto> {
  return cachedFetch('braindumpList', 'current', () =>
    request<BraindumpListDto>('GET', '/api/v1/ui/braindump/list'),
  )
}

// Generic item CRUD on the braindump list — see the reuse note above.
export const listBraindumpEntries = listDiaryEntries
export const createBraindumpEntry = createDiaryEntry
export const updateBraindumpEntry = updateDiaryEntry
export const deleteBraindumpEntry = deleteDiaryEntry

export const BRAINDUMP_CATEGORIES = [
  'Ideas',
  'Feelings',
  'Work',
  'Health',
  'People',
  'Plans',
  'Journal',
  'Reference',
  'Other',
] as const
export type BraindumpCategory = (typeof BRAINDUMP_CATEGORIES)[number]

export interface BraindumpEntity {
  name: string
  kind: 'person' | 'place' | 'topic'
}

export interface BraindumpTaskSuggestion {
  title: string
  /** ISO instant (timed) or 'YYYY-MM-DD' (day-only), else null */
  dueDate: string | null
}

export interface BraindumpEventSuggestion {
  title: string
  startAt: string | null
  endAt: string | null
  allDay: boolean
}

export interface BraindumpEnrichment {
  category: BraindumpCategory
  title: string
  themes: string[]
  entities: BraindumpEntity[]
  summary: string | null
  taskSuggestions: BraindumpTaskSuggestion[]
  eventSuggestions: BraindumpEventSuggestion[]
  /** Trace ids for the feedback echo (sendAssistFeedback). */
  traceId: string
  responseId: string
}

export interface EnrichBraindumpInput extends AssistRequestInput {
  /** Existing theme/entity labels so the model reuses them instead of
   * inventing near-duplicates ("skin" vs "skin issues"). */
  knownConcepts?: string[]
}

// Analyze one dump. Throws ApiError (422 = unusable model output — the entry
// stays saved un-analyzed, retryable via the per-entry Analyze affordance;
// 503 = AI unavailable). Online-only, like parseAssist.
export async function enrichBraindump(input: EnrichBraindumpInput): Promise<BraindumpEnrichment> {
  return request<BraindumpEnrichment>('POST', '/api/v1/ui/braindump/enrich', input)
}

export interface BraindumpSummaryEntry {
  date: string
  category: string | null
  text: string
}

export interface BraindumpRangeSummary {
  summary: string
  highlights: string[]
  moodTrend: string | null
  traceId: string
  responseId: string
}

// Summarize a date range of entries (the caller sends the capped corpus —
// see selectEntriesForSummary in braindump-analytics.ts). Online-only.
export async function summarizeBraindump(
  entries: BraindumpSummaryEntry[],
): Promise<BraindumpRangeSummary> {
  return request<BraindumpRangeSummary>('POST', '/api/v1/ui/braindump/summary', { entries })
}

// --- chores feed setting (#546) -------------------------------------
// Whether chores items appear in My Day & Upcoming. Stored in the 'planner'
// settings namespace; absent → true (ON by default). Pure read/derive of the
// settings blob is unit-tested in chores-helpers.test.ts. Keep in lockstep
// with the BFF mirror `SETTING_SHOW_CHORES_IN_FEEDS` in
// apps/planner-api/src/lib/chores-feed.ts (separate build targets, same string).
// Since the morning check-in feature, today's My Day chores section is always
// visible — this setting only gates Upcoming and the Week/Month future views.
export const SHOW_CHORES_IN_FEEDS_KEY = 'showChoresInFeeds'

// --- morning check-in setting --------------------------------------
// The local calendar date (YYYY-MM-DD) the user last completed (or dismissed)
// the morning check-in modal. Stored in the 'planner' settings namespace;
// absent → the modal opens on the next My Day visit. Compared against
// `localToday().date` so the gate matches the same tz Planner uses for the
// My Day fetch (see planner-helpers.localToday).
export const LAST_CHECKIN_DAY_KEY = 'lastCheckinDay'

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
  // Client idempotency key for offline outbox retries (buildSend passes
  // op.tmpId here); rides through to planner-api as the POST body.
  ref?: string
}

export async function listPersonalEvents(): Promise<PersonalEventDto[]> {
  return cachedFetch(
    'personalEvents',
    'all',
    () => request<PersonalEventDto[]>('GET', '/api/v1/ui/events'),
    { rebase: (fresh) => rebaseGlobalRead('event', fresh) },
  )
}

export async function createPersonalEvent(
  input: CreatePersonalEventInput,
): Promise<PersonalEventDto> {
  const tmpId = newTempId()
  const synth: PersonalEventDto = {
    id: tmpId,
    name: input.name,
    description: input.description ?? null,
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    // Best-effort preview of the server-side all-day inference: an
    // explicit flag wins; otherwise "no start time" reads as all-day.
    allDay: input.allDay ?? !input.startAt,
    timezone: taskTz(),
    locationLabel: input.locationLabel ?? null,
    ticketCount: 0,
    ticketPlatform: input.ticketPlatform ?? null,
    ticketAccountEmail: input.ticketAccountEmail ?? null,
    createdAt: new Date().toISOString(),
  }
  captureEvent('personal_event_created', {
    has_location: Boolean(input.locationLabel),
    has_ticket_platform: Boolean(input.ticketPlatform),
  })
  if (
    !(await tryEnqueue({
      type: 'event:create',
      tmpId,
      input: input as unknown as Record<string, unknown>,
    }))
  ) {
    return remoteCreatePersonalEvent(input)
  }
  await mutateCachedArray<PersonalEventDto>('personalEvents', 'all', (items) => [...items, synth])
  return synth
}

async function remoteCreatePersonalEvent(
  input: CreatePersonalEventInput,
): Promise<PersonalEventDto> {
  const dto = await request<PersonalEventDto>('POST', '/api/v1/ui/events', input)
  await mutateCachedArray<PersonalEventDto>('personalEvents', 'all', (items) => [...items, dto])
  return dto
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
  const cached = (await peekCache<PersonalEventDto[]>('personalEvents', 'all'))?.value.find(
    (e) => e.id === eventId,
  )
  const synth = mergeItemPatch<PersonalEventDto>(
    cached,
    { id: eventId } as Partial<PersonalEventDto> & { id: string },
    patch as Partial<PersonalEventDto>,
  )
  if (
    !(await tryEnqueue({
      type: 'event:update',
      eventId,
      patch: patch as unknown as Record<string, unknown>,
    }))
  ) {
    return remoteUpdatePersonalEvent(eventId, patch)
  }
  await mutateCachedArray<PersonalEventDto>('personalEvents', 'all', (items) =>
    items.map((e) => (e.id === eventId ? synth : e)),
  )
  return synth
}

async function remoteUpdatePersonalEvent(
  eventId: string,
  patch: UpdatePersonalEventInput,
): Promise<PersonalEventDto> {
  const dto = await request<PersonalEventDto>(
    'PATCH',
    `/api/v1/ui/events/${encodeURIComponent(eventId)}`,
    patch,
  )
  await mutateCachedArray<PersonalEventDto>('personalEvents', 'all', (items) =>
    items.map((e) => (e.id === eventId ? dto : e)),
  )
  return dto
}

export async function deletePersonalEvent(eventId: string): Promise<void> {
  if (!(await tryEnqueue({ type: 'event:delete', eventId }))) {
    return remoteDeletePersonalEvent(eventId)
  }
  await mutateCachedArray<PersonalEventDto>('personalEvents', 'all', (items) =>
    items.filter((e) => e.id !== eventId),
  )
}

async function remoteDeletePersonalEvent(eventId: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/events/${encodeURIComponent(eventId)}`)
  await mutateCachedArray<PersonalEventDto>('personalEvents', 'all', (items) =>
    items.filter((e) => e.id !== eventId),
  )
}

export async function listTickets(eventId: string): Promise<TicketDto[]> {
  return cachedFetch('tickets', eventId, () =>
    request<TicketDto[]>('GET', `/api/v1/ui/events/${encodeURIComponent(eventId)}/tickets`),
  )
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

// A single workout logged today, folded in by the planner BFF from fitness-api.
// Mirrors the WorkoutSummaryDto from @rallypoint/fitness-client / fitness-shared.
export interface WorkoutSummaryDto {
  id: string
  performedAt: string // ISO
  modality: string // e.g. 'strength', 'conditioning', 'endurance', 'class', 'mobility', 'mixed'
  title: string | null
  durationS: number | null
  setCount: number
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
  // Today's logged workouts from fitness-api (additive; [] when the fitness
  // fold-in degraded or the user has no workouts today).
  training: WorkoutSummaryDto[]
  // The actor's chores-list id, or null when no chores list exists yet.
  // Optional because older cached responses (IndexedDB offline cache) predate
  // the field — treat undefined like null.
  choresListId?: string | null
}

export async function getMyDay(date: string, tz: string): Promise<MyDay> {
  return cachedFetch('myDay', `${date}|${tz}`, () => {
    const q = new URLSearchParams({ date, tz })
    return request<MyDay>('GET', `/api/v1/ui/my-day?${q.toString()}`)
  })
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
  return cachedFetch('upcoming', `${date}|${tz}`, () => {
    const q = new URLSearchParams({ date, tz })
    return request<Upcoming>('GET', `/api/v1/ui/upcoming?${q.toString()}`)
  })
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
  completed: boolean
  completedAt: string | null
  createdAt: string
  // The folder (notes list) this note lives in. Always present on the
  // cross-folder GET; the BFF tags every note with its folder (#549).
  folderId: string
}

export interface DeletedNoteDto extends NoteDto {
  deletedAt: string
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
  // Client idempotency key for offline outbox retries (buildSend passes
  // op.tmpId here); remoteCreateNote forwards the whole input object as
  // the POST body, so this rides straight through to planner-api.
  ref?: string
}

// `folderId` scopes the read to a single folder; omit for notes across all.
export async function listNotes(folderId?: string): Promise<NoteDto[]> {
  return cachedFetch(
    'notes',
    folderId ?? 'all',
    () => {
      const qs = folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''
      return request<NoteDto[]>('GET', `/api/v1/ui/notes${qs}`)
    },
    // Only the cross-folder read rebases: the ops don't carry folder
    // scope, so a folder-scoped refetch racing a pending write self-heals
    // via the onDrained reconcile instead.
    {
      rebase: async (fresh) => {
        const rebased = await rebaseGlobalRead('note', fresh)
        return folderId ? rebased.filter((note) => note.folderId === folderId) : rebased
      },
    },
  )
}

export async function listDeletedNotes(): Promise<DeletedNoteDto[]> {
  return cachedFetch(
    'notes',
    'deleted',
    () => request<DeletedNoteDto[]>('GET', '/api/v1/ui/notes/deleted'),
    { rebase: rebaseDeletedNotesRead },
  )
}

// Apply a mutator to every notes cache channel a note can appear on: the
// cross-folder 'all' read plus any folder-scoped reads involved.
async function mutateNoteCaches(
  folderIds: (string | undefined)[],
  mutator: (items: NoteDto[]) => NoteDto[],
): Promise<void> {
  const keys = new Set<string>(['all'])
  for (const f of folderIds) if (f) keys.add(f)
  await Promise.all([...keys].map((k) => mutateCachedArray<NoteDto>('notes', k, mutator)))
}

async function findCachedNote(itemId: string): Promise<NoteDto | undefined> {
  return (await peekCache<NoteDto[]>('notes', 'all'))?.value.find((n) => n.id === itemId)
}

async function findCachedDeletedNote(itemId: string): Promise<DeletedNoteDto | undefined> {
  return (await peekCache<DeletedNoteDto[]>('notes', 'deleted'))?.value.find(
    (n) => n.id === itemId,
  )
}

function noteSnapshot(note: NoteDto): NoteSnapshot {
  return {
    id: note.id,
    title: note.title,
    notes: note.notes,
    folderId: note.folderId,
    completed: note.completed ?? false,
    completedAt: note.completedAt ?? null,
    createdAt: note.createdAt,
  }
}

export async function createNote(input: CreateNoteInput): Promise<NoteDto> {
  const tmpId = newTempId()
  // New notes land in the default folder (the BFF resolves it); mirror
  // that from the cached folder list so the tmp row groups correctly.
  const folders = (await peekCache<NoteFolderDto[]>('noteFolders', 'all'))?.value
  const folderId = folders?.find((f) => f.isDefault)?.id ?? ''
  const synth: NoteDto = {
    id: tmpId,
    title: input.title,
    notes: input.notes ?? null,
    completed: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
    folderId,
  }
  captureEvent('note_created')
  if (
    !(await tryEnqueue({
      type: 'note:create',
      tmpId,
      title: input.title,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    }))
  ) {
    return remoteCreateNote(input)
  }
  await mutateNoteCaches([folderId], (items) => [...items, synth])
  return synth
}

async function remoteCreateNote(input: CreateNoteInput): Promise<NoteDto> {
  const dto = await request<NoteDto>('POST', '/api/v1/ui/notes', input)
  await mutateNoteCaches([dto.folderId], (items) => [...items, dto])
  return dto
}

// `folderId` in the patch moves the note to another folder.
export async function updateNote(
  itemId: string,
  patch: { title?: string; notes?: string | null; folderId?: string; completed?: boolean },
): Promise<NoteDto> {
  const cached = await findCachedNote(itemId)
  const optimisticPatch = {
    ...patch,
    ...(patch.completed !== undefined
      ? { completedAt: patch.completed ? new Date().toISOString() : null }
      : {}),
  }
  const synth = mergeItemPatch<NoteDto>(
    cached,
    { id: itemId } as Partial<NoteDto> & { id: string },
    optimisticPatch as Partial<NoteDto>,
  )
  if (!(await tryEnqueue({ type: 'note:update', itemId, patch }))) {
    return remoteUpdateNote(itemId, patch)
  }
  const movedFrom = patch.folderId && cached?.folderId !== patch.folderId ? cached?.folderId : undefined
  // 'all' + the (possibly new) folder channel get the patched row; on a
  // move the source folder gets only the removal below — writing the
  // synth there first would flash the note back into its old folder.
  // Upsert: replace in place when present (keeps ordering), append when
  // absent (the target folder of a move hasn't seen this note yet).
  await mutateNoteCaches([movedFrom ? undefined : cached?.folderId, patch.folderId], (items) => {
    let found = false
    const next = items.map((n) => {
      if (n.id !== itemId) return n
      found = true
      return synth
    })
    return found ? next : [...items, synth]
  })
  if (movedFrom) {
    await mutateCachedArray<NoteDto>('notes', movedFrom, (items) =>
      items.filter((n) => n.id !== itemId),
    )
  }
  return synth
}

async function remoteUpdateNote(
  itemId: string,
  patch: { title?: string; notes?: string | null; folderId?: string; completed?: boolean },
): Promise<NoteDto> {
  const dto = await request<NoteDto>('PATCH', `/api/v1/ui/notes/${encodeURIComponent(itemId)}`, patch)
  await mutateNoteCaches([dto.folderId], (items) =>
    items.map((n) => (n.id === itemId ? dto : n)),
  )
  return dto
}

export async function deleteNote(itemId: string): Promise<void> {
  const cached = await findCachedNote(itemId)
  const snapshot = cached ? noteSnapshot(cached) : undefined
  const deletedAt = new Date().toISOString()
  if (
    !(await tryEnqueue({
      type: 'note:delete',
      itemId,
      ...(snapshot ? { snapshot } : {}),
      deletedAt,
    }))
  ) {
    return remoteDeleteNote(itemId, cached?.folderId, snapshot, deletedAt)
  }
  await mutateNoteCaches([cached?.folderId], (items) => items.filter((n) => n.id !== itemId))
  if (snapshot) {
    await mutateCachedArray<DeletedNoteDto>('notes', 'deleted', (items) => [
      { ...snapshot, deletedAt },
      ...items.filter((n) => n.id !== itemId),
    ])
  }
}

async function remoteDeleteNote(
  itemId: string,
  folderId?: string,
  snapshot?: NoteSnapshot,
  deletedAt = new Date().toISOString(),
): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/notes/${encodeURIComponent(itemId)}`)
  await mutateNoteCaches([folderId], (items) => items.filter((n) => n.id !== itemId))
  if (snapshot) {
    await mutateCachedArray<DeletedNoteDto>('notes', 'deleted', (items) => [
      { ...snapshot, deletedAt },
      ...items.filter((n) => n.id !== itemId),
    ])
  }
}

export async function restoreNote(itemId: string): Promise<NoteDto> {
  const deleted = await findCachedDeletedNote(itemId)
  const snapshot = deleted ? noteSnapshot(deleted) : undefined
  if (!snapshot || !(await tryEnqueue({ type: 'note:restore', itemId, snapshot }))) {
    return remoteRestoreNote(itemId)
  }
  await mutateCachedArray<DeletedNoteDto>('notes', 'deleted', (items) =>
    items.filter((n) => n.id !== itemId),
  )
  const restored: NoteDto = { ...snapshot }
  await mutateNoteCaches([restored.folderId], (items) => {
    const without = items.filter((n) => n.id !== itemId)
    return [...without, restored]
  })
  return restored
}

async function remoteRestoreNote(itemId: string): Promise<NoteDto> {
  const dto = await request<NoteDto>(
    'POST',
    `/api/v1/ui/notes/${encodeURIComponent(itemId)}/restore`,
  )
  await mutateCachedArray<DeletedNoteDto>('notes', 'deleted', (items) =>
    items.filter((n) => n.id !== itemId),
  )
  await mutateNoteCaches([dto.folderId], (items) => [
    ...items.filter((n) => n.id !== itemId),
    dto,
  ])
  return dto
}

// --- notes folders --------------------------------------------------

export async function listNoteFolders(): Promise<NoteFolderDto[]> {
  return cachedFetch('noteFolders', 'all', () =>
    request<NoteFolderDto[]>('GET', '/api/v1/ui/notes/folders'),
  )
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
  return cachedFetch('holidays', `${from}|${to}`, async () => {
    const res = await request<{ holidays: HolidayDto[] }>(
      'GET',
      `/api/v1/ui/holidays?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
    return res.holidays
  })
}

// --- cached-query descriptors (render-from-cache pages) --------------
// One descriptor per read surface: the cache channel a page subscribes
// to (table + key) plus the reader that refreshes it. The key expression
// MUST match the reader's cachedFetch key — api.queries.test.ts pins
// every pair so drift turns a silent dead-subscription into a red test.

export const settingsQuery = (ns: string): CachedQuery<Record<string, unknown>> => ({
  table: 'settings',
  key: ns,
  fetch: () => getSettings(ns),
})
export const fieldDefsQuery = (listId: string): CachedQuery<FieldDefDto[]> => ({
  table: 'fieldDefs',
  key: listId,
  fetch: () => listFieldDefs(listId),
})
export const taskListsQuery = (): CachedQuery<TaskListDto[]> => ({
  table: 'taskLists',
  key: 'all',
  fetch: () => listTaskLists(),
})
export const taskItemsQuery = (listId: string): CachedQuery<TaskItemDto[]> => ({
  table: 'taskItems',
  key: `${listId}|${taskTz()}`,
  fetch: () => listTaskItems(listId),
})
export const recurringQuery = (date: string, tz: string): CachedQuery<RecurringResponse> => ({
  table: 'recurring',
  key: `${date}|${tz}`,
  fetch: () => getRecurring(date, tz),
})
export const shoppingListQuery = (): CachedQuery<ShoppingListDto> => ({
  table: 'shoppingList',
  key: 'current',
  fetch: () => getShoppingList(),
})
export const shoppingItemsQuery = (listId: string): CachedQuery<ShoppingItemDto[]> => ({
  table: 'shoppingItems',
  key: listId,
  fetch: () => listShoppingItems(listId),
})
export const choresListQuery = (): CachedQuery<ChoreListDto> => ({
  table: 'choresList',
  key: 'current',
  fetch: () => getChoresList(),
})
export const choreItemsQuery = (listId: string): CachedQuery<ChoreItemDto[]> => ({
  table: 'choreItems',
  key: `${listId}|${taskTz()}`,
  fetch: () => listChoreItems(listId),
})
export const choreSeriesQuery = (listId: string): CachedQuery<TaskSeriesDto[]> => ({
  table: 'choreSeries',
  key: listId,
  fetch: () => listChoreSeries(listId),
})
export const diaryListQuery = (): CachedQuery<DiaryListDto> => ({
  table: 'diaryList',
  key: 'current',
  fetch: () => getDiaryList(),
})
export const diaryEntriesQuery = (listId: string): CachedQuery<DiaryEntryDto[]> => ({
  table: 'diaryEntries',
  key: listId,
  fetch: () => listDiaryEntries(listId),
})
export const braindumpListQuery = (): CachedQuery<BraindumpListDto> => ({
  table: 'braindumpList',
  key: 'current',
  fetch: () => getBraindumpList(),
})
// Braindump entries share the diaryEntries cache table (generic per-list
// items keyed by listId — see the brain dump section's reuse note).
export const braindumpEntriesQuery = (listId: string): CachedQuery<BraindumpEntryDto[]> => ({
  table: 'diaryEntries',
  key: listId,
  fetch: () => listBraindumpEntries(listId),
})
export const personalEventsQuery = (): CachedQuery<PersonalEventDto[]> => ({
  table: 'personalEvents',
  key: 'all',
  fetch: () => listPersonalEvents(),
})
export const ticketsQuery = (eventId: string): CachedQuery<TicketDto[]> => ({
  table: 'tickets',
  key: eventId,
  fetch: () => listTickets(eventId),
})
export const myDayQuery = (date: string, tz: string): CachedQuery<MyDay> => ({
  table: 'myDay',
  key: `${date}|${tz}`,
  fetch: () => getMyDay(date, tz),
})
export const upcomingQuery = (date: string, tz: string): CachedQuery<Upcoming> => ({
  table: 'upcoming',
  key: `${date}|${tz}`,
  fetch: () => getUpcoming(date, tz),
})
export const notesQuery = (folderId?: string): CachedQuery<NoteDto[]> => ({
  table: 'notes',
  key: folderId ?? 'all',
  fetch: () => listNotes(folderId),
})
export const deletedNotesQuery = (): CachedQuery<DeletedNoteDto[]> => ({
  table: 'notes',
  key: 'deleted',
  fetch: () => listDeletedNotes(),
})
export const noteFoldersQuery = (): CachedQuery<NoteFolderDto[]> => ({
  table: 'noteFolders',
  key: 'all',
  fetch: () => listNoteFolders(),
})
export const holidaysQuery = (from: string, to: string): CachedQuery<HolidayDto[]> => ({
  table: 'holidays',
  key: `${from}|${to}`,
  fetch: () => listHolidays(from, to),
})

// Bind the concrete planner-api mutations to the offline engine (E4 O4)
// so the OutboxFlusher can replay queued ops. MUST bind the remote*
// request/response variants, never the public local-first fns — those
// enqueue, so the flusher would re-enqueue its own replay and recurse.
bindPlannerApi({
  createTaskItem: (listId, title, opts) =>
    remoteCreateTaskItem(listId, title, opts).then((i) => ({ id: i.id })),
  updateTaskItem: (listId, itemId, patch) => remoteUpdateTaskItem(listId, itemId, patch),
  deleteTaskItem: remoteDeleteTaskItem,
  createShoppingItem: (listId, title, opts) =>
    remoteCreateShoppingItem(listId, title, opts).then((i) => ({ id: i.id })),
  updateShoppingItem: (listId, itemId, patch) => remoteUpdateShoppingItem(listId, itemId, patch),
  deleteShoppingItem: remoteDeleteShoppingItem,
  createChoreItem: (listId, title, opts) =>
    remoteCreateChoreItem(listId, title, opts).then((i) => ({ id: i.id })),
  setChoreItemCompleted: (listId, itemId, completed) =>
    remoteSetChoreItemCompleted(listId, itemId, completed),
  deleteChoreItem: remoteDeleteChoreItem,
  createNote: (input) => remoteCreateNote(input as CreateNoteInput).then((n) => ({ id: n.id })),
  updateNote: (itemId, patch) => remoteUpdateNote(itemId, patch),
  deleteNote: (itemId) => remoteDeleteNote(itemId),
  restoreNote: (itemId) => remoteRestoreNote(itemId),
  createDiaryEntry: (listId, input) =>
    remoteCreateDiaryEntry(listId, input as DiaryEntryInput).then((e) => ({ id: e.id })),
  updateDiaryEntry: (listId, itemId, patch) =>
    remoteUpdateDiaryEntry(listId, itemId, patch as DiaryEntryInput),
  deleteDiaryEntry: remoteDeleteDiaryEntry,
  createPersonalEvent: (input) =>
    remoteCreatePersonalEvent(input as unknown as CreatePersonalEventInput).then((e) => ({
      id: e.id,
    })),
  updatePersonalEvent: (eventId, patch) =>
    remoteUpdatePersonalEvent(eventId, patch as UpdatePersonalEventInput),
  deletePersonalEvent: remoteDeletePersonalEvent,
  createChoreSeries: (listId, input) =>
    remoteCreateChoreSeries(listId, input as unknown as CreateTaskSeriesInput).then((s) => ({
      id: s.id,
    })),
  updateChoreSeries: (listId, seriesId, patch) =>
    remoteUpdateChoreSeries(listId, seriesId, patch as UpdateTaskSeriesInput),
  deleteChoreSeries: remoteDeleteChoreSeries,
  updateSettings: (namespace, patch) => remoteUpdateSettings(namespace, patch),
})

// After a flush pass resolves ops, refetch the touched surfaces so
// server-computed fields (shopping category, tz-resolved chore dues) and
// real ids reconcile into the cache — subscribers re-render from it.
engine.onDrained = (resolvedOps) => {
  void reconcileOpSurfaces(resolvedOps)
}

// A hard-failed op (4xx rejection) leaves the cache holding an optimistic
// change the server refused — refetch the surface so it reverts on screen.
engine.reconcileFailedOp = (op) => {
  void reconcileOpSurfaces([op])
}

// After a *:create op replays online and we get the real server id, drop
// the optimistic tmp row from the matching read cache so the page
// doesn't see the same logical item twice (tmpId + serverId rows).
engine.onCreateResolved = async (op, _serverId) => {
  switch (op.type) {
    case 'task:create':
      await mutateCachedArray<TaskItemDto>('taskItems', `${op.listId}|${taskTz()}`, (items) =>
        items.filter((i) => i.id !== op.tmpId),
      )
      break
    case 'shopping:create':
      await mutateCachedArray<ShoppingItemDto>('shoppingItems', op.listId, (items) =>
        items.filter((i) => i.id !== op.tmpId),
      )
      break
    case 'chore:create':
      await mutateCachedArray<ChoreItemDto>('choreItems', `${op.listId}|${taskTz()}`, (items) =>
        items.filter((i) => i.id !== op.tmpId),
      )
      break
    case 'note:create': {
      // The tmp row may sit on 'all' plus a folder channel; drop it from
      // every notes channel we can see it on.
      const folders = (await peekCache<NoteFolderDto[]>('noteFolders', 'all'))?.value ?? []
      const keys = ['all', ...folders.map((f) => f.id)]
      await Promise.all(
        keys.map((k) =>
          mutateCachedArray<NoteDto>('notes', k, (items) => items.filter((n) => n.id !== op.tmpId)),
        ),
      )
      break
    }
    case 'diary:create':
      await mutateCachedArray<DiaryEntryDto>('diaryEntries', op.listId, (items) =>
        items.filter((i) => i.id !== op.tmpId),
      )
      break
    case 'event:create':
      await mutateCachedArray<PersonalEventDto>('personalEvents', 'all', (items) =>
        items.filter((e) => e.id !== op.tmpId),
      )
      break
    case 'series:create':
      await mutateCachedArray<TaskSeriesDto>('choreSeries', op.listId, (rows) =>
        rows.filter((s) => s.id !== op.tmpId),
      )
      break
  }
}

// Bindings for the cache warmer (E4 O3 follow-up). Declared at the
// bottom so every wrapped reader exists at evaluation time. Wrapped as
// a function so the const initializer doesn't run before the reader
// functions are in scope; getSession() invokes warmerBindings() lazily.
function warmerBindings(): WarmerDeps {
  return {
    getSettings,
    getMyDay,
    getUpcoming,
    getRecurring,
    listHolidays,
    listTaskLists,
    listTaskItems,
    listFieldDefs,
    getShoppingList,
    listShoppingItems,
    getChoresList,
    listChoreItems,
    listChoreSeries,
    getDiaryList,
    listDiaryEntries,
    getBraindumpList,
    listPersonalEvents,
    listTickets,
    listNoteFolders,
    listNotes,
  }
}

// --- data export / import (backup–restore) ---------------------------
// Both bypass `request()`: the export response is a ZIP, not JSON, and the
// import body is raw archive bytes rather than a JSON envelope.
//
// Deliberately NOT routed through the offline cache/outbox: an import is a
// bulk server-side write with no synthesizable local result, and an export
// must reflect server truth rather than whatever the local cache holds.

export async function exportPlannerData(): Promise<Blob> {
  const res = await fetch('/api/v1/ui/data-export', {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null
    throw new ApiError(
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? 'Could not export your data.',
      res.status,
    )
  }
  return await res.blob()
}

export async function importPlannerData(file: File | Blob): Promise<ImportSummary> {
  const res = await fetch('/api/v1/ui/data-import', {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-RP-CSRF': await client.fetchCsrf(),
      'Content-Type': 'application/zip',
    },
    body: file,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null
    throw new ApiError(
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? 'Could not import that archive.',
      res.status,
    )
  }
  return (await res.json()) as ImportSummary
}
