import { env as testEnv } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken } from '@rallypoint/crypto'
import { PLANNER_SESSION_BEARER_PREFIX } from './session.js'

// D1 integration tests for the planner session middleware prefix
// fail-fast: a cookie with the wrong prefix is now treated the same as
// an unknown token (clear-cookie + 401) rather than just a throw.

const CSRF = 'csrf_token_value_prefix_test_aaaaaaaaaaaaa'

const services = {
  idClient: {
    verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
    signoutRpidBearer: async () => {},
  },
  rpidSso: {
    exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
  },
  profiles: {
    lookup: async () => null,
  },
  settings: {
    get: async () => ({}),
    patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
  },
} satisfies Partial<Services>

describe('planner session middleware — prefix fail-fast', () => {
  let repos: Repos
  let env: Env
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(testEnv.DB))
    env = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    // Cast: the session-gated route used here (/api/v1/ui/session) does not
    // call listsClient or eventsClient, so stub fields are safe.
    app = buildApp({ env, logger: undefined, repos, services: services as unknown as Services })
  })

  function uiHeaders(cookieValue: string): Record<string, string> {
    return {
      cookie: `${env.PLANNER_SESSION_COOKIE_NAME}=${cookieValue}; ${env.PLANNER_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
    }
  }

  it('401 + clears cookie for a cookie value with the wrong prefix (garbage token)', async () => {
    const badToken = 'garbage_notplannerprefix_abc123xyz'
    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: uiHeaders(badToken),
    })
    expect(res.status).toBe(401)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(env.PLANNER_SESSION_COOKIE_NAME)
    expect(setCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i)
  })

  it('401 + clears cookie for a right-prefixed but unknown token', async () => {
    const unknownBearer = generateRawToken(PLANNER_SESSION_BEARER_PREFIX)
    const res = await app.request('http://localhost/api/v1/ui/session', {
      method: 'GET',
      headers: uiHeaders(unknownBearer),
    })
    expect(res.status).toBe(401)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(env.PLANNER_SESSION_COOKIE_NAME)
    expect(setCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i)
  })
})
