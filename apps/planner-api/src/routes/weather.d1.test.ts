import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { env as testEnv } from 'cloudflare:test'
import type { Hono } from 'hono'
import type { EventsClient } from '@rallypoint/events-client'
import type { ListsClient } from '@rallypoint/lists-client'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { PLANNER_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the Planner Weather BFF — a thin proxy to the
// events-api coordinate forecast. RPID + the SDKs are in-memory fakes; the
// point is to prove session-gating, lat/lng validation, and that the route
// forwards the actor's coordinates to eventsClient.getForecast verbatim.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface ForecastCall {
  lat: number
  lng: number
  tz: string
  date?: string
}

const STUB_FORECAST = {
  forecast: {
    units: { temperature: 'C', precipitation: 'mm', windSpeed: 'km/h' },
    current: { temperature: 18, apparentTemperature: 17, windSpeed: 5, weatherCode: 1, isDay: true },
    daily: [{ date: '2026-06-01', temperatureMax: 22, temperatureMin: 12, precipitationProbabilityMax: 10, weatherCode: 1 }],
  },
  airQuality: null,
}

function makeFakeEvents(): { client: EventsClient; calls: ForecastCall[] } {
  const calls: ForecastCall[] = []
  const client = {
    listPersonalEvents: async () => [],
    listUserEvents: async () => [],
    getForecast: async (opts: ForecastCall) => {
      calls.push(opts)
      return STUB_FORECAST
    },
  } as unknown as EventsClient
  return { client, calls }
}

describe('D1 integration — Planner Weather BFF', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>
  let fakeEvents: ReturnType<typeof makeFakeEvents>

  const baseServices = (): Services => {
    fakeEvents = makeFakeEvents()
    return {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      rpidSso: { exchange: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) },
      listsClient: {} as unknown as ListsClient,
      eventsClient: fakeEvents.client,
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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${bearer}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
    }
  }

  it('requires a session', async () => {
    const res = await app.request('http://localhost/api/v1/ui/my-day/weather?lat=51.5&lng=-0.12&tz=UTC', {
      headers: { cookie: `${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`, 'x-rp-csrf': CSRF },
    })
    expect(res.status).toBe(401)
  })

  it('forwards the coordinates to eventsClient.getForecast and returns the forecast', async () => {
    const bearer = await loginAs('user_w1')
    const res = await app.request(
      'http://localhost/api/v1/ui/my-day/weather?lat=51.5&lng=-0.12&tz=UTC&date=2026-06-01',
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { forecast: { daily: unknown[] } }
    expect(body.forecast.daily.length).toBeGreaterThan(0)
    expect(fakeEvents.calls).toHaveLength(1)
    expect(fakeEvents.calls[0]).toEqual({ lat: 51.5, lng: -0.12, tz: 'UTC', date: '2026-06-01' })
  })

  it('400s an out-of-range coordinate and never calls the provider', async () => {
    const bearer = await loginAs('user_w2')
    const res = await app.request('http://localhost/api/v1/ui/my-day/weather?lat=999&lng=0&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(400)
    expect(fakeEvents.calls).toHaveLength(0)
  })

  it('omits date when not supplied', async () => {
    const bearer = await loginAs('user_w3')
    const res = await app.request('http://localhost/api/v1/ui/my-day/weather?lat=40&lng=-74&tz=UTC', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    expect(fakeEvents.calls[0]).toEqual({ lat: 40, lng: -74, tz: 'UTC' })
  })

  it('400s an invalid timezone and never calls the provider', async () => {
    const bearer = await loginAs('user_w4')
    const res = await app.request(
      'http://localhost/api/v1/ui/my-day/weather?lat=40&lng=-74&tz=Narnia',
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(400)
    expect(fakeEvents.calls).toHaveLength(0)
  })

  it('400s a malformed date and never calls the provider', async () => {
    const bearer = await loginAs('user_w5')
    const res = await app.request(
      'http://localhost/api/v1/ui/my-day/weather?lat=40&lng=-74&tz=UTC&date=not-a-date',
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(400)
    expect(fakeEvents.calls).toHaveLength(0)
  })
})
