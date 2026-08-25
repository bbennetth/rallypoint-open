// Typed fitness-api client. The CSRF/transport machinery lives in
// @rallypoint/web-kit's createCsrfClient; this module keeps the
// fitness-specific typed DTO layer on top of it, plus the local-first
// write path: every mutation patches the per-user IndexedDB read cache,
// enqueues to the offline outbox, and returns a merged synth DTO
// immediately — the engine flushes to the network in the same tick when
// online, so the server sees the write right away; the UI just doesn't
// wait for it. Reads go through cachedFetch (network-first, cache
// fallback, subscriber notify) keyed by a canonical serialization of
// each read's filters.
//
// All calls go through the Vite dev proxy (and the production reverse
// proxy) at /api/v1/ui/*, always with credentials:'include' so the
// session + CSRF cookies ride along.

import { ApiError, captureEvent, createCsrfClient, resetAnalytics } from '@rallypoint/web-kit'
import type { ImportSummary } from '@rallypoint/fitness-shared'
import type { SessionProfile } from '@rallypoint/web-kit'
import { hydrateThemeFromServer } from '@rallypoint/ui'
import { applySettingsPatch, mergeItemPatch } from '@rallypoint/offline-kit'
import { hydrateWeightUnitFromServer } from './units.js'
import { hydrateDefaultRestFromServer } from './rest-settings.js'
import { hydrateDefaultRepsFromServer, hydrateDefaultSetsFromServer } from './set-defaults.js'
import { hydrateRestAlertsFromServer } from './alert-settings.js'
import { hydrateDayTypesFromServer } from './day-type-settings.js'
import { hydrateCalorieGoalFromServer } from './calorie-goal.js'
import {
  ALL_LIVE_SESSION_LS_KEYS,
  reopenPendingSave,
  resolvePendingSave,
} from './live-session-keys.js'
import { downscaleImage } from './image.js'
import type {
  ExerciseDto,
  CreateCustomExerciseInput,
  PatchCustomExerciseInput,
  WorkoutDto,
  CreateWorkoutInput,
  PatchWorkoutInput,
  MetricDto,
  CreateMetricInput,
  PatchMetricInput,
  MuscleGroupVolume,
  MuscleVolume,
  WeeklyVolume,
  ExercisePr,
  ExerciseHistorySession,
  WodTemplateDto,
  CreateStrengthTemplateInput,
  CreateWodTemplateInput,
  PatchWodTemplateInput,
  WodType,
  TrainingPlanDto,
  TrainingPlanItemDto,
  CreateTrainingPlanInput,
  PatchTrainingPlanInput,
  CreateTrainingPlanItemInput,
  PatchTrainingPlanItemInput,
} from '@rallypoint/fitness-shared'
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
import { purgeOfflineUser } from './offline/hooks.js'
import { getDb, type FitnessOfflineTable } from './offline/db.js'
import { bindFitnessApi, engine, enqueueOp, pendingOps, resolveKnownTmpId } from './offline/engine.js'
import {
  distinctAffectedSurfaces,
  isTempId,
  newTempId,
  type OutboxOp,
} from './offline/outbox-ops.js'
import {
  applyExerciseOps,
  applyFavoriteOps,
  applyFoodFavoriteOps,
  applyMetricOps,
  applyPlanItemOps,
  applyPlanOps,
  applyTemplateOps,
  applyWorkoutOps,
  resolveTemplateBodyTmpIds,
  synthExercise,
  synthFoodFavorite,
  synthMetric,
  synthPlan,
  synthPlanItem,
  synthSets,
  synthTemplate,
  synthWorkout,
} from './offline/outbox-reducers.js'
import type { CachedQuery } from './offline/use-cached-query.js'

export type { SessionProfile }
export type { ExerciseDto, CreateCustomExerciseInput, PatchCustomExerciseInput }
export type { WorkoutDto, CreateWorkoutInput, PatchWorkoutInput }
export type { MetricDto, CreateMetricInput, PatchMetricInput }
export type { MuscleGroupVolume, MuscleVolume, WeeklyVolume, ExercisePr }
export type {
  WodTemplateDto,
  CreateWodTemplateInput,
  CreateStrengthTemplateInput,
  PatchWodTemplateInput,
  WodType,
}

export { ApiError }
export { isTempId }
export type { ImportSummary }

const client = createCsrfClient({ basePath: '/api/v1/ui' })
const request = client.request

// AI vision scans hold one connection open for the full inference
// (several seconds on a 24B model). Mobile Safari drops a too-slow
// connection as a bare "Load failed"; a single bounded auto-retry
// re-issues the (idempotent, read-only) scan on a fresh connection, and
// the timeout converts an indefinite hang into a typed, retryable
// 'timeout' rather than an unbounded spinner. Scans never write, so the
// retry can't double-log. Default retryOn covers only transport drops
// (status 0) — a server 4xx/5xx (bad image, capacity 503) is surfaced,
// not hammered.
const SCAN_REQUEST_OPTIONS = { timeoutMs: 45_000, retries: 1 } as const

// --- session / SSO --------------------------------------------------

export interface SessionDto {
  user_id: string
  // The shared cross-app settings doc folded in by the BFF. Theme keys
  // (themeMode/themeColor) hydrate the store on load; other keys are
  // opaque to the client.
  settings?: Record<string, unknown>
  // The fitness-scoped settings doc (namespace 'fitness') folded in the
  // same way. Currently carries `weightUnit` ('lb' | 'kg').
  app_settings?: Record<string, unknown>
  // The signed-in user's RPID profile (avatar + name) folded in by the
  // BFF for the user bar; `null`/absent when the fold-in degraded.
  profile?: SessionProfile | null
}

// Dispatched on window when a background session revalidation discovers
// the session is gone (401/403 after the UI already rendered from a
// cached SessionDto). AppChrome listens and kicks the SSO bounce.
export const SESSION_REVOKED_EVENT = 'fitness:session-revoked'

function applySessionSideEffects(session: SessionDto): void {
  // Apply the server's theme before the first authed render so the
  // preference follows the user across devices/apps. Does not echo a
  // write back (hydrateThemeFromServer suppresses the persister).
  if (session.settings) {
    hydrateThemeFromServer({
      mode: session.settings.themeMode,
      color: session.settings.themeColor,
    })
  }
  // Same contract for the fitness-scoped weight-unit + default-rest
  // preferences.
  if (session.app_settings) {
    hydrateWeightUnitFromServer(session.app_settings.weightUnit)
    hydrateDefaultRestFromServer(session.app_settings.defaultRestS)
    hydrateDefaultSetsFromServer(session.app_settings.defaultSets)
    hydrateDefaultRepsFromServer(session.app_settings.defaultReps)
    hydrateRestAlertsFromServer(session.app_settings.restAlerts)
    hydrateDayTypesFromServer(session.app_settings.dayTypes)
    hydrateCalorieGoalFromServer(session.app_settings.calorieGoalKcal)
  }
}

export async function getSession(): Promise<SessionDto> {
  // Instant boot: when a cached SessionDto exists (bootOfflineUser opened
  // the per-user DB from localStorage before any render), resolve it
  // immediately so RequireSession flips to authenticated in one frame —
  // no session-probe gate on the network. A background probe then
  // revalidates: 401/403 fires SESSION_REVOKED_EVENT (SSO bounce), a
  // different user_id purges the stale user's cache and reloads.
  // Accepted tradeoff: a revoked session shows cached UI for ~1 RTT
  // before bouncing — same behaviour as a native app.
  const cached = await readSession<SessionDto>('current')
  if (cached) {
    applySessionSideEffects(cached)
    void revalidateSession(cached)
    return cached
  }

  // Cold cache (first visit / post-signout): blocking probe. A success
  // keys the per-user offline cache and persists the SessionDto so the
  // next boot takes the instant path above. Failures — including a
  // 401/403 session-revoked — bubble up so RequireSession's SSO bounce
  // fires exactly as before.
  const session = await request<SessionDto>('GET', '/api/v1/ui/session')
  setOfflineUser(session.user_id)
  await writeSession('current', session)
  applySessionSideEffects(session)
  return session
}

async function revalidateSession(cached: SessionDto): Promise<void> {
  try {
    const session = await request<SessionDto>('GET', '/api/v1/ui/session')
    if (session.user_id !== cached.user_id) {
      // The cookie now belongs to a different account (signed in
      // elsewhere on this device). Purge the previous user's offline
      // state — same dispose-flusher-first hygiene as signout — and
      // reload so every module re-derives state from the new session.
      await purgeOfflineUser(cached.user_id)
      setOfflineUser(session.user_id)
      await writeSession('current', session)
      window.location.reload()
      return
    }
    setOfflineUser(session.user_id)
    void writeSession('current', session)
    applySessionSideEffects(session)
  } catch (err) {
    if (isTransportOrServerError(err)) return // offline / server sick — keep cached UI
    // 401/403: the session is genuinely revoked. Let the chrome bounce.
    window.dispatchEvent(new Event(SESSION_REVOKED_EVENT))
  }
}

// Transport failures (no .status) and 5xx mean "couldn't reach a healthy
// server" — keep serving the cached session. 4xx means the server
// actively rejected the session. Keep in sync with the fallback rule in
// @rallypoint/offline-kit's cache.
function isTransportOrServerError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return true
  const status = (err as { status?: unknown }).status
  if (typeof status !== 'number') return true
  return status >= 500
}

export async function exchangeSso(code: string, state: string): Promise<void> {
  await request<void>('POST', '/api/v1/ui/sso/exchange', { code, state })
}

// Live-session localStorage keys cleared on signout (S5). Without this
// a user-switch on a shared browser would mount the previous user's
// done-but-unsaved session via the Resume pill or the live page's own
// restore branch. Mirrors what lib/session.ts does for the RPID bearer.
// Sourced from the shared module — this list previously hardcoded two
// of the three slots and missed the rep-entry key, leaking that
// session across a user switch.
const LIVE_SESSION_LS_KEYS = ALL_LIVE_SESSION_LS_KEYS

export async function signout(): Promise<void> {
  await request<void>('POST', '/api/v1/ui/signout')
  try {
    for (const k of LIVE_SESSION_LS_KEYS) localStorage.removeItem(k)
  } catch {
    /* private window / no storage; ignore */
  }
  resetAnalytics()
}

// --- cache keys -------------------------------------------------------
// Canonical serialization of each list read's filters. The reconcile
// path parses these back (see parse*Key) to refetch exactly the cached
// windows after a drain, so keep builder + parser in lockstep — the
// api.queries test pins descriptor keys against these.

export interface ExerciseFilters {
  q?: string
  discipline?: string
  group?: string
  pattern?: string
}

export interface WorkoutFilters {
  from?: string // ISO date
  to?: string // ISO date
  limit?: number
}

export interface MetricFilters {
  kind?: string
  from?: string // ISO date
  to?: string // ISO date
  limit?: number
}

export interface WodTemplateFilters {
  q?: string
  type?: WodType
  /** Server-side `kind` filter (S8): when set, the API drops the
   *  other kind before sending. The WOD library page passes `'wod'`
   *  so strength rows never reach a UI that can't render them. */
  kind?: 'wod' | 'strength'
  benchmarkOnly?: boolean
  customOnly?: boolean
}

export function exercisesKey(f: ExerciseFilters = {}): string {
  return [f.q ?? '', f.discipline ?? '', f.group ?? '', f.pattern ?? ''].join('|')
}

function parseExercisesKey(key: string): ExerciseFilters {
  const [q, discipline, group, pattern] = key.split('|')
  return {
    ...(q ? { q } : {}),
    ...(discipline ? { discipline } : {}),
    ...(group ? { group } : {}),
    ...(pattern ? { pattern } : {}),
  }
}

export function workoutsKey(f: WorkoutFilters = {}): string {
  return [f.from ?? '', f.to ?? '', f.limit != null ? String(f.limit) : ''].join('|')
}

function parseWorkoutsKey(key: string): WorkoutFilters {
  const [from, to, limit] = key.split('|')
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  }
}

export function metricsKey(f: MetricFilters = {}): string {
  return [f.kind ?? '', f.from ?? '', f.to ?? '', f.limit != null ? String(f.limit) : ''].join('|')
}

function parseMetricsKey(key: string): MetricFilters {
  const [kind, from, to, limit] = key.split('|')
  return {
    ...(kind ? { kind } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  }
}

export function templatesKey(f: WodTemplateFilters = {}): string {
  return [
    f.q ?? '',
    f.type ?? '',
    f.kind ?? '',
    f.benchmarkOnly ? '1' : '',
    f.customOnly ? '1' : '',
  ].join('|')
}

function parseTemplatesKey(key: string): WodTemplateFilters {
  const [q, type, kind, benchmarkOnly, customOnly] = key.split('|')
  return {
    ...(q ? { q } : {}),
    ...(type ? { type: type as WodType } : {}),
    ...(kind ? { kind: kind as 'wod' | 'strength' } : {}),
    ...(benchmarkOnly ? { benchmarkOnly: true } : {}),
    ...(customOnly ? { customOnly: true } : {}),
  }
}

// Detail rows share the family table under an `id:` key so they never
// collide with (or get scanned as) filter-keyed list arrays. CAVEAT:
// detail keys are deliberately excluded from the optimistic-write path,
// the reconcile refetch, AND tmp-row cleanup (cachedListKeys filters
// them out) — they refresh only when their own getter runs. Today every
// detail read is a one-shot lookup (session pages, composer edit-load),
// so a stale detail row can only be served offline. If a page ever
// renders a detail key reactively via useCachedQuery, extend
// reconcileOpSurfaces to refetch `id:` keys for the touched family.
const detailKey = (id: string): string => `id:${id}`
const isListKey = (key: string): boolean => !key.startsWith('id:')

// --- optimistic-create key matchers ------------------------------------
// A synth row is appended to a cached list key only when it satisfies
// that key's filter — a workout logged for last month must not appear in
// this week's cached window. Server-side text search (q) and the muscle-
// group filter can't be evaluated client-side, so those keys skip the
// append and pick the row up from the post-drain reconcile refetch.

function workoutMatchesKey(key: string): (w: WorkoutDto) => boolean {
  const f = parseWorkoutsKey(key)
  return (w) => {
    const day = w.performedAt.slice(0, 10)
    if (f.from && day < f.from) return false
    if (f.to && day > f.to) return false
    return true
  }
}

function metricMatchesKey(key: string): (m: MetricDto) => boolean {
  const f = parseMetricsKey(key)
  return (m) => {
    if (f.kind && m.kind !== f.kind) return false
    const day = m.recordedAt.slice(0, 10)
    if (f.from && day < f.from) return false
    if (f.to && day > f.to) return false
    return true
  }
}

function exerciseMatchesKey(key: string): (e: ExerciseDto) => boolean {
  const f = parseExercisesKey(key)
  return (e) => {
    if (f.q || f.group) return false // server-evaluated filters
    if (f.discipline && e.discipline !== f.discipline) return false
    if (f.pattern && e.movementPattern !== f.pattern) return false
    return true
  }
}

function templateMatchesKey(key: string): (t: WodTemplateDto) => boolean {
  const f = parseTemplatesKey(key)
  return (t) => {
    if (f.q) return false // server-evaluated search
    if (f.benchmarkOnly) return false // synths are custom, never benchmark
    if (f.type && t.wodType !== f.type) return false
    if (f.kind && t.kind !== f.kind) return false
    return true
  }
}

// --- local-first write plumbing ---------------------------------------

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

// Every list key currently cached for a family table (the filter-keyed
// windows pages have visited). Used to spread optimistic mutations and
// tmp-row cleanup across all of them.
async function cachedListKeys(table: FitnessOfflineTable): Promise<string[]> {
  const userId = getOfflineUser()
  if (!userId) return []
  try {
    const keys = (await getDb(userId).table(table).toCollection().primaryKeys()) as string[]
    return keys.filter(isListKey)
  } catch {
    return []
  }
}

// Apply a per-key mutator to every cached list window of a family table.
async function mutateFamilyCaches<T>(
  table: FitnessOfflineTable,
  fn: (items: T[], key: string) => T[],
): Promise<void> {
  const keys = await cachedListKeys(table)
  await Promise.all(
    keys.map((key) => mutateCachedArray<T>(table, key, (items) => fn(items, key))),
  )
}

// Find a cached row by id across the family table's list windows and its
// detail row — the merged-synth builders use this so an optimistic PATCH
// returns the full row, not a lossy skeleton.
async function findCachedRow<T extends { id: string }>(
  table: FitnessOfflineTable,
  id: string,
): Promise<T | undefined> {
  const detail = await peekCache<T>(table, detailKey(id))
  if (detail) return detail.value
  const keys = await cachedListKeys(table)
  for (const key of keys) {
    const peek = await peekCache<T[]>(table, key)
    const hit = peek?.value.find((r) => r.id === id)
    if (hit) return hit
  }
  return undefined
}

// Re-apply queued ops on top of a fresh server response so a refetch
// racing a not-yet-flushed write can't wipe the optimistic rows.
async function queuedOps(): Promise<OutboxOp[]> {
  const userId = getOfflineUser()
  if (!userId) return []
  return pendingOps(userId)
}

// --- exercises -------------------------------------------------------

export interface ExerciseListResponse {
  exercises: ExerciseDto[]
}

export interface MuscleDto {
  id: string
  name: string
  sort: number
}

export interface MuscleGroupDto {
  id: string
  name: string
  sort: number
  muscles: MuscleDto[]
}

export interface MuscleGroupListResponse {
  groups: MuscleGroupDto[]
}

async function fetchExercises(filters: ExerciseFilters): Promise<ExerciseDto[]> {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.discipline) params.set('discipline', filters.discipline)
  if (filters.group) params.set('group', filters.group)
  if (filters.pattern) params.set('pattern', filters.pattern)
  const qs = params.toString()
  const res = await request<ExerciseListResponse>(
    'GET',
    `/api/v1/ui/exercises${qs ? `?${qs}` : ''}`,
  )
  return res.exercises
}

export async function listExercises(filters: ExerciseFilters = {}): Promise<ExerciseListResponse> {
  const key = exercisesKey(filters)
  const exercises = await cachedFetch<ExerciseDto[]>(
    'exercises',
    key,
    () => fetchExercises(filters),
    {
      rebase: async (fresh) => applyExerciseOps(fresh, await queuedOps(), exerciseMatchesKey(key)),
    },
  )
  return { exercises }
}

export async function getExercise(id: string): Promise<ExerciseDto> {
  const real = resolveKnownTmpId(id)
  if (isTempId(real)) {
    const cached = await findCachedRow<ExerciseDto>('exercises', real)
    if (cached) return cached
  }
  return cachedFetch<ExerciseDto>('exercises', detailKey(real), () =>
    request<ExerciseDto>('GET', `/api/v1/ui/exercises/${encodeURIComponent(real)}`),
  )
}

export async function listMuscleGroups(): Promise<MuscleGroupListResponse> {
  const groups = await cachedFetch<MuscleGroupDto[]>('muscleGroups', 'all', async () => {
    const res = await request<MuscleGroupListResponse>('GET', '/api/v1/ui/muscle-groups')
    return res.groups
  })
  return { groups }
}

async function remoteCreateExercise(input: CreateCustomExerciseInput): Promise<ExerciseDto> {
  return request<ExerciseDto>('POST', '/api/v1/ui/exercises', input)
}

async function remotePatchExercise(
  id: string,
  input: PatchCustomExerciseInput,
): Promise<ExerciseDto> {
  return request<ExerciseDto>('PATCH', `/api/v1/ui/exercises/${encodeURIComponent(id)}`, input)
}

async function remoteDeleteExercise(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/exercises/${encodeURIComponent(id)}`)
}

export async function createExercise(input: CreateCustomExerciseInput): Promise<ExerciseDto> {
  const op: OutboxOp = { type: 'exercise:create', tmpId: newTempId(), input }
  if (!(await tryEnqueue(op))) return remoteCreateExercise(input)
  const synth = synthExercise(op)
  await mutateFamilyCaches<ExerciseDto>('exercises', (items, key) =>
    applyExerciseOps(items, [op], exerciseMatchesKey(key)),
  )
  return synth
}

export async function patchExercise(
  id: string,
  input: PatchCustomExerciseInput,
): Promise<ExerciseDto> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'exercise:update', exerciseId: real, patch: input }
  if (!(await tryEnqueue(op))) return remotePatchExercise(real, input)
  const existing = await findCachedRow<ExerciseDto>('exercises', real)
  await mutateFamilyCaches<ExerciseDto>('exercises', (items, key) =>
    applyExerciseOps(items, [op], exerciseMatchesKey(key)),
  )
  return mergeItemPatch<ExerciseDto>(
    existing,
    {
      id: real,
      name: '',
      isCustom: true,
      discipline: 'strength',
      movementPattern: 'other',
      metricShape: 'reps_load',
      unilateral: false,
      muscles: [],
    } as unknown as Partial<ExerciseDto> & { id: string },
    input as Partial<ExerciseDto>,
  )
}

export async function deleteExercise(id: string): Promise<{ ok: true }> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'exercise:delete', exerciseId: real }
  if (!(await tryEnqueue(op))) return remoteDeleteExercise(real)
  await mutateFamilyCaches<ExerciseDto>('exercises', (items, key) =>
    applyExerciseOps(items, [op], exerciseMatchesKey(key)),
  )
  return { ok: true }
}

// --- workouts --------------------------------------------------------

export interface WorkoutListResponse {
  workouts: WorkoutDto[]
}

async function fetchWorkouts(filters: WorkoutFilters): Promise<WorkoutDto[]> {
  const params = new URLSearchParams()
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.limit != null) params.set('limit', String(filters.limit))
  const qs = params.toString()
  const res = await request<WorkoutListResponse>(
    'GET',
    `/api/v1/ui/workouts${qs ? `?${qs}` : ''}`,
  )
  return res.workouts
}

export async function listWorkouts(filters: WorkoutFilters = {}): Promise<WorkoutListResponse> {
  const key = workoutsKey(filters)
  const workouts = await cachedFetch<WorkoutDto[]>(
    'workouts',
    key,
    () => fetchWorkouts(filters),
    {
      rebase: async (fresh) => applyWorkoutOps(fresh, await queuedOps(), workoutMatchesKey(key)),
    },
  )
  return { workouts }
}

export async function getWorkout(id: string): Promise<WorkoutDto> {
  const real = resolveKnownTmpId(id)
  if (isTempId(real)) {
    const cached = await findCachedRow<WorkoutDto>('workouts', real)
    if (cached) return cached
  }
  return cachedFetch<WorkoutDto>('workouts', detailKey(real), () =>
    request<WorkoutDto>('GET', `/api/v1/ui/workouts/${encodeURIComponent(real)}`),
  )
}

async function remoteCreateWorkout(input: CreateWorkoutInput): Promise<WorkoutDto> {
  return request<WorkoutDto>('POST', '/api/v1/ui/workouts', input)
}

async function remotePatchWorkout(id: string, input: PatchWorkoutInput): Promise<WorkoutDto> {
  return request<WorkoutDto>('PATCH', `/api/v1/ui/workouts/${encodeURIComponent(id)}`, input)
}

async function remoteDeleteWorkout(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/workouts/${encodeURIComponent(id)}`)
}

export async function createWorkout(input: CreateWorkoutInput): Promise<WorkoutDto> {
  const op: OutboxOp = {
    type: 'workout:create',
    tmpId: newTempId(),
    input: resolveWorkoutInputTmpIds(input),
  }
  captureEvent('workout_logged', {
    modality: input.modality,
    set_count: input.sets?.length ?? 0,
  })
  if (!(await tryEnqueue(op))) {
    return remoteCreateWorkout(input)
  }
  const synth = synthWorkout(op)
  await mutateFamilyCaches<WorkoutDto>('workouts', (items, key) =>
    applyWorkoutOps(items, [op], workoutMatchesKey(key)),
  )
  return synth
}

export async function patchWorkout(id: string, input: PatchWorkoutInput): Promise<WorkoutDto> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'workout:update', workoutId: real, patch: input }
  if (!(await tryEnqueue(op))) return remotePatchWorkout(real, input)
  const existing = await findCachedRow<WorkoutDto>('workouts', real)
  await mutateFamilyCaches<WorkoutDto>('workouts', (items, key) =>
    applyWorkoutOps(items, [op], workoutMatchesKey(key)),
  )
  const { sets, ...rest } = input
  const patch: Partial<WorkoutDto> = {
    ...(rest as Partial<WorkoutDto>),
    ...(sets !== undefined ? { sets: synthSets(real, sets) } : {}),
  }
  return mergeItemPatch<WorkoutDto>(
    existing,
    {
      id: real,
      performedAt: new Date().toISOString(),
      modality: 'mixed',
      title: null,
      durationS: null,
      location: null,
      rpe: null,
      notes: null,
      payload: null,
      sets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    patch,
  )
}

export async function deleteWorkout(id: string): Promise<{ ok: true }> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'workout:delete', workoutId: real }
  if (!(await tryEnqueue(op))) return remoteDeleteWorkout(real)
  await mutateFamilyCaches<WorkoutDto>('workouts', (items, key) =>
    applyWorkoutOps(items, [op], workoutMatchesKey(key)),
  )
  return { ok: true }
}

// A workout logged right after creating a custom exercise offline may
// reference the exercise's tmp id in its sets — rewrite through the
// session map so an already-resolved create doesn't leak a tmp id to the
// server. Still-unresolved tmp ids stay put; the queue-level remap
// rewrites them when the exercise create flushes first (FIFO).
function resolveWorkoutInputTmpIds(input: CreateWorkoutInput): CreateWorkoutInput {
  if (!input.sets.some((s) => isTempId(s.exerciseId))) return input
  return {
    ...input,
    sets: input.sets.map((s) =>
      isTempId(s.exerciseId) ? { ...s, exerciseId: resolveKnownTmpId(s.exerciseId) } : s,
    ),
  }
}

// --- metrics ---------------------------------------------------------

export interface MetricListResponse {
  metrics: MetricDto[]
}

async function fetchMetrics(filters: MetricFilters): Promise<MetricDto[]> {
  const params = new URLSearchParams()
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.limit != null) params.set('limit', String(filters.limit))
  const qs = params.toString()
  const res = await request<MetricListResponse>('GET', `/api/v1/ui/metrics${qs ? `?${qs}` : ''}`)
  return res.metrics
}

export async function listMetrics(filters: MetricFilters = {}): Promise<MetricListResponse> {
  const key = metricsKey(filters)
  const metrics = await cachedFetch<MetricDto[]>('metrics', key, () => fetchMetrics(filters), {
    rebase: async (fresh) => applyMetricOps(fresh, await queuedOps(), metricMatchesKey(key)),
  })
  return { metrics }
}

async function remoteCreateMetric(input: CreateMetricInput): Promise<MetricDto> {
  return request<MetricDto>('POST', '/api/v1/ui/metrics', input)
}

async function remotePatchMetric(id: string, input: PatchMetricInput): Promise<MetricDto> {
  return request<MetricDto>('PATCH', `/api/v1/ui/metrics/${encodeURIComponent(id)}`, input)
}

async function remoteDeleteMetric(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/metrics/${encodeURIComponent(id)}`)
}

export async function createMetric(input: CreateMetricInput): Promise<MetricDto> {
  const op: OutboxOp = { type: 'metric:create', tmpId: newTempId(), input }
  if (!(await tryEnqueue(op))) return remoteCreateMetric(input)
  const synth = synthMetric(op)
  await mutateFamilyCaches<MetricDto>('metrics', (items, key) =>
    applyMetricOps(items, [op], metricMatchesKey(key)),
  )
  return synth
}

export async function patchMetric(id: string, input: PatchMetricInput): Promise<MetricDto> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'metric:update', metricId: real, patch: input }
  if (!(await tryEnqueue(op))) return remotePatchMetric(real, input)
  const existing = await findCachedRow<MetricDto>('metrics', real)
  await mutateFamilyCaches<MetricDto>('metrics', (items, key) =>
    applyMetricOps(items, [op], metricMatchesKey(key)),
  )
  return mergeItemPatch<MetricDto>(
    existing,
    {
      id: real,
      recordedAt: new Date().toISOString(),
      kind: '',
      value: 0,
      unit: null,
      note: null,
      createdAt: new Date().toISOString(),
    },
    input as Partial<MetricDto>,
  )
}

export async function deleteMetric(id: string): Promise<{ ok: true }> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'metric:delete', metricId: real }
  if (!(await tryEnqueue(op))) return remoteDeleteMetric(real)
  await mutateFamilyCaches<MetricDto>('metrics', (items, key) =>
    applyMetricOps(items, [op], metricMatchesKey(key)),
  )
  return { ok: true }
}

// --- insights --------------------------------------------------------
// Server-computed aggregates: cached read-only and reconciled by the
// post-drain refetch after workout ops (the server recomputes volume/PRs
// from the landed sets).

export interface VolumeInsightsResponse {
  from: string
  to: string
  groups: MuscleGroupVolume[]
  // Per-muscle drill-down. Optional: a cached pre-muscle-breakdown response
  // may still be served offline, so consumers must guard with `?? []`.
  muscles?: MuscleVolume[]
}

export interface PrExerciseEntry extends ExercisePr {
  exerciseId: string
  exerciseName: string
}

export interface PrsResponse {
  exercises: PrExerciseEntry[]
}

export async function getVolumeInsights(from: string, to: string): Promise<VolumeInsightsResponse> {
  return cachedFetch<VolumeInsightsResponse>('insightsVolume', `${from}|${to}`, () => {
    const params = new URLSearchParams({ from, to })
    return request<VolumeInsightsResponse>('GET', `/api/v1/ui/insights/volume?${params.toString()}`)
  })
}

export async function getPrs(): Promise<PrsResponse> {
  return cachedFetch<PrsResponse>('prs', 'all', () =>
    request<PrsResponse>('GET', '/api/v1/ui/insights/prs'),
  )
}

// Total tonnage per week for the Stats bar chart. `from` is the caller's
// local Monday-midnight instant (weeklyVolumeRange) so the server's fixed
// 7-day bins line up with the user's weeks.
export interface WeeklyVolumeResponse {
  from: string
  to: string
  weeks: WeeklyVolume[]
}

export async function getWeeklyVolume(from: string, to: string): Promise<WeeklyVolumeResponse> {
  return cachedFetch<WeeklyVolumeResponse>('insightsWeekly', `${from}|${to}`, () => {
    const params = new URLSearchParams({ from, to })
    return request<WeeklyVolumeResponse>(
      'GET',
      `/api/v1/ui/insights/volume/weekly?${params.toString()}`,
    )
  })
}

// --- WOD templates ---------------------------------------------------

export interface WodTemplateListResponse {
  wodTemplates: WodTemplateDto[]
}

async function fetchWodTemplates(filters: WodTemplateFilters): Promise<WodTemplateDto[]> {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.type) params.set('type', filters.type)
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.benchmarkOnly) params.set('benchmark_only', '1')
  if (filters.customOnly) params.set('custom_only', '1')
  const qs = params.toString()
  const res = await request<WodTemplateListResponse>(
    'GET',
    `/api/v1/ui/wod-templates${qs ? `?${qs}` : ''}`,
  )
  return res.wodTemplates
}

export async function listWodTemplates(
  filters: WodTemplateFilters = {},
): Promise<WodTemplateListResponse> {
  const key = templatesKey(filters)
  const wodTemplates = await cachedFetch<WodTemplateDto[]>(
    'wodTemplates',
    key,
    () => fetchWodTemplates(filters),
    {
      rebase: async (fresh) => applyTemplateOps(fresh, await queuedOps(), templateMatchesKey(key)),
    },
  )
  return { wodTemplates }
}

export async function getWodTemplate(id: string): Promise<WodTemplateDto> {
  const real = resolveKnownTmpId(id)
  if (isTempId(real)) {
    const cached = await findCachedRow<WodTemplateDto>('wodTemplates', real)
    if (cached) return cached
  }
  return cachedFetch<WodTemplateDto>('wodTemplates', detailKey(real), () =>
    request<WodTemplateDto>('GET', `/api/v1/ui/wod-templates/${encodeURIComponent(real)}`),
  )
}

async function remoteCreateWodTemplate(
  input: CreateWodTemplateInput | CreateStrengthTemplateInput,
): Promise<WodTemplateDto> {
  return request<WodTemplateDto>('POST', '/api/v1/ui/wod-templates', input)
}

async function remotePatchWodTemplate(
  id: string,
  input: PatchWodTemplateInput,
): Promise<WodTemplateDto> {
  return request<WodTemplateDto>(
    'PATCH',
    `/api/v1/ui/wod-templates/${encodeURIComponent(id)}`,
    input,
  )
}

async function remoteDeleteWodTemplate(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/wod-templates/${encodeURIComponent(id)}`)
}

// Accepts both WOD and strength template shapes — the API route sniffs
// the kind discriminator (`body.kind === 'strength'`) to pick the right
// validator. Backward-compat: existing WOD callers don't need to add
// anything.
export async function createWodTemplate(
  input: CreateWodTemplateInput | CreateStrengthTemplateInput,
): Promise<WodTemplateDto> {
  // Resolve any offline tmp exercise ids from an already-flushed
  // exercise:create before the body ships anywhere — enqueue, online
  // fallback, and the optimistic synth all need the resolved shape.
  // Cast: the remap preserves the body's runtime shape, but TS can't
  // re-pair the WOD/strength union member with its input type once the
  // body is rebuilt via spread (same cast as remapOpTarget's
  // template:create case in outbox-reducers.ts).
  const resolved = {
    ...input,
    body: resolveTemplateBodyTmpIds(input.body, isTempId, resolveKnownTmpId),
  } as typeof input
  const op: OutboxOp = { type: 'template:create', tmpId: newTempId(), input: resolved }
  if (!(await tryEnqueue(op))) return remoteCreateWodTemplate(resolved)
  const synth = synthTemplate(op)
  await mutateFamilyCaches<WodTemplateDto>('wodTemplates', (items, key) =>
    applyTemplateOps(items, [op], templateMatchesKey(key)),
  )
  return synth
}

export async function patchWodTemplate(
  id: string,
  input: PatchWodTemplateInput,
): Promise<WodTemplateDto> {
  const real = resolveKnownTmpId(id)
  const resolved =
    input.body !== undefined
      ? {
          ...input,
          body: resolveTemplateBodyTmpIds(
            input.body,
            isTempId,
            resolveKnownTmpId,
          ) as typeof input.body,
        }
      : input
  const op: OutboxOp = { type: 'template:update', templateId: real, patch: resolved }
  if (!(await tryEnqueue(op))) return remotePatchWodTemplate(real, resolved)
  const existing = await findCachedRow<WodTemplateDto>('wodTemplates', real)
  await mutateFamilyCaches<WodTemplateDto>('wodTemplates', (items, key) =>
    applyTemplateOps(items, [op], templateMatchesKey(key)),
  )
  return mergeItemPatch<WodTemplateDto>(
    existing,
    {
      id: real,
      name: '',
      isCustom: true,
      isBenchmark: false,
      kind: 'wod',
      wodType: 'for_time',
      timeCapS: null,
      description: null,
      body: { wodType: 'for_time', movements: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Partial<WodTemplateDto> & { id: string },
    resolved as Partial<WodTemplateDto>,
  )
}

export async function deleteWodTemplate(id: string): Promise<{ ok: true }> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'template:delete', templateId: real }
  if (!(await tryEnqueue(op))) return remoteDeleteWodTemplate(real)
  await mutateFamilyCaches<WodTemplateDto>('wodTemplates', (items, key) =>
    applyTemplateOps(items, [op], templateMatchesKey(key)),
  )
  return { ok: true }
}

// --- exercise favorites ---------------------------------------------

export interface FavoriteExercisesResponse {
  exerciseIds: string[]
}

export interface FavoriteMutationResponse {
  exerciseId: string
  starred: boolean
  changed: boolean
}

export async function listFavoriteExercises(): Promise<FavoriteExercisesResponse> {
  const exerciseIds = await cachedFetch<string[]>(
    'favorites',
    'all',
    async () => {
      const res = await request<FavoriteExercisesResponse>('GET', '/api/v1/ui/favorites/exercises')
      return res.exerciseIds
    },
    { rebase: async (fresh) => applyFavoriteOps(fresh, await queuedOps()) },
  )
  return { exerciseIds }
}

async function remoteStarExercise(id: string): Promise<FavoriteMutationResponse> {
  return request<FavoriteMutationResponse>(
    'PUT',
    `/api/v1/ui/favorites/exercises/${encodeURIComponent(id)}`,
  )
}

async function remoteUnstarExercise(id: string): Promise<FavoriteMutationResponse> {
  return request<FavoriteMutationResponse>(
    'DELETE',
    `/api/v1/ui/favorites/exercises/${encodeURIComponent(id)}`,
  )
}

async function setFavorite(id: string, starred: boolean): Promise<FavoriteMutationResponse> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'favorite:set', exerciseId: real, starred }
  if (!(await tryEnqueue(op))) {
    return starred ? remoteStarExercise(real) : remoteUnstarExercise(real)
  }
  await mutateCachedArray<string>('favorites', 'all', (ids) => applyFavoriteOps(ids, [op]))
  return { exerciseId: real, starred, changed: true }
}

export async function starExercise(id: string): Promise<FavoriteMutationResponse> {
  return setFavorite(id, true)
}

export async function unstarExercise(id: string): Promise<FavoriteMutationResponse> {
  return setFavorite(id, false)
}

// --- training plans -------------------------------------------------

export type {
  TrainingPlanDto,
  TrainingPlanItemDto,
  CreateTrainingPlanInput,
  PatchTrainingPlanInput,
  CreateTrainingPlanItemInput,
  PatchTrainingPlanItemInput,
  DayKey,
  PlanSourceKind,
} from '@rallypoint/fitness-shared'

export interface TrainingPlanListResponse {
  trainingPlans: TrainingPlanDto[]
}

export interface TrainingPlanResponse {
  trainingPlan: TrainingPlanDto
}

export interface TrainingPlanItemListResponse {
  items: TrainingPlanItemDto[]
}

export interface TrainingPlanItemResponse {
  item: TrainingPlanItemDto
}

export async function listTrainingPlans(): Promise<TrainingPlanListResponse> {
  const trainingPlans = await cachedFetch<TrainingPlanDto[]>(
    'trainingPlans',
    'all',
    async () => {
      const res = await request<TrainingPlanListResponse>('GET', '/api/v1/ui/training-plans')
      return res.trainingPlans
    },
    { rebase: async (fresh) => applyPlanOps(fresh, await queuedOps()) },
  )
  return { trainingPlans }
}

async function remoteCreateTrainingPlan(
  input: CreateTrainingPlanInput,
): Promise<TrainingPlanResponse> {
  return request<TrainingPlanResponse>('POST', '/api/v1/ui/training-plans', input)
}

async function remotePatchTrainingPlan(
  id: string,
  input: PatchTrainingPlanInput,
): Promise<TrainingPlanResponse> {
  return request<TrainingPlanResponse>(
    'PATCH',
    `/api/v1/ui/training-plans/${encodeURIComponent(id)}`,
    input,
  )
}

async function remoteDeleteTrainingPlan(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/training-plans/${encodeURIComponent(id)}`)
}

export async function createTrainingPlan(
  input: CreateTrainingPlanInput,
): Promise<TrainingPlanResponse> {
  const op: OutboxOp = { type: 'plan:create', tmpId: newTempId(), input }
  if (!(await tryEnqueue(op))) return remoteCreateTrainingPlan(input)
  const synth = synthPlan(op)
  await mutateCachedArray<TrainingPlanDto>('trainingPlans', 'all', (plans) =>
    applyPlanOps(plans, [op]),
  )
  return { trainingPlan: synth }
}

export async function patchTrainingPlan(
  id: string,
  input: PatchTrainingPlanInput,
): Promise<TrainingPlanResponse> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'plan:update', planId: real, patch: input }
  if (!(await tryEnqueue(op))) return remotePatchTrainingPlan(real, input)
  const existing = await findCachedRow<TrainingPlanDto>('trainingPlans', real)
  await mutateCachedArray<TrainingPlanDto>('trainingPlans', 'all', (plans) =>
    applyPlanOps(plans, [op]),
  )
  return {
    trainingPlan: mergeItemPatch<TrainingPlanDto>(
      existing,
      {
        id: real,
        name: '',
        lengthWeeks: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      input as Partial<TrainingPlanDto>,
    ),
  }
}

export async function deleteTrainingPlan(id: string): Promise<{ ok: true }> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'plan:delete', planId: real }
  if (!(await tryEnqueue(op))) return remoteDeleteTrainingPlan(real)
  await mutateCachedArray<TrainingPlanDto>('trainingPlans', 'all', (plans) =>
    applyPlanOps(plans, [op]),
  )
  return { ok: true }
}

export async function listTrainingPlanItems(planId: string): Promise<TrainingPlanItemListResponse> {
  const realPlanId = resolveKnownTmpId(planId)
  const items = await cachedFetch<TrainingPlanItemDto[]>(
    'trainingPlanItems',
    realPlanId,
    async () => {
      const res = await request<TrainingPlanItemListResponse>(
        'GET',
        `/api/v1/ui/training-plans/${encodeURIComponent(realPlanId)}/items`,
      )
      return res.items
    },
    { rebase: async (fresh) => applyPlanItemOps(fresh, await queuedOps(), realPlanId) },
  )
  return { items }
}

async function remoteAddTrainingPlanItem(
  planId: string,
  input: CreateTrainingPlanItemInput,
): Promise<TrainingPlanItemResponse> {
  return request<TrainingPlanItemResponse>(
    'POST',
    `/api/v1/ui/training-plans/${encodeURIComponent(planId)}/items`,
    input,
  )
}

async function remotePatchTrainingPlanItem(
  planId: string,
  itemId: string,
  input: PatchTrainingPlanItemInput,
): Promise<TrainingPlanItemResponse> {
  return request<TrainingPlanItemResponse>(
    'PATCH',
    `/api/v1/ui/training-plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}`,
    input,
  )
}

async function remoteDeleteTrainingPlanItem(
  planId: string,
  itemId: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    'DELETE',
    `/api/v1/ui/training-plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}`,
  )
}

export async function addTrainingPlanItem(
  planId: string,
  input: CreateTrainingPlanItemInput,
): Promise<TrainingPlanItemResponse> {
  const realPlanId = resolveKnownTmpId(planId)
  const resolvedInput =
    input.sourceId && isTempId(input.sourceId)
      ? { ...input, sourceId: resolveKnownTmpId(input.sourceId) }
      : input
  const op: OutboxOp = {
    type: 'planItem:create',
    planId: realPlanId,
    tmpId: newTempId(),
    input: resolvedInput,
  }
  if (!(await tryEnqueue(op))) return remoteAddTrainingPlanItem(realPlanId, resolvedInput)
  const synth = synthPlanItem(op)
  await mutateCachedArray<TrainingPlanItemDto>('trainingPlanItems', realPlanId, (items) =>
    applyPlanItemOps(items, [op], realPlanId),
  )
  return { item: synth }
}

export async function patchTrainingPlanItem(
  planId: string,
  itemId: string,
  input: PatchTrainingPlanItemInput,
): Promise<TrainingPlanItemResponse> {
  const realPlanId = resolveKnownTmpId(planId)
  const realItemId = resolveKnownTmpId(itemId)
  const op: OutboxOp = {
    type: 'planItem:update',
    planId: realPlanId,
    itemId: realItemId,
    patch: input,
  }
  if (!(await tryEnqueue(op))) return remotePatchTrainingPlanItem(realPlanId, realItemId, input)
  const existing = (await peekCache<TrainingPlanItemDto[]>('trainingPlanItems', realPlanId))?.value.find(
    (i) => i.id === realItemId,
  )
  await mutateCachedArray<TrainingPlanItemDto>('trainingPlanItems', realPlanId, (items) =>
    applyPlanItemOps(items, [op], realPlanId),
  )
  return {
    item: mergeItemPatch<TrainingPlanItemDto>(
      existing,
      {
        id: realItemId,
        planId: realPlanId,
        dayKey: 'mon',
        position: 0,
        sourceKind: 'strength',
        sourceId: null,
        note: null,
        createdAt: new Date().toISOString(),
      },
      input as Partial<TrainingPlanItemDto>,
    ),
  }
}

export async function deleteTrainingPlanItem(
  planId: string,
  itemId: string,
): Promise<{ ok: true }> {
  const realPlanId = resolveKnownTmpId(planId)
  const realItemId = resolveKnownTmpId(itemId)
  const op: OutboxOp = { type: 'planItem:delete', planId: realPlanId, itemId: realItemId }
  if (!(await tryEnqueue(op))) return remoteDeleteTrainingPlanItem(realPlanId, realItemId)
  await mutateCachedArray<TrainingPlanItemDto>('trainingPlanItems', realPlanId, (items) =>
    applyPlanItemOps(items, [op], realPlanId),
  )
  return { ok: true }
}

// --- settings --------------------------------------------------------

// Read a settings namespace doc (used by the reconcile path; the boot
// path gets settings folded into the session).
export async function getSettings(namespace: string): Promise<Record<string, unknown>> {
  return cachedFetch<Record<string, unknown>>('settings', namespace, async () => {
    const res = await request<{ settings: Record<string, unknown> }>(
      'GET',
      `/api/v1/ui/settings/${encodeURIComponent(namespace)}`,
    )
    return res.settings
  })
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
  return res.settings
}

// Persist a shallow patch into a settings namespace (a `null`-valued key
// deletes it). Used by the theme persister (registered in main.tsx), the
// weight-unit persister, and any Settings page. Returns the merged doc.
export async function updateSettings(
  namespace: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op: OutboxOp = { type: 'settings:update', namespace, patch }
  if (!(await tryEnqueue(op))) return remoteUpdateSettings(namespace, patch)
  const cached = (await peekCache<Record<string, unknown>>('settings', namespace))?.value ?? {}
  const merged = applySettingsPatch(cached, patch)
  await writeCachedValue('settings', namespace, merged)
  return merged
}

// --- whiteboard photo OCR -------------------------------------------
// Request/response by definition — the parse happens server-side
// (Workers AI). Callers guard with isTempId only where a template id
// rides along; the photo itself has no offline story.

// Hand-mirrors ParsedWodFromImage in apps/fitness-api/src/services/types.ts
// — change both together. An absent field means the scan could not read it,
// so applyScanToState blanks the corresponding composer field rather than
// falling back to a default.
export interface ScanWodResponse {
  parsed: {
    type: WodType | null
    rounds?: number
    scheme?: string
    capMin?: number
    durationMin?: number
    intervalS?: number
    totalIntervals?: number
    workS?: number
    restS?: number
    movements: { name: string; reps?: number; loadKg?: number }[]
    notes?: string
  }
  // AI-trace id for this scan (null when tracing is off server-side).
  // Echo it back via sendAiFeedback when the user acts on the parse.
  responseId: string | null
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') return reject(new Error('Bad reader output.'))
      // strip the data URL prefix
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error.'))
    reader.readAsDataURL(file)
  })
}

// Downscale + re-encode a scan photo, then base64 it for the JSON body.
// Phone originals (3–8 MB) blow the API's 4 MiB cap raw; the resized
// JPEG is a few hundred KB. Falls back to the original bytes when the
// image can't be decoded client-side.
async function scanPhotoPayload(file: File): Promise<{ imageBase64: string; mimeType: string }> {
  const blob = await downscaleImage(file)
  return {
    imageBase64: await fileToBase64(blob),
    mimeType: blob.type || file.type || 'image/jpeg',
  }
}

/** Upload a whiteboard photo to the OCR endpoint. The image is JSON-
 *  encoded as base64 so the call rides the existing CSRF + JSON
 *  request plumbing. Workers AI on the server side decodes + parses. */
export async function scanWodPhoto(file: File): Promise<ScanWodResponse> {
  const res = await request<ScanWodResponse>(
    'POST',
    '/api/v1/ui/scan/wod',
    await scanPhotoPayload(file),
    SCAN_REQUEST_OPTIONS,
  )
  captureEvent('scan_completed', { kind: 'wod', success: true })
  return res
}

// --- food logger (issue #700) -----------------------------------------
// Request/response by definition, like the whiteboard scan: barcode
// lookup and photo analysis happen server-side, and the diary is a
// confirm-first flow (no optimistic offline story in v1).

export type {
  FoodDaySummaryDto,
  FoodFavoriteDto,
  FoodItemDto,
  FoodLogEntryDto,
  FoodScanResult,
  DrinkScanResult,
  CreateFoodFavoriteInput,
  CreateFoodLogEntryInput,
  PatchFoodLogEntryInput,
} from '@rallypoint/fitness-shared'
import type {
  FoodDaySummaryDto,
  FoodFavoriteDto,
  FoodItemDto,
  FoodLogEntryDto,
  FoodScanResult,
  DrinkScanResult,
  CreateFoodFavoriteInput,
  CreateFoodLogEntryInput,
  PatchFoodLogEntryInput,
} from '@rallypoint/fitness-shared'

export interface BarcodeLookupResponse {
  item: FoodItemDto | null
  cached: boolean
}

/** Resolve a decoded barcode to a food item (our D1 cache, then Open
 *  Food Facts). `item: null` means the barcode is unknown — the UI
 *  falls back to manual / photo entry. Never logs anything. */
export async function lookupFoodBarcode(
  upc: string,
  opts: { silent?: boolean } = {},
): Promise<BarcodeLookupResponse> {
  const res = await request<BarcodeLookupResponse>('POST', '/api/v1/ui/food/barcode', { upc })
  // silent: internal enrichment hops (e.g. the search-pick serving
  // lookup) shouldn't count as barcode scans in analytics.
  if (!opts.silent) {
    captureEvent('scan_completed', { kind: 'barcode', success: true, found: res.item !== null })
  }
  return res
}

export interface FoodSearchResponse {
  items: FoodItemDto[]
  // True when this response folded in fresh Open Food Facts hits (vs.
  // local-cache-only) — the UI can show a subtle "searched the web" hint.
  external: boolean
}

/** Search foods by name — our own cache first, then Open Food Facts,
 *  with external hits written through to the cache. Callers debounce and
 *  drop stale responses (the search box uses a monotonic request id).
 *  Never logs anything. */
export async function searchFood(query: string): Promise<FoodSearchResponse> {
  return request<FoodSearchResponse>(
    'GET',
    `/api/v1/ui/food/search?q=${encodeURIComponent(query)}`,
  )
}

/** Analyze a food photo with Workers AI. `context` carries the user's
 *  hints AND answers to a previous scan's clarifying questions (the
 *  loop is stateless — re-send the same file with more context).
 *  `portionBias` is the per-user calibration factor from past
 *  estimated-vs-actual history — multiply the raw estimate by it for
 *  the prefill, but persist the raw estimate. */
export async function scanFoodPhoto(
  file: File,
  supportingFile?: File | null,
  context?: string,
  parentResponseId?: string | null,
): Promise<{ scan: FoodScanResult; portionBias: number; responseId: string | null }> {
  const res = await request<{ scan: FoodScanResult; portionBias: number; responseId: string | null }>(
    'POST',
    '/api/v1/ui/food/scan',
    {
      ...(await scanPhotoPayload(file)),
      ...(supportingFile ? { supportingImage: await scanPhotoPayload(supportingFile) } : {}),
      ...(context ? { context } : {}),
      ...(parentResponseId ? { parentResponseId } : {}),
    },
    SCAN_REQUEST_OPTIONS,
  )
  captureEvent('scan_completed', { kind: 'food', success: true })
  return res
}

/** Estimate a meal from a TEXT description ("I ate 5 cherries") — the
 *  photo scanner, text only. Same clarify-loop contract as scanFoodPhoto
 *  (re-send with more `context` to answer questions), minus the image and
 *  the portion-bias calibration (text quantities are user-stated). Throws
 *  (422 unusable / 502 vision failure) with a message to surface. */
export async function scanFoodText(
  text: string,
  context?: string,
  parentResponseId?: string | null,
): Promise<{ scan: FoodScanResult; responseId: string | null }> {
  const res = await request<{ scan: FoodScanResult; responseId: string | null }>(
    'POST',
    '/api/v1/ui/food/text',
    {
      text,
      ...(context ? { context } : {}),
      ...(parentResponseId ? { parentResponseId } : {}),
    },
    SCAN_REQUEST_OPTIONS,
  )
  captureEvent('scan_completed', { kind: 'text', success: true })
  return res
}

/** Analyze a mixed-drink photo (issue #713) → generic spirit + mixer
 *  guesses the drink stepper uses as prefill. Same endpoint as the food
 *  scan, `?mode=drink`. */
export async function scanDrinkPhoto(file: File, context?: string): Promise<DrinkScanResult> {
  const res = await request<{ drink: DrinkScanResult }>(
    'POST',
    '/api/v1/ui/food/scan?mode=drink',
    {
      ...(await scanPhotoPayload(file)),
      ...(context ? { context } : {}),
    },
    SCAN_REQUEST_OPTIONS,
  )
  captureEvent('scan_completed', { kind: 'drink', success: true })
  return res.drink
}

export interface LabelScanResult {
  item: FoodItemDto
  // HMAC binding this read to (user, upc). Round-trips into
  // createFoodLogEntry's `saveAsUpc.token`, which the server verifies
  // before writing the shared cache row.
  contributionToken: string
  // AI-trace id for this label read (null when tracing is off).
  responseId: string | null
}

/** Read a Nutrition Facts panel for a barcode neither our cache nor Open
 *  Food Facts knows. Returns an UNSAVED candidate item (source 'ai',
 *  per-100g, keyed by the upc) plus a contribution token; the confirm
 *  sheet persists it to the shared cache on save (via createFoodLogEntry's
 *  `saveAsUpc`, carrying the token). Throws (422 unusable read / 502
 *  vision failure) with a message to surface. */
export async function scanNutritionLabel(
  upc: string,
  labelFile: File,
  productFile?: File | null,
  context?: string,
): Promise<LabelScanResult> {
  const res = await request<LabelScanResult>(
    'POST',
    '/api/v1/ui/food/label',
    {
      upc,
      ...(await scanPhotoPayload(labelFile)),
      ...(productFile ? { productImage: await scanPhotoPayload(productFile) } : {}),
      ...(context ? { context } : {}),
    },
    SCAN_REQUEST_OPTIONS,
  )
  captureEvent('scan_completed', { kind: 'label', success: true })
  return res
}

// --- AI scan feedback --------------------------------------------------

export type AiFeedbackAction = 'accepted' | 'edited' | 'rejected' | 'retried'

/** Report what the user did with an AI scan result to the trace corpus.
 *  Fire-and-forget: call as `void sendAiFeedback(...)` — failures are
 *  swallowed (feedback must never break a logging flow), and it's
 *  online-only by design (responseIds are ephemeral; do NOT route
 *  through the offline outbox). */
export async function sendAiFeedback(
  responseId: string,
  action: AiFeedbackAction,
  finalValue?: unknown,
): Promise<void> {
  try {
    await request<{ ok: boolean }>('POST', '/api/v1/ui/ai/feedback', {
      responseId,
      action,
      ...(finalValue !== undefined ? { finalValue } : {}),
    })
  } catch {
    // Best-effort telemetry only.
  }
}

/** Fetch a cached food item by id — the edit sheet uses it to rebuild
 *  the unit options (serving size, liquid flag) and per-100g macros for
 *  an existing entry. */
export async function getFoodItem(id: string): Promise<FoodItemDto> {
  const res = await request<{ item: FoodItemDto }>(
    'GET',
    `/api/v1/ui/food/items/${encodeURIComponent(id)}`,
  )
  return res.item
}

export async function createFoodLogEntry(
  input: CreateFoodLogEntryInput,
): Promise<FoodLogEntryDto> {
  const entry = await request<FoodLogEntryDto>('POST', '/api/v1/ui/food/log', input)
  captureEvent('food_logged', { source: input.source })
  return entry
}

// Per-local-day kcal/macro sums for the calorie dashboard and the /log
// dashboard's food tile. `tz` tells the server which calendar the day
// buckets use — minutes east of UTC, the negation of JS
// getTimezoneOffset().
//
// Cached like the other read-only server aggregates (insightsVolume /
// insightsWeekly / prs): no outbox op writes it, so there is nothing to
// rebase — the cache only ever spares the reader a cold "Loading…" on a
// page that otherwise paints instantly from IndexedDB. The food WRITE
// path stays request/response; only this aggregate read is cached.
export async function listFoodDaySummary(
  fromIso: string,
  toIso: string,
): Promise<FoodDaySummaryDto[]> {
  return cachedFetch<FoodDaySummaryDto[]>('foodDaySummary', `${fromIso}|${toIso}`, async () => {
    const qs = new URLSearchParams({
      from: fromIso,
      to: toIso,
      tz: String(-new Date().getTimezoneOffset()),
    })
    const res = await request<{ days: FoodDaySummaryDto[] }>(
      'GET',
      `/api/v1/ui/food/summary?${qs.toString()}`,
    )
    return res.days
  })
}

export async function listFoodLog(fromIso: string, toIso: string): Promise<FoodLogEntryDto[]> {
  const qs = new URLSearchParams({ from: fromIso, to: toIso })
  const res = await request<{ entries: FoodLogEntryDto[] }>(
    'GET',
    `/api/v1/ui/food/log?${qs.toString()}`,
  )
  return res.entries
}

export async function patchFoodLogEntry(
  id: string,
  input: PatchFoodLogEntryInput,
): Promise<FoodLogEntryDto> {
  return request<FoodLogEntryDto>(
    'PATCH',
    `/api/v1/ui/food/log/${encodeURIComponent(id)}`,
    input,
  )
}

export async function deleteFoodLogEntry(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/food/log/${encodeURIComponent(id)}`)
}

// --- food favorites (pinned quick-log templates) ----------------------
//
// The one food surface with outbox ops: a pin is a tiny idempotent
// toggle the server dedupes, so it queues offline safely. Re-logging a
// pin still goes through createFoodLogEntry (request/response), matching
// the rest of the diary write path.

export async function listFoodFavorites(): Promise<FoodFavoriteDto[]> {
  return cachedFetch<FoodFavoriteDto[]>(
    'foodFavorites',
    'all',
    async () => {
      const res = await request<{ favorites: FoodFavoriteDto[] }>(
        'GET',
        '/api/v1/ui/food/favorites',
      )
      return res.favorites
    },
    { rebase: async (fresh) => applyFoodFavoriteOps(fresh, await queuedOps()) },
  )
}

async function remoteCreateFoodFavorite(
  input: CreateFoodFavoriteInput,
): Promise<{ favorite: FoodFavoriteDto; created: boolean }> {
  return request<{ favorite: FoodFavoriteDto; created: boolean }>(
    'POST',
    '/api/v1/ui/food/favorites',
    input,
  )
}

async function remoteDeleteFoodFavorite(id: string): Promise<{ changed: boolean }> {
  return request<{ changed: boolean }>(
    'DELETE',
    `/api/v1/ui/food/favorites/${encodeURIComponent(id)}`,
  )
}

/** Pin a diary row as a quick-log template. Returns the optimistic (or
 *  server) favorite so the caller can light up the toggle immediately. */
export async function createFoodFavorite(
  input: CreateFoodFavoriteInput,
): Promise<FoodFavoriteDto> {
  const op: OutboxOp = { type: 'foodFavorite:create', tmpId: newTempId(), input }
  if (!(await tryEnqueue(op))) return (await remoteCreateFoodFavorite(input)).favorite
  const synth = synthFoodFavorite(op)
  await mutateCachedArray<FoodFavoriteDto>('foodFavorites', 'all', (favs) =>
    applyFoodFavoriteOps(favs, [op]),
  )
  return synth
}

export async function deleteFoodFavorite(id: string): Promise<{ ok: true }> {
  const real = resolveKnownTmpId(id)
  const op: OutboxOp = { type: 'foodFavorite:delete', favoriteId: real }
  if (!(await tryEnqueue(op))) {
    await remoteDeleteFoodFavorite(real)
    return { ok: true }
  }
  await mutateCachedArray<FoodFavoriteDto>('foodFavorites', 'all', (favs) =>
    applyFoodFavoriteOps(favs, [op]),
  )
  return { ok: true }
}

// --- meal prep (prepared-meal batches + recipes) ----------------------
// Request/response, same confirm-first model as the food logger (every
// ingredient add already needs the network to identify the food, so no
// offline outbox). Logging a portion returns the updated batch AND the
// diary entry it created (a normal food_log_entries row).

export type {
  PreparedMealDto,
  PreparedMealIngredientDto,
  PreparedMealStatus,
  RecipeDto,
  RecipeIngredientDto,
  CreateMealPrepIngredientInput,
  UpdateMealPrepIngredientInput,
  LogPreparedMealPortionInput,
} from '@rallypoint/fitness-shared'
import type {
  PreparedMealDto,
  PreparedMealStatus,
  RecipeDto,
  CreateMealPrepIngredientInput,
  UpdateMealPrepIngredientInput,
  LogPreparedMealPortionInput,
} from '@rallypoint/fitness-shared'

export async function createMealPrep(input: {
  name?: string
  fromRecipeId?: string
}): Promise<PreparedMealDto> {
  return request<PreparedMealDto>('POST', '/api/v1/ui/meal-prep', input)
}

export async function listMealPreps(status?: PreparedMealStatus): Promise<PreparedMealDto[]> {
  const qs = status ? `?status=${status}` : ''
  const res = await request<{ meals: PreparedMealDto[] }>('GET', `/api/v1/ui/meal-prep${qs}`)
  return res.meals
}

export async function getMealPrep(id: string): Promise<PreparedMealDto> {
  return request<PreparedMealDto>('GET', `/api/v1/ui/meal-prep/${encodeURIComponent(id)}`)
}

export async function patchMealPrep(
  id: string,
  input: { name?: string; servings?: number | null },
): Promise<PreparedMealDto> {
  return request<PreparedMealDto>('PATCH', `/api/v1/ui/meal-prep/${encodeURIComponent(id)}`, input)
}

export async function deleteMealPrep(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/meal-prep/${encodeURIComponent(id)}`)
}

export async function addMealPrepIngredient(
  id: string,
  input: CreateMealPrepIngredientInput,
): Promise<PreparedMealDto> {
  const meal = await request<PreparedMealDto>(
    'POST',
    `/api/v1/ui/meal-prep/${encodeURIComponent(id)}/ingredients`,
    input,
  )
  captureEvent('meal_prep_ingredient_added', { source: input.source })
  return meal
}

export async function updateMealPrepIngredient(
  id: string,
  ingredientId: string,
  input: UpdateMealPrepIngredientInput,
): Promise<PreparedMealDto> {
  return request<PreparedMealDto>(
    'PATCH',
    `/api/v1/ui/meal-prep/${encodeURIComponent(id)}/ingredients/${encodeURIComponent(ingredientId)}`,
    input,
  )
}

export async function removeMealPrepIngredient(
  id: string,
  ingredientId: string,
): Promise<PreparedMealDto> {
  return request<PreparedMealDto>(
    'DELETE',
    `/api/v1/ui/meal-prep/${encodeURIComponent(id)}/ingredients/${encodeURIComponent(ingredientId)}`,
  )
}

export async function finishMealPrep(
  id: string,
  input: { servings?: number | null } = {},
): Promise<PreparedMealDto> {
  return request<PreparedMealDto>(
    'POST',
    `/api/v1/ui/meal-prep/${encodeURIComponent(id)}/finish`,
    input,
  )
}

// Write off what's left of an active batch ("it's gone"). Unlike
// finishMealPrep (= done cooking) this ends the eat-down, and unlike
// logMealPrepPortion it creates no diary entry — the leftovers weren't eaten.
export async function markMealPrepFinished(id: string): Promise<PreparedMealDto> {
  const meal = await request<PreparedMealDto>(
    'POST',
    `/api/v1/ui/meal-prep/${encodeURIComponent(id)}/mark-finished`,
    {},
  )
  captureEvent('meal_prep_marked_finished', {})
  return meal
}

export async function logMealPrepPortion(
  id: string,
  input: LogPreparedMealPortionInput,
): Promise<{ meal: PreparedMealDto; entry: FoodLogEntryDto }> {
  const res = await request<{ meal: PreparedMealDto; entry: FoodLogEntryDto }>(
    'POST',
    `/api/v1/ui/meal-prep/${encodeURIComponent(id)}/log`,
    input,
  )
  captureEvent('food_logged', { source: 'prepared_meal' })
  return res
}

export async function saveMealPrepAsRecipe(
  id: string,
  input: { name: string; notes?: string; servings?: number | null },
): Promise<RecipeDto> {
  const recipe = await request<RecipeDto>(
    'POST',
    `/api/v1/ui/meal-prep/${encodeURIComponent(id)}/save-as-recipe`,
    input,
  )
  captureEvent('recipe_saved', {})
  return recipe
}

export async function listRecipes(): Promise<RecipeDto[]> {
  const res = await request<{ recipes: RecipeDto[] }>('GET', '/api/v1/ui/recipes')
  return res.recipes
}

export async function getRecipe(id: string): Promise<RecipeDto> {
  return request<RecipeDto>('GET', `/api/v1/ui/recipes/${encodeURIComponent(id)}`)
}

export async function patchRecipe(
  id: string,
  input: { name?: string; notes?: string | null; servings?: number | null },
): Promise<RecipeDto> {
  return request<RecipeDto>('PATCH', `/api/v1/ui/recipes/${encodeURIComponent(id)}`, input)
}

export async function deleteRecipe(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/recipes/${encodeURIComponent(id)}`)
}

// --- query descriptors ------------------------------------------------
// Read-surface descriptors for useCachedQuery. Each pairs the exact
// (table, key) its reader writes with a fetch that goes through that
// reader — the api.queries test pins them against key drift.

export const exercisesQuery = (filters: ExerciseFilters = {}): CachedQuery<ExerciseDto[]> => ({
  table: 'exercises',
  key: exercisesKey(filters),
  fetch: () => listExercises(filters).then((r) => r.exercises),
})
export const muscleGroupsQuery = (): CachedQuery<MuscleGroupDto[]> => ({
  table: 'muscleGroups',
  key: 'all',
  fetch: () => listMuscleGroups().then((r) => r.groups),
})
export const workoutsQuery = (filters: WorkoutFilters = {}): CachedQuery<WorkoutDto[]> => ({
  table: 'workouts',
  key: workoutsKey(filters),
  fetch: () => listWorkouts(filters).then((r) => r.workouts),
})
export const metricsQuery = (filters: MetricFilters = {}): CachedQuery<MetricDto[]> => ({
  table: 'metrics',
  key: metricsKey(filters),
  fetch: () => listMetrics(filters).then((r) => r.metrics),
})
export const volumeInsightsQuery = (from: string, to: string): CachedQuery<VolumeInsightsResponse> => ({
  table: 'insightsVolume',
  key: `${from}|${to}`,
  fetch: () => getVolumeInsights(from, to),
})
export const weeklyVolumeQuery = (from: string, to: string): CachedQuery<WeeklyVolumeResponse> => ({
  table: 'insightsWeekly',
  key: `${from}|${to}`,
  fetch: () => getWeeklyVolume(from, to),
})
export const prsQuery = (): CachedQuery<PrsResponse> => ({
  table: 'prs',
  key: 'all',
  fetch: () => getPrs(),
})
export const wodTemplatesQuery = (
  filters: WodTemplateFilters = {},
): CachedQuery<WodTemplateDto[]> => ({
  table: 'wodTemplates',
  key: templatesKey(filters),
  fetch: () => listWodTemplates(filters).then((r) => r.wodTemplates),
})
export const favoritesQuery = (): CachedQuery<string[]> => ({
  table: 'favorites',
  key: 'all',
  fetch: () => listFavoriteExercises().then((r) => r.exerciseIds),
})
export const trainingPlansQuery = (): CachedQuery<TrainingPlanDto[]> => ({
  table: 'trainingPlans',
  key: 'all',
  fetch: () => listTrainingPlans().then((r) => r.trainingPlans),
})
export const trainingPlanItemsQuery = (planId: string): CachedQuery<TrainingPlanItemDto[]> => ({
  table: 'trainingPlanItems',
  key: resolveKnownTmpId(planId),
  fetch: () => listTrainingPlanItems(planId).then((r) => r.items),
})
export const settingsQuery = (namespace: string): CachedQuery<Record<string, unknown>> => ({
  table: 'settings',
  key: namespace,
  fetch: () => getSettings(namespace),
})
export const foodDaySummaryQuery = (
  fromIso: string,
  toIso: string,
): CachedQuery<FoodDaySummaryDto[]> => ({
  table: 'foodDaySummary',
  key: `${fromIso}|${toIso}`,
  fetch: () => listFoodDaySummary(fromIso, toIso),
})
export const foodFavoritesQuery = (): CachedQuery<FoodFavoriteDto[]> => ({
  table: 'foodFavorites',
  key: 'all',
  fetch: () => listFoodFavorites(),
})

// --- offline engine wiring --------------------------------------------

// Refetch the read surfaces a batch of ops touched. Runs after the
// outbox drains (reconciles tmp ids → real ids and server-computed
// fields) and after a hard op failure (restores server truth so the
// optimistic change visibly reverts). Each reader rewrites the cache,
// which notifies subscribers. Filter-keyed families refetch every cached
// window so no visited view is left stale.
export async function reconcileOpSurfaces(ops: OutboxOp[]): Promise<void> {
  const surfaces = distinctAffectedSurfaces(ops)
  await Promise.all(
    surfaces.map(async (s) => {
      try {
        switch (s.kind) {
          case 'workout': {
            const keys = await cachedListKeys('workouts')
            await Promise.all(keys.map((k) => listWorkouts(parseWorkoutsKey(k))))
            // The server recomputes aggregates from the landed sets.
            await refreshInsights()
            break
          }
          case 'metric': {
            const keys = await cachedListKeys('metrics')
            await Promise.all(keys.map((k) => listMetrics(parseMetricsKey(k))))
            break
          }
          case 'exercise': {
            const keys = await cachedListKeys('exercises')
            await Promise.all(keys.map((k) => listExercises(parseExercisesKey(k))))
            break
          }
          case 'template': {
            const keys = await cachedListKeys('wodTemplates')
            await Promise.all(keys.map((k) => listWodTemplates(parseTemplatesKey(k))))
            break
          }
          case 'plan':
            await listTrainingPlans()
            break
          case 'planItem':
            await listTrainingPlanItems(s.scope /* = planId */)
            break
          case 'favorite':
            await listFavoriteExercises()
            break
          case 'foodFavorite':
            await listFoodFavorites()
            break
          case 'submission':
            // Submissions aren't a cached family (plain request/response
            // list) — nothing to reconcile; the sheet refetches on open.
            break
          case 'settings':
            await getSettings(s.scope /* = namespace */)
            break
        }
      } catch {
        // Best-effort: the next page-driven read reconciles instead.
      }
    }),
  )
}

async function refreshInsights(): Promise<void> {
  const [volumeKeys, weeklyKeys, prsKeys] = await Promise.all([
    cachedListKeys('insightsVolume'),
    cachedListKeys('insightsWeekly'),
    cachedListKeys('prs'),
  ])
  await Promise.all([
    ...volumeKeys.map((k) => {
      const [from, to] = k.split('|')
      return from && to ? getVolumeInsights(from, to) : Promise.resolve(undefined)
    }),
    ...weeklyKeys.map((k) => {
      const [from, to] = k.split('|')
      return from && to ? getWeeklyVolume(from, to) : Promise.resolve(undefined)
    }),
    ...(prsKeys.length ? [getPrs()] : []),
  ])
}

// Bind the concrete fitness-api mutations to the offline engine so the
// OutboxFlusher can replay queued ops. MUST bind the remote*
// request/response variants, never the public local-first fns — those
// enqueue, so the flusher would re-enqueue its own replay and recurse.
bindFitnessApi({
  createWorkout: (input) => remoteCreateWorkout(input).then((w) => ({ id: w.id })),
  patchWorkout: remotePatchWorkout,
  deleteWorkout: remoteDeleteWorkout,
  createMetric: (input) => remoteCreateMetric(input).then((m) => ({ id: m.id })),
  patchMetric: remotePatchMetric,
  deleteMetric: remoteDeleteMetric,
  createExercise: (input) => remoteCreateExercise(input).then((e) => ({ id: e.id })),
  patchExercise: remotePatchExercise,
  deleteExercise: remoteDeleteExercise,
  createWodTemplate: (input) => remoteCreateWodTemplate(input).then((t) => ({ id: t.id })),
  patchWodTemplate: remotePatchWodTemplate,
  deleteWodTemplate: remoteDeleteWodTemplate,
  createTrainingPlan: remoteCreateTrainingPlan,
  patchTrainingPlan: remotePatchTrainingPlan,
  deleteTrainingPlan: remoteDeleteTrainingPlan,
  addTrainingPlanItem: remoteAddTrainingPlanItem,
  patchTrainingPlanItem: remotePatchTrainingPlanItem,
  deleteTrainingPlanItem: remoteDeleteTrainingPlanItem,
  starExercise: remoteStarExercise,
  unstarExercise: remoteUnstarExercise,
  createFoodFavorite: remoteCreateFoodFavorite,
  deleteFoodFavorite: remoteDeleteFoodFavorite,
  submitExercise: (id) =>
    request<unknown>('POST', `/api/v1/ui/exercises/${encodeURIComponent(id)}/submit`),
  updateSettings: remoteUpdateSettings,
})

// After a flush pass resolves ops, refetch the touched surfaces so
// server-computed fields and real ids reconcile into the cache —
// subscribers re-render from it.
engine.onDrained = (resolvedOps) => {
  void reconcileOpSurfaces(resolvedOps)
}

// A hard-failed op (4xx rejection) leaves the cache holding an optimistic
// change the server refused — refetch the surface so it reverts on screen.
engine.reconcileFailedOp = (op) => {
  // A finished-but-unsaved live session was parked (not cleared) under
  // this tmp id while the create was in flight; a terminal failure
  // means it never made it to the server, so restore the slot rather
  // than lose the session (see live-session-keys.ts pending-save marker).
  if (op.type === 'workout:create') {
    reopenPendingSave(op.tmpId)
  }
  void reconcileOpSurfaces([op])
}

// After a *:create op replays online and we get the real server id, drop
// the optimistic tmp row from every cached window of the family so the
// reconcile refetch doesn't leave the page seeing the same logical item
// twice (tmpId + serverId rows).
engine.onCreateResolved = async (op, _serverId) => {
  const dropTmp = async (table: FitnessOfflineTable, tmpId: string): Promise<void> => {
    await mutateFamilyCaches<{ id: string }>(table, (items) =>
      items.filter((i) => i.id !== tmpId),
    )
  }
  switch (op.type) {
    case 'workout:create':
      await dropTmp('workouts', op.tmpId)
      // Server acked — drop the pending-save marker parked in
      // saveToLog/RepEntrySession/WodSessionPage's finish handlers.
      resolvePendingSave(op.tmpId)
      break
    case 'metric:create':
      await dropTmp('metrics', op.tmpId)
      break
    case 'exercise:create':
      await dropTmp('exercises', op.tmpId)
      break
    case 'template:create':
      await dropTmp('wodTemplates', op.tmpId)
      break
    case 'plan:create':
      await dropTmp('trainingPlans', op.tmpId)
      break
    case 'planItem:create':
      await dropTmp('trainingPlanItems', op.tmpId)
      break
    case 'foodFavorite:create':
      await dropTmp('foodFavorites', op.tmpId)
      break
  }
}

// --- weather (running snapshots) ---------------------------------------
// Request/response by definition: the forecast is fetched once at save
// time to stamp a snapshot onto the workout payload — no offline story,
// a failed fetch just means no weather on that session.

export interface WeatherCurrentDto {
  temperature: number
  apparentTemperature?: number | null
  windSpeed?: number | null
  weatherCode?: number | null
  isDay?: boolean | null
}

export interface WeatherResponse {
  forecast: { current: WeatherCurrentDto | null } | null
  airQuality: unknown
}

export async function getWeather(lat: number, lng: number, tz: string): Promise<WeatherResponse> {
  const qs = new URLSearchParams({ lat: String(lat), lng: String(lng), tz })
  return request<WeatherResponse>('GET', `/api/v1/ui/weather?${qs.toString()}`)
}

// --- progress pictures (Body Stats) -------------------------------------
// Request/response by definition, like the food logger: the upload body
// is the raw image bytes (no offline story — bytes can't sit in the
// outbox), and lists are cheap to refetch after a mutation.

export type { ProgressPhotoDto } from '@rallypoint/fitness-shared'
import type { ProgressPhotoDto } from '@rallypoint/fitness-shared'

export interface ProgressPhotoFilters {
  pose?: string
  from?: string
  to?: string
  limit?: number
  // Opaque "load more" cursor from the previous page's next_cursor.
  cursor?: string
}

export interface ProgressPhotoListResponse {
  items: ProgressPhotoDto[]
  // Opaque cursor for "load more" (null at the end of the collection).
  next_cursor: string | null
}

export async function listProgressPhotos(
  filters: ProgressPhotoFilters = {},
): Promise<ProgressPhotoListResponse> {
  const params = new URLSearchParams()
  if (filters.pose) params.set('pose', filters.pose)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.limit != null) params.set('limit', String(filters.limit))
  if (filters.cursor) params.set('cursor', filters.cursor)
  const qs = params.toString()
  return request<ProgressPhotoListResponse>(
    'GET',
    `/api/v1/ui/progress-photos${qs ? `?${qs}` : ''}`,
  )
}

export async function listProgressPhotoPoses(): Promise<string[]> {
  const res = await request<{ poses: string[] }>('GET', '/api/v1/ui/progress-photos/poses')
  return res.poses
}

/** Upload a progress photo: raw bytes in the body (Content-Type = the
 *  file's MIME), pose/takenAt/note as query params. Bypasses the JSON
 *  `request` helper — that one JSON-encodes bodies — but keeps the same
 *  CSRF + credentials semantics. */
export async function uploadProgressPhoto(
  file: File | Blob,
  meta: { pose: string; takenAt?: string; note?: string; setId?: string },
): Promise<ProgressPhotoDto> {
  const params = new URLSearchParams({ pose: meta.pose })
  if (meta.takenAt) params.set('takenAt', meta.takenAt)
  if (meta.note) params.set('note', meta.note)
  if (meta.setId) params.set('setId', meta.setId)
  const res = await fetch(`/api/v1/ui/progress-photos?${params.toString()}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-RP-CSRF': await client.fetchCsrf(),
      'Content-Type': file.type || 'image/jpeg',
    },
    body: file,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null
    throw new ApiError(
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? 'Could not upload that photo.',
      res.status,
    )
  }
  return (await res.json()) as ProgressPhotoDto
}

export async function patchProgressPhoto(
  id: string,
  input: { pose?: string; takenAt?: string; note?: string | null },
): Promise<ProgressPhotoDto> {
  return request<ProgressPhotoDto>(
    'PATCH',
    `/api/v1/ui/progress-photos/${encodeURIComponent(id)}`,
    input,
  )
}

export async function deleteProgressPhoto(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>('DELETE', `/api/v1/ui/progress-photos/${encodeURIComponent(id)}`)
}

/** Same-origin auth-gated image URL for `<img src=…>` (session cookie
 *  rides along; the Worker streams from the private bucket). */
export function progressPhotoImageUrl(id: string): string {
  return `/api/v1/ui/progress-photos/${encodeURIComponent(id)}/image`
}

// --- exercise machine settings ---------------------------------------
//
// Plain request/response (not routed through the offline outbox or
// cachedFetch, unlike favorites/exercises above). Machine settings are
// a low-frequency, opt-in edit surface (open a sheet, tweak a couple of
// rows, save) rather than something read on every page load or edited
// while offline mid-workout — matching the food diary's plain-request
// convention rather than the heavier favorites/exercise sync machinery.

export type { MachineSettingEntry } from '@rallypoint/fitness-shared'
import type { MachineSettingEntry } from '@rallypoint/fitness-shared'

export interface MachineSettingsResponse {
  entries: MachineSettingEntry[]
}

export async function getMachineSettings(exerciseId: string): Promise<MachineSettingsResponse> {
  // A session block may still hold the tmp id of an exercise created
  // moments ago (offline create since drained) — map it before hitting
  // the server, which only knows the real id.
  const real = resolveKnownTmpId(exerciseId)
  return request<MachineSettingsResponse>(
    'GET',
    `/api/v1/ui/exercises/${encodeURIComponent(real)}/machine-settings`,
  )
}

export async function putMachineSettings(
  exerciseId: string,
  entries: MachineSettingEntry[],
): Promise<MachineSettingsResponse> {
  const real = resolveKnownTmpId(exerciseId)
  return request<MachineSettingsResponse>(
    'PUT',
    `/api/v1/ui/exercises/${encodeURIComponent(real)}/machine-settings`,
    { entries },
  )
}

// --- exercise history (in-workout "last time" hint) -------------------

export interface ExerciseHistoryResponse {
  exerciseId: string
  exerciseName: string
  sessions: ExerciseHistorySession[]
}

// Recent sessions' working sets for one exercise. Uncached (plain request,
// like machine settings): it's live-workout data that must reflect the
// latest logged workout, and it's cheap + only fetched when a block is on
// screen. A tmp id (offline-created exercise not yet drained) has no server
// history, so map it first and let the server 404 fall through to "no
// history yet" at the call site.
export async function getExerciseHistory(
  exerciseId: string,
  limit?: number,
): Promise<ExerciseHistoryResponse> {
  const real = resolveKnownTmpId(exerciseId)
  const qs = limit != null ? `?limit=${limit}` : ''
  return request<ExerciseHistoryResponse>(
    'GET',
    `/api/v1/ui/exercises/${encodeURIComponent(real)}/history${qs}`,
  )
}

// --- push (rest-timer notifications) -----------------------------------
//
// Plain request/response by design: a rest push is only worth parking
// server-side while we're online RIGHT NOW (offline, the local alert
// covers the rest period, and a late-drained push is worse than none) —
// so none of these ride the outbox.

export interface PushSubscriptionPayload {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export async function registerPushSubscription(sub: PushSubscriptionPayload): Promise<void> {
  await request<void>('POST', '/api/v1/ui/push/subscription', sub)
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  await request<void>('DELETE', '/api/v1/ui/push/subscription', { endpoint })
}

export async function scheduleRestPush(
  tag: string,
  fireAtMs: number,
  nextUp?: string,
): Promise<{ id: string }> {
  return request<{ id: string }>('PUT', '/api/v1/ui/push/rest-timer', {
    tag,
    fireAtMs,
    ...(nextUp ? { nextUp } : {}),
  })
}

export async function cancelRestPush(tag: string): Promise<void> {
  await request<void>('DELETE', `/api/v1/ui/push/rest-timer/${encodeURIComponent(tag)}`)
}

// Booleans only by design — the backend never leaks device counts.
export interface TestPushResult {
  ok: boolean
  registered: boolean
  delivered: boolean
}

export async function sendTestPush(): Promise<TestPushResult> {
  return request<TestPushResult>('POST', '/api/v1/ui/push/test', {})
}

// --- exercise submissions ---------------------------------------------
//
// Plain request/response, same rationale as machine settings above:
// submitting a custom exercise for review (and the resulting migration
// prompt) is a low-frequency, opt-in flow, not something read on every
// page load or edited while offline.

export type { SubmissionDto } from '@rallypoint/fitness-shared'
import type { SubmissionDto } from '@rallypoint/fitness-shared'

export interface SubmissionsResponse {
  submissions: SubmissionDto[]
}

export async function submitExercise(exerciseId: string): Promise<SubmissionDto> {
  const real = resolveKnownTmpId(exerciseId)
  return request<SubmissionDto>(
    'POST',
    `/api/v1/ui/exercises/${encodeURIComponent(real)}/submit`,
  )
}

/** Fire-and-forget submit used by the create-flow's "submit to catalog"
 *  toggle: goes through the OUTBOX so it sequences after the exercise
 *  create it targets (whose id may still be a tmp id that the queue
 *  remaps on drain). Falls back to a direct request when the outbox is
 *  unavailable. */
export async function queueSubmitExercise(exerciseId: string): Promise<void> {
  const op: OutboxOp = { type: 'submission:create', exerciseId }
  if (!(await tryEnqueue(op))) await submitExercise(exerciseId)
}

export async function listSubmissions(): Promise<SubmissionsResponse> {
  return request<SubmissionsResponse>('GET', '/api/v1/ui/submissions')
}

export async function migrateSubmission(id: string, accept: boolean): Promise<SubmissionDto> {
  return request<SubmissionDto>(
    'POST',
    `/api/v1/ui/submissions/${encodeURIComponent(id)}/migrate`,
    { accept },
  )
}

// --- food submissions ---------------------------------------------------
//
// The AI nutrition-label UPC contribution review queue's actor-facing
// side (mirrors exercise submissions above): list the actor's own
// submissions and accept/decline the post-approval migration offer.

export type { FoodSubmissionDto } from '@rallypoint/fitness-shared'
import type { FoodSubmissionDto } from '@rallypoint/fitness-shared'

export interface FoodSubmissionsResponse {
  submissions: FoodSubmissionDto[]
}

export async function listFoodSubmissions(): Promise<FoodSubmissionsResponse> {
  return request<FoodSubmissionsResponse>('GET', '/api/v1/ui/food-submissions')
}

export async function migrateFoodSubmission(
  id: string,
  accept: boolean,
): Promise<FoodSubmissionDto> {
  return request<FoodSubmissionDto>(
    'POST',
    `/api/v1/ui/food-submissions/${encodeURIComponent(id)}/migrate`,
    { accept },
  )
}

// Whether the current user has any unflushed offline writes. The
// migration-offer prompt (LibraryPage) gates on this: the outbox can
// hold ops keyed to the custom exercise id that's about to be deleted
// by a migration accept, so the prompt only shows once the queue is
// empty (in addition to being online).
export async function hasPendingWrites(): Promise<boolean> {
  const ops = await queuedOps()
  return ops.length > 0
}

// Force a refetch of the exercises + favorites caches, bypassing the
// normal cachedFetch key-matching — used after a migration accept swaps
// a custom exercise id for the global one, so every visited list window
// repaints with server truth instead of a stale custom-exercise row.
export async function refreshExercisesAndFavorites(): Promise<void> {
  const keys = await cachedListKeys('exercises')
  await Promise.all([
    ...keys.map((k) => listExercises(parseExercisesKey(k))),
    listExercises({}),
    listFavoriteExercises(),
  ])
}

// --- data export / import (backup–restore) ---------------------------
// Both bypass `request()`: the export response is a ZIP, not JSON, and the
// import body is raw archive bytes rather than a JSON envelope. Same
// credentials + CSRF handling as uploadProgressPhoto above.
//
// Deliberately NOT routed through the offline cache/outbox: an import is a
// bulk server-side write with no synthesizable local result, and an export
// must reflect server truth rather than whatever the local cache holds.

export async function exportHealthData(): Promise<Blob> {
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

export async function importHealthData(file: File | Blob): Promise<ImportSummary> {
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
