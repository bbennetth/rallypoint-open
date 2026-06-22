import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import type { EventsClient } from '@rallypoint/events-client'
import {
  ListsClientError,
  type FieldDefDto,
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

// Integration tests for the Planner Diary BFF. A real planner session lives in
// Miniflare D1; RPID + the Lists SDK are in-memory fakes. The point is to prove
// the diary-specific behaviour: the diary list provisions lazily with a seeded
// Mood field, the seed is idempotent, and — critically — the diary list is
// HIDDEN from the task surfaces (GET /lists, Upcoming) so dated journal entries
// never leak in as tasks.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

function isoNow(): string {
  return new Date().toISOString()
}

// In-memory Lists SDK with the slice the diary BFF + generic list routes use:
// group/list provisioning, item CRUD, and custom-field defs (for the Mood seed).
function makeFakeLists(): { client: ListsClient; createFieldDefCalls: () => number } {
  const groups: GroupDto[] = []
  const lists: ListDto[] = []
  const items: ListItemDto[] = []
  const fieldDefs: FieldDefDto[] = []
  let createFieldDefCalls = 0

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
    createList: async (
      input: Omit<ListDto, 'id' | 'incompleteCount' | 'createdBy' | 'createdAt' | 'updatedAt'>,
      actor: string,
    ) => {
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
      input: { title: string; notes?: string | null; dueDate?: string | null },
      actor: string,
    ) => {
      const list = listOf(listId)
      if (!list || (list.scopeType === 'list_group' && !ownsGroup(actor, list.scopeId))) {
        throw new ListsClientError(404, 'not_found', 'List not found.')
      }
      const it: ListItemDto = {
        id: `lit_${items.length + 1}`,
        listId,
        title: input.title,
        notes: input.notes ?? null,
        assignedTo: null,
        completed: false,
        completedAt: null,
        status: null,
        priority: null,
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
    listFieldDefs: async (listId: string) => fieldDefs.filter((f) => f.listId === listId),
    createFieldDef: async (
      listId: string,
      input: { label: string; fieldType: string; choices?: { label: string }[] },
      _actor: string,
    ) => {
      createFieldDefCalls += 1
      const f: FieldDefDto = {
        id: `lfd_${fieldDefs.length + 1}`,
        listId,
        key: input.label.toLowerCase(),
        label: input.label,
        fieldType: input.fieldType as FieldDefDto['fieldType'],
        options: { choices: (input.choices ?? []).map((c, i) => ({ id: `opt_${i}`, label: c.label })) },
        required: false,
        defaultValue: null,
        position: fieldDefs.length,
        createdAt: isoNow(),
      }
      fieldDefs.push(f)
      return f
    },
  } as unknown as ListsClient

  return { client, createFieldDefCalls: () => createFieldDefCalls }
}

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

describe('D1 integration — Planner Diary BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fakeLists: ReturnType<typeof makeFakeLists>

  const baseServices = (): Services => {
    fakeLists = makeFakeLists()
    return {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
      listsClient: fakeLists.client,
      eventsClient: makeFakeEvents().client,
      settings: { get: async () => ({}), patch: async () => ({}) },
    } as unknown as Services
  }

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

  function getDiaryList(bearer: string) {
    return app.request('http://localhost/api/v1/ui/diary/list', { headers: headers(bearer) })
  }

  it('requires a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/diary/list', {
      headers: { cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`, 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('provisions a diary-type list and seeds a Mood field on first access', async () => {
    const bearer = await loginAs('user_d1')
    const res = await getDiaryList(bearer)
    expect(res.status).toBe(200)
    const list = (await res.json()) as ListDto
    expect(list.listType).toBe('diary')
    expect(list.name).toBe('Diary')

    // The Mood field is readable via the generic fields route (any personal list).
    const fields = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${list.id}/fields`, {
        headers: headers(bearer),
      })
    ).json()) as FieldDefDto[]
    const mood = fields.find((f) => f.label === 'Mood')
    expect(mood).toBeDefined()
    expect(mood!.fieldType).toBe('single_select')
    expect((mood!.options.choices ?? []).length).toBeGreaterThan(0)
  })

  it('is idempotent: second access returns the same list and seeds Mood only once', async () => {
    const bearer = await loginAs('user_d2')
    const first = (await (await getDiaryList(bearer)).json()) as ListDto
    const second = (await (await getDiaryList(bearer)).json()) as ListDto
    expect(second.id).toBe(first.id)
    // The Mood field was created exactly once (seed runs only on creation).
    expect(fakeLists.createFieldDefCalls()).toBe(1)
    const fields = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${first.id}/fields`, {
        headers: headers(bearer),
      })
    ).json()) as FieldDefDto[]
    expect(fields.filter((f) => f.label === 'Mood')).toHaveLength(1)
  })

  it('hides the diary list from GET /lists (task rail)', async () => {
    const bearer = await loginAs('user_d3')
    await getDiaryList(bearer) // provisions the diary list + personal group
    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const rows = (await res.json()) as ListDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0].listType).toBe('tasks')
    expect(rows.some((l) => l.listType === 'diary')).toBe(false)
  })

  it('keeps a dated diary entry out of the Upcoming feed', async () => {
    const bearer = await loginAs('user_d4')
    const list = (await (await getDiaryList(bearer)).json()) as ListDto
    // Create a dated entry via the generic items route (what the Diary UI uses).
    const create = await app.request(`http://localhost/api/v1/ui/lists/${list.id}/items`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'Jun 5, 2026', notes: 'a good day', dueDate: '2026-06-05' }),
    })
    expect(create.status).toBe(201)

    const res = await app.request('http://localhost/api/v1/ui/upcoming?date=2026-06-01&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as UpcomingResponse
    // The diary list is excluded from every task surface, so the dated entry
    // never appears in the agenda despite carrying a dueDate.
    expect(body.dated).toEqual([])
    expect(body.undated).toEqual([])
  })
})
