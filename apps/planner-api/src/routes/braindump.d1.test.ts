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

// Integration tests for the Planner Brain Dump BFF. A real planner session
// lives in Miniflare D1; RPID, the Lists SDK and the Workers AI binding are
// in-memory fakes (mirrors diary.d1.test.ts for provisioning/seeding/task-
// surface exclusion, and assist.d1.test.ts for the AI-call gating/parsing/
// rate-limit shape).

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

function isoNow(): string {
  return new Date().toISOString()
}

// In-memory Lists SDK with the slice the braindump BFF + generic list routes
// use: group/list provisioning, item CRUD, and custom-field defs (for the
// Category / AI Analysis seed).
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

// A mutable fake Workers AI binding, mirroring assist.d1.test.ts.
interface FakeAi {
  run: (model: string, input: Record<string, unknown>, options?: unknown) => Promise<unknown>
  calls: { model: string; input: Record<string, unknown> }[]
  next: unknown
  fail: boolean
}
function makeFakeAi(): FakeAi {
  const fake: FakeAi = {
    calls: [],
    next: null,
    fail: false,
    run: async (model, input) => {
      fake.calls.push({ model, input })
      if (fake.fail) throw new Error('boom')
      return { response: fake.next }
    },
  }
  return fake
}

interface FakeTraces {
  recordTrace: (...args: unknown[]) => Promise<void>
  recordFeedback: (fb: unknown) => Promise<{ ok: boolean }>
}
function makeFakeTraces(): FakeTraces {
  return {
    recordTrace: async () => {},
    recordFeedback: async () => ({ ok: true }),
  }
}

interface UpcomingResponse {
  dated: { id: string }[]
  undated: { id: string }[]
}

describe('D1 integration — Planner Brain Dump BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fakeLists: ReturnType<typeof makeFakeLists>
  let ai: FakeAi
  let traces: FakeTraces

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
    ai = makeFakeAi()
    traces = makeFakeTraces()
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
      origin: env.PLANNER_UI_ORIGIN,
      ...extra,
    }
  }

  const bindings = () => ({ AI: ai, AI_TRACES: traces })

  function getBraindumpList(bearer: string) {
    return app.request('http://localhost/api/v1/ui/braindump/list', { headers: headers(bearer) })
  }

  function enrichReq(bearer: string, body: unknown, withAi = true) {
    return app.request(
      'http://localhost/api/v1/ui/braindump/enrich',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
      withAi ? bindings() : { AI_TRACES: traces },
    )
  }

  function summaryReq(bearer: string, body: unknown, withAi = true) {
    return app.request(
      'http://localhost/api/v1/ui/braindump/summary',
      {
        method: 'POST',
        headers: headers(bearer, { 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
      withAi ? bindings() : { AI_TRACES: traces },
    )
  }

  const goodEnrichBody = {
    text: 'Had a great idea for the app today',
    clientNow: '2026-08-20T14:03:00Z',
    tz: 'UTC',
  }
  const goodSummaryBody = {
    entries: [{ date: '2026-08-19', category: 'Ideas', text: 'Wrote some notes.' }],
  }

  // --- provision route --------------------------------------------------

  it('requires a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/braindump/list', {
      headers: { cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`, 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('provisions a braindump-type list and seeds Category + AI Analysis fields on first access', async () => {
    const bearer = await loginAs('user_bd1')
    const res = await getBraindumpList(bearer)
    expect(res.status).toBe(200)
    const list = (await res.json()) as ListDto
    expect(list.listType).toBe('braindump')
    expect(list.name).toBe('Brain Dump')

    const fields = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${list.id}/fields`, {
        headers: headers(bearer),
      })
    ).json()) as FieldDefDto[]

    const category = fields.find((f) => f.label === 'Category')
    expect(category).toBeDefined()
    expect(category!.fieldType).toBe('single_select')
    expect((category!.options.choices ?? []).map((c) => c.label)).toEqual([
      'Ideas',
      'Feelings',
      'Work',
      'Health',
      'People',
      'Plans',
      'Journal',
      'Reference',
      'Other',
    ])

    const aiAnalysis = fields.find((f) => f.label === 'AI Analysis')
    expect(aiAnalysis).toBeDefined()
    expect(aiAnalysis!.fieldType).toBe('text')
  })

  it('is idempotent: second access returns the same list and does not duplicate field defs', async () => {
    const bearer = await loginAs('user_bd2')
    const first = (await (await getBraindumpList(bearer)).json()) as ListDto
    const second = (await (await getBraindumpList(bearer)).json()) as ListDto
    expect(second.id).toBe(first.id)
    // Category + AI Analysis created exactly once each (seed runs only on creation).
    expect(fakeLists.createFieldDefCalls()).toBe(2)
    const fields = (await (
      await app.request(`http://localhost/api/v1/ui/lists/${first.id}/fields`, {
        headers: headers(bearer),
      })
    ).json()) as FieldDefDto[]
    expect(fields.filter((f) => f.label === 'Category')).toHaveLength(1)
    expect(fields.filter((f) => f.label === 'AI Analysis')).toHaveLength(1)
  })

  it('hides the brain-dump list from GET /lists (task rail)', async () => {
    const bearer = await loginAs('user_bd3')
    await getBraindumpList(bearer) // provisions the braindump list + personal group
    const res = await app.request('http://localhost/api/v1/ui/lists', { headers: headers(bearer) })
    const rows = (await res.json()) as ListDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0].listType).toBe('tasks')
    expect(rows.some((l) => l.listType === 'braindump')).toBe(false)
  })

  it('keeps a dated brain-dump entry out of the Upcoming feed', async () => {
    const bearer = await loginAs('user_bd4')
    const list = (await (await getBraindumpList(bearer)).json()) as ListDto
    const create = await app.request(`http://localhost/api/v1/ui/lists/${list.id}/items`, {
      method: 'POST',
      headers: headers(bearer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'Big idea', notes: 'wrote it down', dueDate: '2026-08-20' }),
    })
    expect(create.status).toBe(201)

    const res = await app.request('http://localhost/api/v1/ui/upcoming?date=2026-08-01&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as UpcomingResponse
    expect(body.dated).toEqual([])
    expect(body.undated).toEqual([])
  })

  // --- enrich -------------------------------------------------------------

  describe('POST /api/v1/ui/braindump/enrich', () => {
    it('503s when no AI binding is present', async () => {
      const bearer = await loginAs('user_e_no_ai')
      const res = await enrichReq(bearer, goodEnrichBody, false)
      expect(res.status).toBe(503)
    })

    it('422s on unparsable model output', async () => {
      const bearer = await loginAs('user_e_bad')
      ai.next = 'I could not analyze that.'
      const res = await enrichReq(bearer, goodEnrichBody)
      expect(res.status).toBe(422)
    })

    it('returns the coerced enrichment shape on success', async () => {
      const bearer = await loginAs('user_e_ok')
      ai.next = JSON.stringify({
        category: 'Ideas',
        title: 'App idea',
        themes: ['product'],
        entities: [{ name: 'Sam', kind: 'person' }],
        summary: 'A new feature idea.',
        tasks: [{ title: 'Follow up', date: null, time: null }],
        events: [],
      })
      const res = await enrichReq(bearer, goodEnrichBody)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.category).toBe('Ideas')
      expect(body.title).toBe('App idea')
      expect(body.themes).toEqual(['product'])
      expect(body.entities).toEqual([{ name: 'Sam', kind: 'person' }])
      expect(body.taskSuggestions).toEqual([{ title: 'Follow up', dueDate: null }])
      expect(body.eventSuggestions).toEqual([])
      expect(body.traceId).toBeTruthy()
      expect(body.responseId).toBeTruthy()
    })

    it('accepts a request carrying knownConcepts', async () => {
      const bearer = await loginAs('user_e_known')
      ai.next = JSON.stringify({
        category: 'Ideas',
        title: 'App idea',
        themes: ['product'],
        entities: [],
        summary: null,
        tasks: [],
        events: [],
      })
      const res = await enrichReq(bearer, { ...goodEnrichBody, knownConcepts: ['skin', 'Sam'] })
      expect(res.status).toBe(200)
    })

    it('400s on a malformed request body', async () => {
      const bearer = await loginAs('user_e_400')
      const res = await enrichReq(bearer, { text: '', clientNow: 'nope', tz: '' })
      expect(res.status).toBe(400)
      expect(ai.calls.length).toBe(0)
    })

    it('rate-limits enrich per user at 15/min under the ai-braindump bucket', async () => {
      const bearer = await loginAs('user_e_rl')
      const seen: string[] = []
      const stubbedRateLimit = {
        async takeToken(input: { bucketKey: string }) {
          seen.push(input.bucketKey)
          return { allowed: false, retryAfterSeconds: 12, blendedCount: 16 }
        },
        async reset() {},
        async pruneOldBuckets() {
          return 0
        },
      }
      const rlApp = buildApp({
        env,
        logger: undefined,
        repos: { ...repos, rateLimit: stubbedRateLimit } as unknown as Repos,
        services: baseServices(),
      })
      const res = await rlApp.request(
        'http://localhost/api/v1/ui/braindump/enrich',
        {
          method: 'POST',
          headers: headers(bearer, { 'content-type': 'application/json' }),
          body: JSON.stringify(goodEnrichBody),
        },
        bindings(),
      )
      expect(res.status).toBe(429)
      expect(res.headers.get('Retry-After')).toBe('12')
      expect(seen).toEqual(['user:user_e_rl:ai-braindump'])
      expect(ai.calls.length).toBe(0)
    })
  })

  // --- summary --------------------------------------------------------------

  describe('POST /api/v1/ui/braindump/summary', () => {
    it('503s when no AI binding is present', async () => {
      const bearer = await loginAs('user_s_no_ai')
      const res = await summaryReq(bearer, goodSummaryBody, false)
      expect(res.status).toBe(503)
    })

    it('422s on unparsable model output with summary-specific wording', async () => {
      const bearer = await loginAs('user_s_bad')
      ai.next = 'nonsense'
      const res = await summaryReq(bearer, goodSummaryBody)
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('braindump_ai_unparsable')
      // Not enrich's "the dump is saved — try Analyze" — nothing was saved.
      expect(body.error.message).toContain('summarize')
      expect(body.error.message).not.toContain('Analyze')
    })

    it('422s when the model output is cut off mid-JSON (token-cap truncation)', async () => {
      const bearer = await loginAs('user_s_trunc')
      ai.next = '{"highlights":["You started the period tired",\n"Mid-period you'
      const res = await summaryReq(bearer, goodSummaryBody)
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('braindump_ai_unparsable')
    })

    it('returns the coerced summary shape on success', async () => {
      const bearer = await loginAs('user_s_ok')
      ai.next = JSON.stringify({
        summary: 'A calm and productive week.',
        highlights: ['Wrote three entries'],
        moodTrend: 'Steady and upbeat.',
      })
      const res = await summaryReq(bearer, goodSummaryBody)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.summary).toBe('A calm and productive week.')
      expect(body.highlights).toEqual(['Wrote three entries'])
      expect(body.moodTrend).toBe('Steady and upbeat.')
      expect(body.traceId).toBeTruthy()
      expect(body.responseId).toBeTruthy()
    })

    it('400s on an empty entries array', async () => {
      const bearer = await loginAs('user_s_400')
      const res = await summaryReq(bearer, { entries: [] })
      expect(res.status).toBe(400)
      expect(ai.calls.length).toBe(0)
    })
  })
})
