// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'

// Local-first write path (slice 2): every task/shopping/chore mutation
// returns a synth immediately, enqueues to the outbox, and the engine
// flushes to the network right away when online. Drives the REAL api.ts
// module (createCsrfClient over a stubbed global fetch) + real Dexie via
// fake-indexeddb — the exact wiring the recursion regression lives in.
//
// The fetch stub is a tiny stateful task server (serverItems) so the
// post-drain reconcile refetch returns genuine server truth instead of a
// canned snapshot that would fight the assertions.

interface ServerItem {
  id: string
  listId: string
  title: string
  completed: boolean
  priority?: string | null
  [k: string]: unknown
}

interface ServerNote {
  id: string
  title: string
  notes: string | null
  folderId: string
  completed: boolean
  completedAt: string | null
  createdAt: string
  deletedAt: string | null
}

let serverItems: ServerItem[] = []
let serverNotes: ServerNote[] = []
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

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input)
  const method = init?.method ?? 'GET'
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
  calls.push({ method, path, ...(body !== undefined ? { body } : {}) })

  if (method === 'GET' && path.endsWith('/csrf')) return json({ csrfToken: 'test-token' })

  const itemsMatch = /\/lists\/([^/]+)\/items(?:\/([^/?]+))?/.exec(path)
  if (itemsMatch) {
    const [, listId, itemId] = itemsMatch
    if (method === 'GET') return json(serverItems.filter((i) => i.listId === listId))
    if (method === 'POST') {
      const created: ServerItem = {
        id: `item_srv_${nextServerId++}`,
        listId: listId!,
        title: String(body?.title ?? ''),
        completed: false,
        priority: (body?.priority as string | null | undefined) ?? null,
      }
      serverItems.push(created)
      return json(created)
    }
    if (method === 'PATCH') {
      if (patchGate) await patchGate
      if (failNextPatchWith !== null) {
        const status = failNextPatchWith
        failNextPatchWith = null
        return json({ error: { code: 'validation_failed' } }, status)
      }
      const row = serverItems.find((i) => i.id === itemId)
      if (!row) return json({ error: { code: 'not_found' } }, 404)
      Object.assign(row, body)
      return json(row)
    }
    if (method === 'DELETE') {
      serverItems = serverItems.filter((i) => i.id !== itemId)
      return new Response(null, { status: 204 })
    }
  }

  const noteMatch = /\/notes(?:\/([^/?]+))?/.exec(path)
  if (noteMatch && !path.includes('/notes/folders')) {
    const [, noteId] = noteMatch
    if (method === 'GET') {
      if (path.endsWith('/notes/deleted')) {
        return json(serverNotes.filter((n) => n.deletedAt !== null))
      }
      const url = new URL(path, 'http://x')
      const folderId = url.searchParams.get('folderId')
      const live = serverNotes.filter((n) => n.deletedAt === null)
      return json(folderId ? live.filter((n) => n.folderId === folderId) : live)
    }
    if (method === 'PATCH') {
      const row = serverNotes.find((n) => n.id === noteId && n.deletedAt === null)
      if (!row) return json({ error: { code: 'not_found' } }, 404)
      Object.assign(row, body)
      if (body?.completed !== undefined) {
        row.completedAt = body.completed ? new Date().toISOString() : null
      }
      return json(row)
    }
    if (method === 'DELETE') {
      const row = serverNotes.find((n) => n.id === noteId && n.deletedAt === null)
      if (!row) return json({ error: { code: 'not_found' } }, 404)
      row.deletedAt = new Date().toISOString()
      return new Response(null, { status: 204 })
    }
    if (method === 'POST' && path.endsWith('/restore')) {
      const id = path.split('/').at(-2)
      const row = serverNotes.find((n) => n.id === id && n.deletedAt !== null)
      if (!row) return json({ error: { code: 'not_found' } }, 404)
      row.deletedAt = null
      return json(row)
    }
  }

  const settingsMatch = /\/settings\/([^/?]+)/.exec(path)
  if (settingsMatch && method === 'PATCH') {
    if (patchGate) await patchGate
    serverSettings = { ...serverSettings, ...(body ?? {}) }
    return json({ settings: serverSettings })
  }
  if (settingsMatch && method === 'GET') return json({ settings: serverSettings })

  // Unrelated traffic (holidays, session, …) — benign defaults.
  if (method === 'GET') return json([])
  if (method === 'DELETE') return new Response(null, { status: 204 })
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
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

beforeEach(() => {
  UID = `user_lf_${Math.floor(Math.random() * 1e9)}`
  cache.setOfflineUser(UID)
  calls.length = 0
  serverItems = []
  serverNotes = []
  serverSettings = {}
  nextServerId = 1
  patchGate = null
  failNextPatchWith = null
})

afterEach(async () => {
  cache.setOfflineUser(null)
  try {
    await Dexie.delete(`planner-offline:${UID}`)
  } catch {
    // ignore
  }
})

async function outboxCount(): Promise<number> {
  return db.getDb(UID).outbox.count()
}

const drained = () => vi.waitFor(async () => expect(await outboxCount()).toBe(0))

describe('local-first task mutations', () => {
  it('createTaskItem returns a tmp-id synth immediately, then flushes exactly one POST', async () => {
    const synth = await api.createTaskItem('L1', 'Milk')
    expect(synth.id).toMatch(/^tmp_/)
    expect(synth.title).toBe('Milk')

    await drained()
    const posts = calls.filter((c) => c.method === 'POST' && c.path.includes('/lists/L1/items'))
    // Exactly one POST: the flusher replays through the remote variant —
    // if it were bound to the public local-first fn it would re-enqueue
    // and loop (the bindPlannerApi recursion regression).
    expect(posts).toHaveLength(1)
    expect(await outboxCount()).toBe(0)

    // Cache reconciled: real row in, tmp row out.
    await vi.waitFor(async () => {
      const peek = await cache.peekCache<{ id: string }[]>('taskItems', `L1|${tz()}`)
      const ids = (peek?.value ?? []).map((i) => i.id)
      expect(ids).toContain('item_srv_1')
      expect(ids.some((id) => id.startsWith('tmp_'))).toBe(false)
    })
  })

  it('setTaskItemCompleted returns a merged synth from the cached row (not a lossy skeleton)', async () => {
    serverItems.push({
      id: 'item_1',
      listId: 'L1',
      title: 'Walk dog',
      priority: 'high',
      completed: false,
    })
    await api.listTaskItems('L1') // seed the read cache

    const synth = await api.setTaskItemCompleted('L1', 'item_1', true)
    expect(synth.completed).toBe(true)
    expect(synth.title).toBe('Walk dog')
    expect(synth.priority).toBe('high')

    await drained()
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.body).toEqual({ completed: true })

    // Cache holds the completed row (optimistic, then confirmed by server).
    const peek = await cache.peekCache<{ id: string; completed: boolean }[]>(
      'taskItems',
      `L1|${tz()}`,
    )
    expect(peek?.value.find((i) => i.id === 'item_1')?.completed).toBe(true)
  })

  it('a 400 rejection drops the op and refetches the surface (visible revert)', async () => {
    serverItems.push({ id: 'item_1', listId: 'L1', title: 'T', completed: false })
    await api.listTaskItems('L1')
    failNextPatchWith = 400

    await api.setTaskItemCompleted('L1', 'item_1', true)
    await drained()

    // The reconcile refetch restored server truth (still not completed).
    await vi.waitFor(async () => {
      const peek = await cache.peekCache<{ id: string; completed: boolean }[]>(
        'taskItems',
        `L1|${tz()}`,
      )
      expect(peek?.value.find((i) => i.id === 'item_1')?.completed).toBe(false)
    })
  })

  it('a refetch racing a queued write does not wipe the optimistic row (rebase)', async () => {
    serverItems.push({ id: 'item_1', listId: 'L1', title: 'T', completed: false })
    await api.listTaskItems('L1')

    // Hold the PATCH so the op stays queued during the refetch.
    let release: () => void = () => {}
    patchGate = new Promise<void>((r) => {
      release = r
    })

    await api.setTaskItemCompleted('L1', 'item_1', true)
    // Server still says completed:false — but the queued op must win.
    const items = await api.listTaskItems('L1')
    expect(items.find((i) => i.id === 'item_1')?.completed).toBe(true)

    release()
    patchGate = null
    await drained()
  })

  it('updateSettings returns the merged doc instantly and flushes one PATCH', async () => {
    serverSettings = { themeMode: 'dark' }
    // Seed the settings cache like a normal boot would.
    await api.getSettings('shared')

    const merged = await api.updateSettings('shared', { themeColor: 'pink' })
    expect(merged).toEqual({ themeMode: 'dark', themeColor: 'pink' })

    await drained()
    const patches = calls.filter((c) => c.method === 'PATCH' && c.path.includes('/settings/'))
    expect(patches).toHaveLength(1)
    expect(patches[0]?.body).toEqual({ themeColor: 'pink' })
    expect(serverSettings).toEqual({ themeMode: 'dark', themeColor: 'pink' })
  })

  it('updateSettings null value deletes the key in the optimistic merge', async () => {
    serverSettings = { a: 1, b: 2 }
    await api.getSettings('planner')
    const merged = await api.updateSettings('planner', { b: null })
    expect(merged).toEqual({ a: 1 })
    await drained()
  })

  it('resolveKnownTmpId maps tmp→real after the create flushes, and resets on purge', async () => {
    const engine = await import('./offline/engine.js')
    const hooks = await import('./offline/hooks.js')
    const synth = await api.createTaskItem('L1', 'Track me')
    expect(engine.resolveKnownTmpId(synth.id)).toBe(synth.id) // unresolved yet
    await drained()
    expect(engine.resolveKnownTmpId(synth.id)).toBe('item_srv_1')
    await hooks.purgeOfflineUser(UID)
    expect(engine.resolveKnownTmpId(synth.id)).toBe(synth.id) // cleared on purge
  })

  it('updateNote folder move: source channel only sees the removal, target + all get the row', async () => {
    serverNotes.push({
      id: 'note_1',
      title: 'Move me',
      notes: null,
      folderId: 'fold_A',
      completed: false,
      completedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      deletedAt: null,
    })
    // Seed all three channels.
    await api.listNotes()
    await api.listNotes('fold_A')
    await api.listNotes('fold_B')

    await api.updateNote('note_1', { folderId: 'fold_B' })

    const all = await cache.peekCache<{ id: string; folderId: string }[]>('notes', 'all')
    const a = await cache.peekCache<{ id: string }[]>('notes', 'fold_A')
    const b = await cache.peekCache<{ id: string }[]>('notes', 'fold_B')
    expect(all?.value.find((n) => n.id === 'note_1')?.folderId).toBe('fold_B')
    expect(a?.value.some((n) => n.id === 'note_1')).toBe(false)
    expect(b?.value.some((n) => n.id === 'note_1')).toBe(true)

    await drained()
    expect(serverNotes[0]?.folderId).toBe('fold_B')
  })

  it('moves a note through Deleted and restores its closed state locally first', async () => {
    serverNotes.push({
      id: 'note_restore',
      title: 'Keep me',
      notes: 'body',
      folderId: 'fold_A',
      completed: false,
      completedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      deletedAt: null,
    })
    await api.listNotes()
    await api.listDeletedNotes()

    const closed = await api.updateNote('note_restore', { completed: true })
    expect(closed.completed).toBe(true)
    await drained()

    await api.deleteNote('note_restore')
    const liveAfterDelete = await cache.peekCache<{ id: string }[]>('notes', 'all')
    const deletedAfterDelete = await cache.peekCache<{ id: string; completed: boolean }[]>(
      'notes',
      'deleted',
    )
    expect(liveAfterDelete?.value.some((n) => n.id === 'note_restore')).toBe(false)
    expect(deletedAfterDelete?.value).toMatchObject([{ id: 'note_restore', completed: true }])
    await drained()
    expect(serverNotes[0]?.deletedAt).not.toBeNull()

    const restored = await api.restoreNote('note_restore')
    expect(restored).toMatchObject({ id: 'note_restore', completed: true, folderId: 'fold_A' })
    const liveAfterRestore = await cache.peekCache<{ id: string; completed: boolean }[]>(
      'notes',
      'all',
    )
    const deletedAfterRestore = await cache.peekCache<{ id: string }[]>('notes', 'deleted')
    expect(liveAfterRestore?.value).toMatchObject([{ id: 'note_restore', completed: true }])
    expect(deletedAfterRestore?.value).toEqual([])
    await drained()
    expect(serverNotes[0]?.deletedAt).toBeNull()
  })

  it('an update enqueued after its create resolved is rewritten to the real id', async () => {
    const synth = await api.createTaskItem('L1', 'New')
    await drained() // create flushed; queue empty; tmp resolved server-side

    // Page still holds the tmp id (pre-conversion useState copy) and toggles.
    await api.setTaskItemCompleted('L1', synth.id, true)
    await drained()

    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.path).toContain('/items/item_srv_')
    expect(patches[0]?.path).not.toContain('tmp_')
    // And the write actually landed server-side.
    expect(serverItems[0]?.completed).toBe(true)
  })
})
