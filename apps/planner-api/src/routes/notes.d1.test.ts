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
    deleteList: async (listId: string, actor: string) => {
      const idx = lists.findIndex((l) => l.id === listId)
      if (idx === -1 || (lists[idx].scopeType === 'list_group' && !ownsGroup(actor, lists[idx].scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      lists.splice(idx, 1)
    },
    moveListItem: async (listId: string, itemId: string, targetListId: string, actor: string) => {
      // Model the lists-api move contract the BFF relies on: actor must own
      // both lists, target must exist + differ, item must belong to source.
      const source = listOf(listId)
      const target = listOf(targetListId)
      if (!source || (source.scopeType === 'list_group' && !ownsGroup(actor, source.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      if (!target || (target.scopeType === 'list_group' && !ownsGroup(actor, target.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const it = items.find((x) => x.id === itemId && x.listId === listId)
      if (!it) throw new ListsClientError(404, 'item_not_found', 'Item not found.')
      it.listId = targetListId
      return it
    },
    findItemInScope: async (
      scope: { scopeType: string; scopeId: string },
      itemId: string,
      actor: string,
    ) => {
      // Model the lists-api contract: actor must be a member of the scope;
      // return the live item whose parent list lives in that exact scope,
      // else null (a foreign item, or one in another scope, resolves to null).
      if (scope.scopeType === 'list_group' && !ownsGroup(actor, scope.scopeId)) {
        throw new ListsClientError(404, 'list_not_found', 'List not found.')
      }
      const it = items.find((x) => x.id === itemId)
      if (!it) return null
      const list = listOf(it.listId)
      if (!list || list.scopeType !== scope.scopeType || list.scopeId !== scope.scopeId) {
        return null
      }
      return it
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
    // Create a note for the user (provisions the notes list + personal group).
    await postNote(bearer, { title: 'A note' })

    // GET /lists resolves the single canonical Tasks list (#543) — the notes
    // list must NOT appear among the task-rail lists.
    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const rows = (await res.json()) as ListDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0].listType).toBe('tasks')
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

  // --- folders (#549) ----------------------------------------------

  function postFolder(bearer: string, body: unknown) {
    return app.request('http://localhost/api/v1/ui/notes/folders', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
  }
  function getFolders(bearer: string) {
    return app.request('http://localhost/api/v1/ui/notes/folders', { headers: headers(bearer) })
  }

  interface FolderDto {
    id: string
    name: string
    isDefault: boolean
  }
  interface NoteRow {
    id: string
    title: string
    folderId: string
  }

  it('GET /notes/folders returns [] before any note exists', async () => {
    const bearer = await loginAs('user_f1')
    const res = await getFolders(bearer)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('creating a folder provisions the default Notes folder + the new one', async () => {
    const bearer = await loginAs('user_f2')
    const res = await postFolder(bearer, { name: 'Work' })
    expect(res.status).toBe(201)
    const folders = (await (await getFolders(bearer)).json()) as FolderDto[]
    // Default 'Notes' (oldest, isDefault) + the new 'Work' folder.
    expect(folders).toHaveLength(2)
    expect(folders.filter((f) => f.isDefault)).toHaveLength(1)
    expect(folders.find((f) => f.isDefault)!.name).toBe('Notes')
    expect(folders.some((f) => f.name === 'Work' && !f.isDefault)).toBe(true)
  })

  it('rejects a duplicate folder name (case-insensitive) with 409', async () => {
    const bearer = await loginAs('user_f3')
    expect((await postFolder(bearer, { name: 'Work' })).status).toBe(201)
    const dup = await postFolder(bearer, { name: ' work ' })
    expect(dup.status).toBe(409)
  })

  it('refuses to delete a non-empty folder (409)', async () => {
    const bearer = await loginAs('user_f4')
    const folder = (await (await postFolder(bearer, { name: 'Work' })).json()) as FolderDto
    // Put a note in it via move.
    const note = (await (await postNote(bearer, { title: 'n' })).json()) as NoteRow
    const moved = await app.request(`http://localhost/api/v1/ui/notes/${note.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ folderId: folder.id }),
    })
    expect(moved.status).toBe(200)
    const del = await app.request(`http://localhost/api/v1/ui/notes/folders/${folder.id}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(del.status).toBe(409)
  })

  it('refuses to delete the default Notes folder (409)', async () => {
    const bearer = await loginAs('user_f5')
    await postNote(bearer, { title: 'n' }) // provisions the default folder
    const folders = (await (await getFolders(bearer)).json()) as FolderDto[]
    const def = folders.find((f) => f.isDefault)!
    const del = await app.request(`http://localhost/api/v1/ui/notes/folders/${def.id}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(del.status).toBe(409)
  })

  it('deletes an empty non-default folder (204)', async () => {
    const bearer = await loginAs('user_f6')
    const folder = (await (await postFolder(bearer, { name: 'Temp' })).json()) as FolderDto
    const del = await app.request(`http://localhost/api/v1/ui/notes/folders/${folder.id}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(del.status).toBe(204)
    const folders = (await (await getFolders(bearer)).json()) as FolderDto[]
    expect(folders.some((f) => f.id === folder.id)).toBe(false)
  })

  it('moves a note between folders via PATCH { folderId }', async () => {
    const bearer = await loginAs('user_f7')
    const folder = (await (await postFolder(bearer, { name: 'Work' })).json()) as FolderDto
    const note = (await (await postNote(bearer, { title: 'movable' })).json()) as NoteRow
    const res = await app.request(`http://localhost/api/v1/ui/notes/${note.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ folderId: folder.id }),
    })
    expect(res.status).toBe(200)
    // The note now reads under the Work folder filter, not the default.
    const inWork = (await (
      await app.request(`http://localhost/api/v1/ui/notes?folderId=${folder.id}`, {
        headers: headers(bearer),
      })
    ).json()) as NoteRow[]
    expect(inWork.map((n) => n.id)).toEqual([note.id])
  })

  it('404s a move to a folder the actor does not own', async () => {
    const bearer = await loginAs('user_f8')
    const note = (await (await postNote(bearer, { title: 'n' })).json()) as NoteRow
    const res = await app.request(`http://localhost/api/v1/ui/notes/${note.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ folderId: 'lst_not_mine' }),
    })
    expect(res.status).toBe(404)
  })

  it('GET /notes returns notes across all folders, each tagged with folderId', async () => {
    const bearer = await loginAs('user_f9')
    const work = (await (await postFolder(bearer, { name: 'Work' })).json()) as FolderDto
    const a = (await (await postNote(bearer, { title: 'default-note' })).json()) as NoteRow
    const b = (await (await postNote(bearer, { title: 'to-move' })).json()) as NoteRow
    await app.request(`http://localhost/api/v1/ui/notes/${b.id}`, {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ folderId: work.id }),
    })
    const all = (await (
      await app.request('http://localhost/api/v1/ui/notes', { headers: headers(bearer) })
    ).json()) as NoteRow[]
    const byId = new Map(all.map((n) => [n.id, n.folderId]))
    expect(byId.get(a.id)).toBeDefined()
    expect(byId.get(b.id)).toBe(work.id)
    expect(byId.get(a.id)).not.toBe(work.id)
  })

  it('?folderId 404s a folder the actor does not own', async () => {
    const bearer = await loginAs('user_f10')
    await postNote(bearer, { title: 'n' })
    const res = await app.request('http://localhost/api/v1/ui/notes?folderId=lst_nope', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(404)
  })

  it('still hides EVERY notes folder from the task rail', async () => {
    const bearer = await loginAs('user_f11')
    await postFolder(bearer, { name: 'Work' }) // default + Work both notes-type
    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const rows = (await res.json()) as ListDto[]
    expect(rows.some((l) => l.listType === 'notes')).toBe(false)
  })

  // --- #559 hardening ----------------------------------------------

  it('maps a Lists 409 on folder create to folder_name_taken (race backstop)', async () => {
    const fake = makeFakeLists()
    const realCreate = fake.client.createList.bind(fake.client)
    // The default 'Notes' folder still provisions normally; only the racing
    // 'Recipes' create loses the lists_notes_folder_name_uq race and 409s —
    // modelling the concurrent create that slipped past the BFF pre-check.
    fake.client.createList = (async (input: { name: string }, actor: string) => {
      if (input.name === 'Recipes') {
        throw new ListsClientError(409, 'list_name_conflict', 'A list with that name already exists in this scope.')
      }
      return realCreate(input as never, actor)
    }) as ListsClient['createList']
    const raceApp = buildApp({
      env,
      logger: undefined,
      repos,
      services: { ...baseServices(), listsClient: fake.client },
    })
    const bearer = await loginAs('user_race')
    const res = await raceApp.request('http://localhost/api/v1/ui/notes/folders', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'Recipes' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('folder_name_taken')
  })

  it('404s a notes PATCH/DELETE for an in-scope item that is not a notes folder', async () => {
    const fake = makeFakeLists()
    const guardApp = buildApp({
      env,
      logger: undefined,
      repos,
      services: { ...baseServices(), listsClient: fake.client },
    })
    const bearer = await loginAs('user_guard')
    // Provision the default 'Notes' folder so listNotesFolders is non-empty.
    await guardApp.request('http://localhost/api/v1/ui/notes', {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'seed' }),
    })
    // Force the scoped lookup to resolve the id to an item in a NON-notes list
    // (e.g. the personal tasks list, which shares the scope). The notes routes
    // must still 404 it — only notes folders are addressable here (#559).
    fake.client.findItemInScope = (async () => ({
      id: 'lit_task',
      listId: 'lst_tasks_not_a_folder',
      title: 't',
      notes: null,
    })) as ListsClient['findItemInScope']
    const patch = await guardApp.request('http://localhost/api/v1/ui/notes/lit_task', {
      method: 'PATCH',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'hijack' }),
    })
    expect(patch.status).toBe(404)
    const del = await guardApp.request('http://localhost/api/v1/ui/notes/lit_task', {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(del.status).toBe(404)
  })
})
