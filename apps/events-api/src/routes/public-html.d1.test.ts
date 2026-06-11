import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'

// Integration tests for the OG-templated HTML route at GET /e/:slug.
// The route reads events-web's dist/index.html if it exists; in the
// test environment we don't ship a built SPA, so the dev fallback
// stub is what we verify. It must still inject og:title/og:description.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — public HTML / OG shell', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

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
      patch: async (_u, _n, patch) => patch,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
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

  async function authedReq(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: authHeaders(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('404s when the slug is missing or public_page_config is disabled', async () => {
    const missing = await app.request('http://localhost/e/nope')
    expect(missing.status).toBe(404)

    const owner = `user_${Date.now()}_html_off`
    const bearer = await loginAs(owner)
    const createRes = await authedReq(bearer, 'POST', '/api/v1/ui/events', {
      name: 'No Pub',
      timezone: 'UTC',
      privacyMode: 'public',
    })
    const { slug } = (await createRes.json()) as { slug: string }
    const res = await app.request(`http://localhost/e/${slug}`)
    expect(res.status).toBe(404)
  })

  it('renders the OG-templated SPA shell (dev fallback) with og:title equal to event name', async () => {
    const owner = `user_${Date.now()}_html_ok`
    const bearer = await loginAs(owner)
    const eventName = `Burning Camp 2026 <thing>` // intentionally has chars to escape
    const created = await authedReq(bearer, 'POST', '/api/v1/ui/events', {
      name: eventName,
      description: 'Stargazing & vibes',
      timezone: 'UTC',
      privacyMode: 'public',
    })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as { id: string; slug: string }
    const id = createdBody.id
    const slug = createdBody.slug
    await authedReq(bearer, 'PATCH', `/api/v1/ui/events/${id}`, {
      publicPageConfig: { enabled: true },
    })

    const res = await app.request(`http://localhost/e/${slug}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const html = await res.text()
    // og:title is HTML-escaped + present
    expect(html).toContain('property="og:title"')
    expect(html).toContain('Burning Camp 2026 &lt;thing&gt;')
    // og:description present (also escaped — the `&` becomes `&amp;`)
    expect(html).toContain('property="og:description"')
    expect(html).toContain('Stargazing &amp; vibes')
    // og:url uses EVENTS_UI_ORIGIN + /e/<slug>
    expect(html).toContain(`/e/${slug}`)
  })

  it('templates the real SPA shell served by the ASSETS binding (Worker path)', async () => {
    const owner = `user_${Date.now()}_html_assets`
    const bearer = await loginAs(owner)
    const created = await authedReq(bearer, 'POST', '/api/v1/ui/events', {
      name: 'Assets Shell Fest',
      timezone: 'UTC',
      privacyMode: 'public',
    })
    const { id, slug } = (await created.json()) as { id: string; slug: string }
    await authedReq(bearer, 'PATCH', `/api/v1/ui/events/${id}`, {
      publicPageConfig: { enabled: true },
    })

    // Stub the static-assets binding the way the Worker runtime supplies it.
    const SHELL =
      '<!doctype html><html><head><title>Rallypoint Events</title></head>' +
      '<body><div id="root"></div></body></html>'
    let requestedPath = ''
    const ASSETS = {
      fetch: async (input: Request | string | URL) => {
        requestedPath = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        ).pathname
        return new Response(SHELL, { headers: { 'content-type': 'text/html' } })
      },
    }

    const res = await app.request(
      `http://localhost/e/${slug}`,
      undefined,
      { ASSETS } as unknown as { ASSETS: typeof ASSETS },
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    // Fetched the index.html asset from the binding...
    expect(requestedPath).toBe('/index.html')
    // ...injected OG tags into the *real* shell (has the SPA mount node)...
    expect(html).toContain('<div id="root">')
    expect(html).toContain('property="og:title"')
    expect(html).toContain('Assets Shell Fest')
    // ...replaced the shell's static <title>...
    expect(html).toContain('Assets Shell Fest — Rallypoint Events')
    // ...and did NOT fall back to the dev stub (which meta-refreshes).
    expect(html).not.toContain('http-equiv="refresh"')
  })
})
