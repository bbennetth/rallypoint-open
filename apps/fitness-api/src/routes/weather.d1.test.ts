import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services, WeatherForecastResult } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the coordinate weather proxy (running weather
// snapshots). The EVENTS RPC hop is stubbed; what's under test is the
// route contract: session gate, param validation, discriminated-error
// mapping, rate limiting, and the missing-binding 503.

const CSRF = 'csrf_token_value_weather_aaaaaaaaaaaaaaaaa'

const FORECAST = {
  forecast: { current: { temperature: 18.2, weatherCode: 1, isDay: true } },
  airQuality: null,
}

function servicesWithWeather(
  getForecast: ((opts: {
    lat: number
    lng: number
    tz?: string
    date?: string
  }) => Promise<WeatherForecastResult>) | null,
): Services {
  return {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
    profiles: { lookup: async () => null },
    settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
    offClient: { lookup: async () => null },
    weather: getForecast ? { getForecast } : null,
  }
}

describe('D1 integration — coordinate weather proxy', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let db: Db
  let lastCall: { lat: number; lng: number; tz?: string; date?: string } | null = null

  beforeAll(async () => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({
      env: envVars,
      logger: undefined,
      repos,
      services: servicesWithWeather(async (opts) => {
        lastCall = opts
        if (opts.tz === 'Not/AZone') return { kind: 'bad_tz' }
        if (opts.date === '2026-99-99') return { kind: 'bad_date' }
        return { kind: 'ok', data: FORECAST }
      }),
    })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(FITNESS_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { FITNESS_SESSION_KEY_V1: envVars.FITNESS_SESSION_KEY_V1 },
      keyVersion: envVars.FITNESS_SESSION_KEY_VERSION,
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

  function get(bearer: string, qs: string): Promise<Response> {
    return app.request(`http://localhost/api/v1/ui/weather?${qs}`, {
      headers: {
        cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
        origin: envVars.FITNESS_UI_ORIGIN,
      },
    })
  }

  it('rejects without a session (401)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/weather?lat=1&lng=2', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('returns the forecast envelope and forwards lat/lng/tz/date', async () => {
    const bearer = await loginAs('user_weather_ok')
    const res = await get(bearer, 'lat=40.7&lng=-74.0&tz=America/New_York&date=2026-07-14')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(FORECAST)
    expect(lastCall).toEqual({
      lat: 40.7,
      lng: -74.0,
      tz: 'America/New_York',
      date: '2026-07-14',
    })
  })

  it('rejects missing / out-of-range coordinates (400)', async () => {
    const bearer = await loginAs('user_weather_badll')
    for (const qs of ['', 'lat=91&lng=0', 'lat=0&lng=181', 'lat=abc&lng=0']) {
      const res = await get(bearer, qs)
      expect(res.status, qs).toBe(400)
    }
  })

  it('maps upstream bad_tz / bad_date discriminants to 400', async () => {
    const bearer = await loginAs('user_weather_badtz')
    expect((await get(bearer, 'lat=1&lng=2&tz=Not/AZone')).status).toBe(400)
    expect((await get(bearer, 'lat=1&lng=2&date=2026-99-99')).status).toBe(400)
  })

  it('503s when the EVENTS binding is absent', async () => {
    const noBinding = buildApp({
      env: envVars,
      logger: undefined,
      repos,
      services: servicesWithWeather(null),
    })
    const bearer = await loginAs('user_weather_nobind')
    const res = await noBinding.request('http://localhost/api/v1/ui/weather?lat=1&lng=2', {
      headers: {
        cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
        'x-rp-csrf': CSRF,
      },
    })
    expect(res.status).toBe(503)
  })

  it('rate limits per user after 30 requests/min (429 + Retry-After)', async () => {
    const bearer = await loginAs('user_weather_ratelimit')
    let last: Response | null = null
    for (let i = 0; i < 31; i += 1) {
      last = await get(bearer, 'lat=1&lng=2')
    }
    expect(last!.status).toBe(429)
    expect(last!.headers.get('Retry-After')).toBeTruthy()

    // A different user is unaffected (per-user bucket, not per-IP).
    const other = await loginAs('user_weather_ratelimit_other')
    expect((await get(other, 'lat=1&lng=2')).status).toBe(200)
  })
})
