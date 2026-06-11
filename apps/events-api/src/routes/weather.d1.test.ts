import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import type {
  WeatherProvider,
  WeatherProviderInput,
  WeatherProviderResult,
} from '../services/weather/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface CountingProvider extends WeatherProvider {
  calls: number
  nextResult: WeatherProviderResult | (() => Promise<WeatherProviderResult>)
}

function makeCountingProvider(result: WeatherProviderResult): CountingProvider {
  const p: CountingProvider = {
    calls: 0,
    nextResult: result,
    async getEventWeather(_input: WeatherProviderInput): Promise<WeatherProviderResult> {
      p.calls++
      const r = p.nextResult
      return typeof r === 'function' ? r() : r
    },
  }
  return p
}

describe('D1 integration — weather routes', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let provider: CountingProvider

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    provider = makeCountingProvider({
      forecast: {
        units: { temperature: 'C', precipitation: 'mm', windSpeed: 'km/h' },
        current: {
          temperature: 18,
          apparentTemperature: 17,
          windSpeed: 5,
          weatherCode: 1,
          isDay: true,
        },
        daily: [
          {
            date: '2026-06-01',
            temperatureMax: 22,
            temperatureMin: 12,
            precipitationSum: 0,
            precipitationProbabilityMax: 10,
            windSpeedMax: 12,
            uvIndexMax: 6,
            weatherCode: 1,
            sunrise: '2026-06-01T05:00:00Z',
            sunset: '2026-06-01T21:00:00Z',
          },
        ],
      },
      airQuality: {
        current: {
          usAqi: 42,
          europeanAqi: null,
          pm2_5: 8,
          pm10: 14,
          ozone: null,
          dust: null,
        },
        daily: [{ date: '2026-06-01', usAqiMax: 50, pm2_5Mean: 9, pm10Mean: 15 }],
      },
      issuedAt: new Date().toISOString(),
    })
    const services: Services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
      batchLookupUsers: async () => [],
      },
      rpidSso: {
        exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
      },
      rpidReauth: {
        verify: async () => ({ ok: true as const }),
      },
      objectStore: makeStubObjectStore(),
      listsClient: makeNoopListsClient(),
      moneyClient: makeNoopMoneyClient(),
      weather: provider,
      settings: {
        get: async () => ({}),
        patch: async (_u, _n, patch) => patch,
      },
    }
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })


  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(EVENTS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { EVENTS_SESSION_KEY_V1: envVars.EVENTS_SESSION_KEY_V1 },
      keyVersion: envVars.EVENTS_SESSION_KEY_VERSION,
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

  function authHeaders(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function authedReq(bearer: string, method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: authHeaders(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function publicReq(path: string): Promise<Response> {
    return app.request(`http://localhost${path}`)
  }

  // Create an event with coordinates + future-date window so it
  // qualifies. Slugs are server-generated, so the caller receives
  // both id and slug back from this helper.
  async function createWeatherEvent(
    bearer: string,
    nameSuffix: string,
  ): Promise<{ id: string; slug: string }> {
    const inOneWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const res = await authedReq(bearer, 'POST', '/api/v1/ui/events', {
      name: `Weather ${nameSuffix}`,
      timezone: 'UTC',
      startDate: inOneWeek,
      endDate: inOneWeek,
      locationLat: 51.5,
      locationLng: -0.12,
      privacyMode: 'public',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; slug: string }
    return { id: body.id, slug: body.slug }
  }

  async function enablePublic(bearer: string, eventId: string): Promise<void> {
    const res = await authedReq(bearer, 'PATCH', `/api/v1/ui/events/${eventId}`, {
      publicPageConfig: { enabled: true },
    })
    expect(res.status).toBe(200)
  }

  it('member sees populated forecast + AQI on first read, cached on the next', async () => {
    const owner = `user_${Date.now()}_w1`
    const bearer = await loginAs(owner)
    const { id } = await createWeatherEvent(bearer, `w1-${Date.now()}`)

    const callsBefore = provider.calls
    const res1 = await authedReq(bearer, 'GET', `/api/v1/ui/events/${id}/weather`)
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as { forecast: { daily: unknown[] }; airQuality: { current: unknown } }
    expect(body1.forecast.daily).toHaveLength(1)
    expect(body1.airQuality.current).not.toBeNull()
    expect(provider.calls).toBe(callsBefore + 1)

    // Second read inside freshness window — no new fetch.
    await authedReq(bearer, 'GET', `/api/v1/ui/events/${id}/weather`)
    expect(provider.calls).toBe(callsBefore + 1)
  })

  it('public SDK endpoint 404s a disabled event', async () => {
    const owner = `user_${Date.now()}_w2`
    const bearer = await loginAs(owner)
    const { slug } = await createWeatherEvent(bearer, `w2-${Date.now()}`)
    // No enablePublic call.
    const res = await publicReq(`/api/v1/sdk/events/${slug}/weather`)
    expect(res.status).toBe(404)
  })

  it('public SDK endpoint serves when enabled + public, includes Cache-Control', async () => {
    const owner = `user_${Date.now()}_w3`
    const bearer = await loginAs(owner)
    const { id, slug } = await createWeatherEvent(bearer, `w3-${Date.now()}`)
    await enablePublic(bearer, id)
    const res = await publicReq(`/api/v1/sdk/events/${slug}/weather`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('max-age=60')
    const body = (await res.json()) as { forecast: { daily: unknown[] } }
    expect(body.forecast.daily.length).toBeGreaterThan(0)
  })

  it('event without coordinates returns an empty weather payload (200, all nulls)', async () => {
    const owner = `user_${Date.now()}_w4`
    const bearer = await loginAs(owner)
    const createRes = await authedReq(bearer, 'POST', '/api/v1/ui/events', {
      name: 'No coords',
      timezone: 'UTC',
    })
    expect(createRes.status).toBe(201)
    const id = ((await createRes.json()) as { id: string }).id
    const callsBefore = provider.calls
    const res = await authedReq(bearer, 'GET', `/api/v1/ui/events/${id}/weather`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      forecast: unknown
      airQuality: unknown
      isStale: boolean
    }
    expect(body.forecast).toBeNull()
    expect(body.airQuality).toBeNull()
    expect(body.isStale).toBe(false)
    // Provider not called for ineligible events.
    expect(provider.calls).toBe(callsBefore)
  })

  it('non-member viewer gets 404 on the internal /weather endpoint', async () => {
    const owner = `user_${Date.now()}_w5`
    const bearer = await loginAs(owner)
    const { id } = await createWeatherEvent(bearer, `w5-${Date.now()}`)
    const stranger = `user_${Date.now()}_w5_str`
    const strangerBearer = await loginAs(stranger)
    const res = await authedReq(strangerBearer, 'GET', `/api/v1/ui/events/${id}/weather`)
    expect(res.status).toBe(404)
  })
})
