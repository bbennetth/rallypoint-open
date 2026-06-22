import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import type { EventsClient, HolidayDto } from '@rallypoint/events-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for GET /api/v1/ui/holidays (#548).
// Real planner D1 session; events-client faked (no live events-api).
// Verifies:
//   - Session gate (401 without session)
//   - holidaysEnabled absent → returns holidays
//   - holidaysEnabled true → returns holidays
//   - holidaysEnabled false → returns []
//   - hiddenHolidays filter removes specified ids
//   - Missing from/to → 400

const CSRF = 'csrf_token_holidays_test_aaaaaaaaaaaaaaaaaaa'

const SAMPLE_HOLIDAYS: HolidayDto[] = [
  { id: 'us-federal:independence', name: 'Independence Day', date: '2026-07-04', observedDate: '2026-07-03' },
  { id: 'us-federal:labor', name: 'Labor Day', date: '2026-09-07', observedDate: '2026-09-07' },
]

function makeFakeEventsClient(holidays: HolidayDto[] = SAMPLE_HOLIDAYS): EventsClient {
  return {
    getEvent: async () => { throw new Error('not stubbed') },
    getLineup: async () => { throw new Error('not stubbed') },
    getSessions: async () => { throw new Error('not stubbed') },
    createPersonalEvent: async () => { throw new Error('not stubbed') },
    listPersonalEvents: async () => [],
    getPersonalEvent: async () => { throw new Error('not stubbed') },
    patchPersonalEvent: async () => { throw new Error('not stubbed') },
    deletePersonalEvent: async () => {},
    listUserEvents: async () => [],
    setGroupEventPlannerPref: async () => {},
    listPlannerGroupEvents: async () => [],
    uploadTicket: async () => { throw new Error('not stubbed') },
    listTickets: async () => [],
    downloadTicket: async () => { throw new Error('not stubbed') },
    listHolidays: async () => holidays,
  }
}

describe('D1 integration — Planner Holidays BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>

  const baseServices = (
    settings: { get: () => Promise<Record<string, unknown>> } = { get: async () => ({}) },
    eventsClient: EventsClient = makeFakeEventsClient(),
  ): Services => ({
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
    listsClient: {
      health: async () => ({ status: 'stub' }),
      listLists: async () => [],
      listItems: async () => [],
      listFieldDefs: async () => [],
      listStatuses: async () => [],
      listLabels: async () => [],
      listGroups: async () => [],
      createGroup: async () => { throw new Error('not stubbed') },
      createList: async () => { throw new Error('not stubbed') },
      deleteList: async () => {},
      createListItem: async () => { throw new Error('not stubbed') },
      updateListItem: async () => { throw new Error('not stubbed') },
      moveListItem: async () => { throw new Error('not stubbed') },
      deleteListItem: async () => {},
      createListItemSeries: async () => { throw new Error('not stubbed') },
      listSeries: async () => [],
      updateSeries: async () => { throw new Error('not stubbed') },
      deleteSeries: async () => {},
      createFieldDef: async () => { throw new Error('not stubbed') },
      updateFieldDef: async () => { throw new Error('not stubbed') },
      deleteFieldDef: async () => {},
      listComments: async () => [],
      createComment: async () => { throw new Error('not stubbed') },
    },
    eventsClient,
    settings: { get: settings.get, patch: async () => ({}) },
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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
    }
  }

  async function req(bearer: string, from?: string, to?: string, overrideApp = app): Promise<Response> {
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    return overrideApp.request(`http://localhost/api/v1/ui/holidays?${qs.toString()}`, {
      method: 'GET',
      headers: headers(bearer),
    })
  }

  it('401s without a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/holidays?from=2026-01-01&to=2026-12-31', {
      method: 'GET',
      headers: { 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('400s when from is missing', async () => {
    const bearer = await loginAs('user_holidays_missing_from')
    const res = await req(bearer, undefined, '2026-12-31')
    expect(res.status).toBe(400)
  })

  it('400s when to is missing', async () => {
    const bearer = await loginAs('user_holidays_missing_to')
    const res = await req(bearer, '2026-01-01', undefined)
    expect(res.status).toBe(400)
  })

  it('400s when from is after to', async () => {
    const bearer = await loginAs('user_holidays_missing_to')
    const res = await req(bearer, '2026-12-31', '2026-01-01')
    expect(res.status).toBe(400)
  })

  it('returns holidays when holidaysEnabled is absent (default on)', async () => {
    const bearer = await loginAs('user_holidays_default')
    const a = buildApp({ env, logger: undefined, repos, services: baseServices({ get: async () => ({}) }) })
    const res = await req(bearer, '2026-07-01', '2026-09-30', a)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { holidays: HolidayDto[] }
    expect(body.holidays.length).toBe(2)
  })

  it('returns holidays when holidaysEnabled is explicitly true', async () => {
    const bearer = await loginAs('user_holidays_true')
    const a = buildApp({ env, logger: undefined, repos, services: baseServices({ get: async () => ({ holidaysEnabled: true }) }) })
    const res = await req(bearer, '2026-07-01', '2026-09-30', a)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { holidays: HolidayDto[] }
    expect(body.holidays.length).toBe(2)
  })

  it('returns [] when holidaysEnabled is false', async () => {
    const bearer = await loginAs('user_holidays_disabled')
    const a = buildApp({ env, logger: undefined, repos, services: baseServices({ get: async () => ({ holidaysEnabled: false }) }) })
    const res = await req(bearer, '2026-07-01', '2026-09-30', a)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { holidays: HolidayDto[] }
    expect(body.holidays).toEqual([])
  })

  it('filters out hiddenHolidays ids', async () => {
    const bearer = await loginAs('user_holidays_hidden')
    const a = buildApp({
      env, logger: undefined, repos,
      services: baseServices({ get: async () => ({ hiddenHolidays: ['us-federal:independence'] }) }),
    })
    const res = await req(bearer, '2026-07-01', '2026-09-30', a)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { holidays: HolidayDto[] }
    expect(body.holidays.some((h) => h.id === 'us-federal:independence')).toBe(false)
    expect(body.holidays.some((h) => h.id === 'us-federal:labor')).toBe(true)
  })
})
