import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import type { EventsClient } from '@rallypoint/events-client'
import {
  ListsClientError,
  type GroupDto,
  type ListDto,
  type ListItemDto,
  type ListsClient,
} from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the Planner Quick Notes BFF. A real planner session
// lives in a Miniflare D1; RPID is stubbed and the Lists/Events SDKs
// are in-memory fakes. The point is to prove the notes-specific behaviour:
// the notes list is provisioned lazily, item CRUD round-trips with the
// session actor, and — critically — the notes list is HIDDEN from the task
// surfaces (GET /lists and the Upcoming backlog), so notes never leak in as
// tasks.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

function isoNow(): string {
  return new Date().toISOString()
}

// A mutable in-memory Lists SDK modelling the slice contract the notes BFF
// relies on: createGroup auto-owns the actor; createList/createListItem
// require the actor to own the list's group; listItems is ungated.
function makeFakeLists(): { client: ListsClient } {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const items: ListItemDto[] = []

  function ownsGroup(actor: string, scopeId: string): boolean {
    return groups.some((g) => g.id === scopeId && g.createdBy === actor)
  }
  function listOf(listId: string): ListDto | undefined {
    return lists.find((l) => l.id === listId)
  }

  const client = {
    listGroups: async (actor: string) => groups.filter((g) => g.createdBy === actor),
    createGroup: async (input: { name: string }, actor: string) => {
      const g: GroupDto = {
        id: `lgr_${groups.length + 1}`,
        name: input.name,
        description: null,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      groups.push(g)
      return g
    },
    listLists: async (scope: { scopeType: string; scopeId: string }) =>
      lists.filter((l) => l.scopeType === scope.scopeType && l.scopeId === scope.scopeId),
    listItems: async (listId: string) => items.filter((i) => i.listId === listId),
    createList: async (input: Omit<ListDto, 'id' | 'incompleteCount' | 'createdBy' | 'createdAt' | 'updatedAt'>, actor: string) => {
      if (input.scopeType === 'list_group' && !ownsGroup(actor, input.scopeId)) {
        throw new ListsClientError(404, 'not_found', 'List group not found.')
      }
      const l: ListDto = {
        id: `lst_${lists.length + 1}`,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        listType: input.listType,
        name: input.name,
        visibility: input.visibility,
        color: input.color ?? null,
        incompleteCount: 0,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      lists.push(l)
      return l
    },
    createListItem: async (
      listId: string,
      input: { title: string; notes?: string | null; dueDate?: string | null; priority?: string | null },
      actor: string,
    ) => {
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const isTasks = list.listType === 'tasks'
      const it: ListItemDto = {
        id: `lit_${items.length + 1}`,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: null,
        completed: false,
        completedAt: null,
        status: isTasks ? 'todo' : null,
        priority: isTasks ? (input.priority === undefined ? 'medium' : input.priority) : null,
        dueDate: input.dueDate ?? null,
        position: items.length,
        customFields: {},
        seriesId: null,
        createdBy: actor,
        createdAt: isoNow(),
        updatedAt: isoNow(),
      }
      items.push(it)
      return it
    },
    updateListItem: async (
      listId: string,
      itemId: string,
      patch: { title?: string; notes?: string | null },
      _actor: string,
    ) => {
      const it = items.find((x) => x.id === itemId && x.listId === listId)
      if (!it) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      if (patch.title !== undefined) it.title = patch.title
      if (patch.notes !== undefined) it.notes = patch.notes
      return it
    },
    deleteListItem: async (listId: string, itemId: string, _actor: string) => {
      const idx = items.findIndex((x) => x.id === itemId && x.listId === listId)
      if (idx === -1) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      items.splice(idx, 1)
    },
  } as unknown as ListsClient

  return { client }
}

// Events SDK stub — notes tests don't exercise events, so both reads are []
// (the Upcoming route fans out to events too).
function makeFakeEvents(): { client: EventsClient } {
  const client = {
    listPersonalEvents: async () => [],
    listUserEvents: async () => [],
  } as unknown as EventsClient
  return { client }
}

interface UpcomingResponse {
  dated: { id: string }[]
  undated: { id: string }[]
}

describe('D1 integration — Planner Quick Notes BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>

  const baseServices = (): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
    listsClient: makeFakeLists().client,
    eventsClient: makeFakeEvents().client,
    settings: { get: async () => ({}), patch: async () => ({}) },
  })

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
  })

  beforeEach(() => {
    app = buildApp({ env, logger: undefined, repos, services: baseServices() })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { PLANNER_SESSION_KEY_V1: env.PLANNER_SESSION_KEY_V1 },
      keyVersion: env.PLANNER_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
      ipHash: '',
      uaHash: '',
    })
    return rawBearer
  }

  function headers(bearer: string, extra?: Record<string, string>): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      ...extra,
    }
  }

  function postNote(bearer: string, body: unknown) {
    return app.request('http://localhost/api/v1/ui/notes', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
  }

  it('requires a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/notes', {
      headers: { cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`, 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('GET /notes returns [] before any note exists', async () => {
    const bearer = await loginAs('user_n1')
    const res = await app.request('http://localhost/api/v1/ui/notes', { headers: headers(bearer) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST /notes provisions the notes list and stores title + body', async () => {
    const bearer = await loginAs('user_n2')
    const res = await postNote(bearer, { title: 'Idea', notes: 'flesh this out' })
    expect(res.status).toBe(201)
    const note = (await res.json()) as ListItemDto
    expect(note.title).toBe('Idea')
    expect(note.notes).toBe('flesh this out')
    // Non-task list → task-only columns stay null.
    expect(note.status).toBeNull()
    expect(note.dueDate).toBeNull()

    const get = await app.request('http://localhost/api/v1/ui/notes', { headers: headers(bearer) })
    expect(((await get.json()) as ListItemDto[]).map((n) => n.title)).toEqual(['Idea'])
  })

  it('rejects a note with no title at the BFF boundary (400)', async () => {
    const bearer = await loginAs('user_n3')
    const res = await postNote(bearer, { notes: 'orphan body' })
    expect(res.status).toBe(400)
  })

  it('PATCH then DELETE a note round-trips', async () => {
    const bearer = await loginAs('user_n4')
    const note = (await (await postNote(bearer, { title: 'Draft' })).json()) as ListItemDto

    const patch = await app.request(`http://localhost/api/v1/ui/notes/${note.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ notes: 'now with a body' }),
    })
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as ListItemDto).notes).toBe('now with a body')

    const del = await app.request(`http://localhost/api/v1/ui/notes/${note.id}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(del.status).toBe(204)
    const after = await app.request('http://localhost/api/v1/ui/notes', { headers: headers(bearer) })
    expect((await after.json()) as ListItemDto[]).toEqual([])
  })

  it('PATCH 404s when the user has no notes list yet', async () => {
    const bearer = await loginAs('user_n5')
    const res = await app.request('http://localhost/api/v1/ui/notes/lit_nope', {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('hides the notes list from GET /lists (task rail)', async () => {
    const bearer = await loginAs('user_n6')
    // Provision a real task list AND a note for the same user.
    await app.request('http://localhost/api/v1/ui/lists', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Chores' }),
    })
    await postNote(bearer, { title: 'A note' })

    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const rows = (await res.json()) as ListDto[]
    expect(rows.map((l) => l.name)).toEqual(['Chores'])
    expect(rows.some((l) => l.listType === 'notes')).toBe(false)
  })

  it('keeps notes out of the Upcoming backlog (undated tasks)', async () => {
    const bearer = await loginAs('user_n7')
    await postNote(bearer, { title: 'Just a note' })
    const res = await app.request('http://localhost/api/v1/ui/upcoming?date=2026-06-05&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as UpcomingResponse
    // A note has no dueDate; without the notes-list filter it would land in
    // the undated backlog. The filter keeps it out entirely.
    expect(body.undated).toEqual([])
    expect(body.dated).toEqual([])
  })
})
