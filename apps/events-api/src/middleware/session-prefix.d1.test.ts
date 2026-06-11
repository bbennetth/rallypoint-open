import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken } from '@rallypoint/crypto'
import { EVENTS_SESSION_BEARER_PREFIX } from './session.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from '../routes/_test-services.js'

// D1 integration tests for the events session middleware prefix
// fail-fast: a cookie with the wrong prefix is now treated the same as
// an unknown token (clear-cookie + 401) rather than just a throw.

const CSRF = 'csrf_token_value_prefix_test_aaaaaaaaaaaaa'

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
  weather: {
    getEventWeather: async () => ({ forecast: null, airQuality: null, issuedAt: new Date().toISOString() }),
  },
  settings: {
    get: async () => ({}),
    patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
  },
  profiles: {
    lookup: async () => null,
  },
}

describe('events session middleware — prefix fail-fast', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  function uiHeaders(cookieValue: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${cookieValue}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
    }
  }

  it('401 + clears cookie for a cookie value with the wrong prefix (garbage token)', async () => {
    // Any value that doesn't start with the events prefix.
    const badToken = 'garbage_noteventsprefix_abc123xyz'
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'GET',
      headers: uiHeaders(badToken),
    })
    expect(res.status).toBe(401)
    // Must clear the stale cookie — the key behaviour added by this fix.
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(envVars.EVENTS_SESSION_COOKIE_NAME)
    expect(setCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i)
  })

  it('401 + clears cookie for a right-prefixed but unknown token', async () => {
    // Correct prefix, but the token was never minted — no row in DB.
    const unknownBearer = generateRawToken(EVENTS_SESSION_BEARER_PREFIX)
    const res = await app.request('http://localhost/api/v1/ui/events', {
      method: 'GET',
      headers: uiHeaders(unknownBearer),
    })
    expect(res.status).toBe(401)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(envVars.EVENTS_SESSION_COOKIE_NAME)
    expect(setCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i)
  })
})
