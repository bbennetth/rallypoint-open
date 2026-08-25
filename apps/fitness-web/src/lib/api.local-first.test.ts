// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'

// Local-first write path: every fitness mutation returns a synth
// immediately, enqueues to the outbox, and the engine flushes to the
// network right away when online. Drives the REAL api.ts module
// (createCsrfClient over a stubbed global fetch) + real Dexie via
// fake-indexeddb — the exact wiring the recursion regression lives in.
//
// The fetch stub is a tiny stateful fitness server so the post-drain
// reconcile refetch returns genuine server truth instead of a canned
// snapshot that would fight the assertions.

interface ServerWorkout {
  id: string
  performedAt: string
  modality: string
  title: string | null
  sets: { exerciseId: string; reps?: number; loadKg?: number }[]
  [k: string]: unknown
}

interface ServerMetric {
  id: string
  recordedAt: string
  kind: string
  value: number
  unit: string | null
  note: string | null
  createdAt: string
}

let serverWorkouts: ServerWorkout[] = []
let serverMetrics: ServerMetric[] = []
let serverExercises: { id: string; name: string; [k: string]: unknown }[] = []
let serverFavorites: string[] = []
let serverSettings: Record<string, unknown> = {}
let nextServerId = 1
let patchGate: Promise<void> | null = null
let failNextPatchWith: number | null = null

const calls: { method: string; path: string; body?: unknown }[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fullWorkout(w: ServerWorkout): ServerWorkout {
  return {
    durationS: null,
    location: null,
    rpe: null,
    notes: null,
    payload: null,
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    ...w,
  }
}

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  const method = init?.method ?? 'GET'
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
  calls.push({ method, path, ...(body !== undefined ? { body } : {}) })

  if (method === 'GET' && path.endsWith('/csrf')) return json({ csrfToken: 'test-token' })

  const workoutMatch = /\/workouts(?:\/([^/?]+))?/.exec(path)
  if (workoutMatch) {
    const [, id] = workoutMatch
    if (method === 'GET' && !id) return json({ workouts: serverWorkouts.map(fullWorkout) })
    if (method === 'POST') {
      const created: ServerWorkout = fullWorkout({
        id: `w_srv_${nextServerId++}`,
        performedAt: String(body?.performedAt ?? ''),
        modality: String(body?.modality ?? 'mixed'),
        title: (body?.title as string | undefined) ?? null,
        sets: (body?.sets as ServerWorkout['sets']) ?? [],
      })
      serverWorkouts.push(created)
      return json(created)
    }
    if (method === 'PATCH') {
      if (patchGate) await patchGate
      if (failNextPatchWith !== null) {
        const status = failNextPatchWith
        failNextPatchWith = null
        return json({ error: { code: 'validation_failed' } }, status)
      }
      const row = serverWorkouts.find((w) => w.id === id)
      if (!row) return json({ error: { code: 'not_found' } }, 404)
      Object.assign(row, body)
      return json(fullWorkout(row))
    }
    if (method === 'DELETE') {
      serverWorkouts = serverWorkouts.filter((w) => w.id !== id)
      return json({ ok: true })
    }
  }

  const metricMatch = /\/metrics(?:\/([^/?]+))?/.exec(path)
  if (metricMatch) {
    const [, id] = metricMatch
    if (method === 'GET' && !id) return json({ metrics: serverMetrics })
    if (method === 'POST') {
      const created: ServerMetric = {
        id: `m_srv_${nextServerId++}`,
        recordedAt: String(body?.recordedAt ?? ''),
        kind: String(body?.kind ?? ''),
        value: Number(body?.value ?? 0),
        unit: (body?.unit as string | undefined) ?? null,
        note: (body?.note as string | undefined) ?? null,
        createdAt: '2026-07-08T00:00:00Z',
      }
      serverMetrics.push(created)
      return json(created)
    }
    if (method === 'PATCH') {
      if (patchGate) await patchGate
      if (failNextPatchWith !== null) {
        const status = failNextPatchWith
        failNextPatchWith = null
        return json({ error: { code: 'validation_failed' } }, status)
      }
      const row = serverMetrics.find((m) => m.id === id)
      if (!row) return json({ error: { code: 'not_found' } }, 404)
      Object.assign(row, body)
      return json(row)
    }
    if (method === 'DELETE') {
      serverMetrics = serverMetrics.filter((m) => m.id !== id)
      return json({ ok: true })
    }
  }

  const exerciseMatch = /\/exercises(?:\/([^/?]+))?/.exec(path)
  if (exerciseMatch && !path.includes('/favorites/')) {
    const [, id] = exerciseMatch
    if (method === 'GET' && !id) return json({ exercises: serverExercises })
    if (method === 'POST') {
      const created = {
        id: `ex_srv_${nextServerId++}`,
        name: String(body?.name ?? ''),
        isCustom: true,
        discipline: body?.discipline ?? 'strength',
        movementPattern: body?.movementPattern ?? 'other',
        metricShape: body?.metricShape ?? 'reps_load',
        unilateral: false,
        muscles: [],
      }
      serverExercises.push(created)
      return json(created)
    }
  }

  const favMatch = /\/favorites\/exercises(?:\/([^/?]+))?/.exec(path)
  if (favMatch) {
    const [, id] = favMatch
    if (method === 'GET') return json({ exerciseIds: serverFavorites })
    if (method === 'PUT' && id) {
      const changed = !serverFavorites.includes(id)
      if (changed) serverFavorites.push(id)
      return json({ exerciseId: id, starred: true, changed })
    }
    if (method === 'DELETE' && id) {
      const changed = serverFavorites.includes(id)
      serverFavorites = serverFavorites.filter((f) => f !== id)
      return json({ exerciseId: id, starred: false, changed })
    }
  }

  const settingsMatch = /\/settings\/([^/?]+)/.exec(path)
  if (settingsMatch && method === 'PATCH') {
    serverSettings = { ...serverSettings, ...(body ?? {}) }
    return json({ settings: serverSettings })
  }
  if (settingsMatch && method === 'GET') return json({ settings: serverSettings })

  // Unrelated traffic (session, insights, muscle groups, …) — benign
  // defaults so background reconciles never wedge the suite.
  if (path.includes('/insights/volume')) return json({ from: '', to: '', groups: [] })
  if (path.includes('/insights/prs')) return json({ exercises: [] })
  if (path.includes('/muscle-groups')) return json({ groups: [] })
  if (path.includes('/training-plans')) {
    if (method === 'GET') return json(path.includes('/items') ? { items: [] } : { trainingPlans: [] })
  }
  if (method === 'GET') return json({})
  if (method === 'DELETE') return json({ ok: true })
  return json({})
})

let api: typeof import('./api.js')
let cache: typeof import('./offline/cache.js')
let db: typeof import('./offline/db.js')

beforeAll(async () => {
  // Stub fetch BEFORE importing api.ts — createCsrfClient captures the
  // global fetch reference at module-init time.
  vi.stubGlobal('fetch', fetchStub)
  api = await import('./api.js')
  cache = await import('./offline/cache.js')
  db = await import('./offline/db.js')
})

let UID = 'baseline'

beforeEach(() => {
  UID = `user_fit_${Math.floor(Math.random() * 1e9)}`
  cache.setOfflineUser(UID)
  calls.length = 0
  serverWorkouts = []
  serverMetrics = []
  serverExercises = []
  serverFavorites = []
  serverSettings = {}
  nextServerId = 1
  patchGate = null
  failNextPatchWith = null
})

afterEach(async () => {
  cache.setOfflineUser(null)
  try {
    await Dexie.delete(`fitness-offline:${UID}`)
  } catch {
    // ignore
  }
})

async function outboxCount(): Promise<number> {
  return db.getDb(UID).outbox.count()
}

const drained = () => vi.waitFor(async () => expect(await outboxCount()).toBe(0))

describe('local-first fitness mutations', () => {
  it('createWorkout returns a tmp-id synth immediately, then flushes exactly one POST', async () => {
    await api.listWorkouts() // seed the read cache (key '||')
    const synth = await api.createWorkout({
      performedAt: '2026-07-08T10:00:00Z',
      modality: 'strength',
      title: 'Squats',
      sets: [{ exerciseId: 'ex1', reps: 5, loadKg: 100 }],
    })
    expect(synth.id).toMatch(/^tmp_/)
    expect(synth.title).toBe('Squats')
    expect(synth.sets[0]).toMatchObject({ reps: 5, loadKg: 100 })

    await drained()
    const posts = calls.filter((c) => c.method === 'POST' && /\/workouts$/.test(c.path))
    // Exactly one POST: the flusher replays through the remote variant —
    // if it were bound to the public local-first fn it would re-enqueue
    // and loop (the bindFitnessApi recursion regression).
    expect(posts).toHaveLength(1)

    // Cache reconciled: real row in, tmp row out.
    await vi.waitFor(async () => {
      const peek = await cache.peekCache<{ id: string }[]>('workouts', '||')
      const ids = (peek?.value ?? []).map((w) => w.id)
      expect(ids).toContain('w_srv_1')
      expect(ids.some((id) => id.startsWith('tmp_'))).toBe(false)
    })
  })

  it('patchMetric returns a merged synth from the cached row (not a lossy skeleton)', async () => {
    serverMetrics.push({
      id: 'm_1',
      recordedAt: '2026-07-01T08:00:00Z',
      kind: 'bodyweight',
      value: 82,
      unit: 'kg',
      note: 'morning',
      createdAt: '2026-07-01T08:00:00Z',
    })
    await api.listMetrics() // seed the read cache

    const synth = await api.patchMetric('m_1', { value: 81 })
    expect(synth.value).toBe(81)
    expect(synth.kind).toBe('bodyweight')
    expect(synth.unit).toBe('kg')
    expect(synth.note).toBe('morning')

    await drained()
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.body).toEqual({ value: 81 })
  })

  it('a 400 rejection drops the op and refetches the surface (visible revert)', async () => {
    serverWorkouts.push({
      id: 'w_1',
      performedAt: '2026-07-08T10:00:00Z',
      modality: 'strength',
      title: 'Row',
      sets: [],
    })
    await api.listWorkouts()
    failNextPatchWith = 400

    await api.patchWorkout('w_1', { title: 'Renamed' })
    await drained()

    // The reconcile refetch restored server truth (title unchanged).
    await vi.waitFor(async () => {
      const peek = await cache.peekCache<{ id: string; title: string | null }[]>('workouts', '||')
      expect(peek?.value.find((w) => w.id === 'w_1')?.title).toBe('Row')
    })
  })

  it('a refetch racing a queued write does not wipe the optimistic row (rebase)', async () => {
    serverWorkouts.push({
      id: 'w_1',
      performedAt: '2026-07-08T10:00:00Z',
      modality: 'strength',
      title: 'Row',
      sets: [],
    })
    await api.listWorkouts()

    // Hold the PATCH so the op stays queued during the refetch.
    let release: () => void = () => {}
    patchGate = new Promise<void>((r) => {
      release = r
    })

    await api.patchWorkout('w_1', { title: 'Renamed' })
    // Server still says 'Row' — but the queued op must win the read.
    const { workouts } = await api.listWorkouts()
    expect(workouts.find((w) => w.id === 'w_1')?.title).toBe('Renamed')

    release()
    patchGate = null
    await drained()
  })

  it('an optimistic create lands only in matching cached windows', async () => {
    await api.listWorkouts() // '||' — unbounded
    await api.listWorkouts({ from: '2026-01-01', to: '2026-01-31' }) // out-of-window

    await api.createWorkout({
      performedAt: '2026-07-08T10:00:00Z',
      modality: 'conditioning',
      sets: [],
    })

    const all = await cache.peekCache<{ id: string }[]>('workouts', '||')
    const january = await cache.peekCache<{ id: string }[]>(
      'workouts',
      '2026-01-01|2026-01-31|',
    )
    expect(all?.value.some((w) => w.id.startsWith('tmp_'))).toBe(true)
    expect(january?.value.some((w) => w.id.startsWith('tmp_'))).toBe(false)
    await drained()
  })

  it('star/unstar flushes as the final state and updates the favorites cache instantly', async () => {
    await api.listFavoriteExercises()
    await api.starExercise('ex_9')

    const peek = await cache.peekCache<string[]>('favorites', 'all')
    expect(peek?.value).toContain('ex_9')

    await drained()
    const puts = calls.filter((c) => c.method === 'PUT' && c.path.includes('/favorites/'))
    expect(puts).toHaveLength(1)
    expect(serverFavorites).toContain('ex_9')
  })

  it('updateSettings returns the merged doc instantly and null deletes a key', async () => {
    serverSettings = { themeMode: 'dark', extra: 1 }
    await api.getSettings('shared')

    const merged = await api.updateSettings('shared', { themeColor: 'pink', extra: null })
    expect(merged).toEqual({ themeMode: 'dark', themeColor: 'pink' })

    await drained()
    const patches = calls.filter((c) => c.method === 'PATCH' && c.path.includes('/settings/'))
    expect(patches).toHaveLength(1)
    expect(patches[0]?.body).toEqual({ themeColor: 'pink', extra: null })
  })

  it('an update enqueued after its create resolved is rewritten to the real id', async () => {
    await api.listWorkouts()
    const synth = await api.createWorkout({
      performedAt: '2026-07-08T10:00:00Z',
      modality: 'strength',
      sets: [],
    })
    await drained() // create flushed; queue empty; tmp resolved

    // Page still holds the tmp id and edits the workout.
    await api.patchWorkout(synth.id, { title: 'After the swap' })
    await drained()

    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.path).toContain('/workouts/w_srv_')
    expect(patches[0]?.path).not.toContain('tmp_')
    expect(serverWorkouts[0]?.title).toBe('After the swap')
  })

  it('a workout referencing a just-created custom exercise flushes with the real exercise id', async () => {
    await api.listExercises()
    await api.listWorkouts()
    const exercise = await api.createExercise({
      name: 'Sandbag Carry',
      discipline: 'strength',
      movementPattern: 'carry',
      metricShape: 'reps_load',
    } as never)
    // Enqueue the workout while the exercise create may still be queued —
    // FIFO + queue-level remap must rewrite the set's exercise id.
    await api.createWorkout({
      performedAt: '2026-07-08T10:00:00Z',
      modality: 'strength',
      sets: [{ exerciseId: exercise.id, reps: 10 }],
    })
    await drained()

    const workoutPost = calls.find((c) => c.method === 'POST' && /\/workouts$/.test(c.path))
    const sets = (workoutPost?.body as { sets?: { exerciseId: string }[] })?.sets
    expect(sets?.[0]?.exerciseId).toMatch(/^ex_srv_/)
    expect(sets?.[0]?.exerciseId).not.toMatch(/^tmp_/)
  })
})
