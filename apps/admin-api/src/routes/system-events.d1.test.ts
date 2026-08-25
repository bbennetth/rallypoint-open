import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { SystemEventDto } from '@rallypoint/events-api'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import { encryptBearer } from '../crypto/encryption.js'
import { ADMIN_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the system-events proxy routes: real session
// rows in Miniflare D1, a stubbed EVENTS binding recording calls (so we
// can assert the acting admin id is threaded through as `actor`).

const CSRF = 'csrf_token_value_admin_sysevents_aaaaaaaa'

const DTO: SystemEventDto = {
  id: 'event_sys1',
  slug: 'system-fest-abcd',
  name: 'System Fest',
  description: null,
  startDate: null,
  endDate: null,
  timezone: 'UTC',
  locationLabel: null,
  privacyMode: 'public',
  features: {
    lineup: true,
    sessions: true,
    map: true,
    tickets: true,
    attendees: true,
    groups: true,
    rallies: true,
    chat: true,
  } as SystemEventDto['features'],
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
  deletedAt: null,
}

interface Call {
  method: string
  args: unknown[]
}

function makeServices(calls: Call[]): Services {
  return {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: {
      exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
    },
    profiles: { lookup: async () => null },
    settings: {
      get: async () => ({}),
      patch: async (_u, _n, patch) => patch,
    },
    fitness: {
      listSubmissions: async () => [],
      getSubmission: async () => null,
      approveSubmission: async () => null,
      rejectSubmission: async () => null,
    },
    foodSubmissions: {
      listFoodSubmissions: async () => [],
      getFoodSubmission: async () => null,
      approveFoodSubmission: async () => null,
      rejectFoodSubmission: async () => null,
    },
    exerciseCatalog: {
      listExercises: async () => [],
      getExercise: async () => null,
      updateExercise: async () => null,
      aiReviewExercise: async () => ({ outcome: 'not_found' as const }),
      aiReviewBatch: async () => 'ai_unavailable' as const,
      listAiReviews: async () => [],
      applyAiReview: async () => null,
      dismissAiReview: async () => null,
    },
    systemEvents: {
      list: async (actor, opts) => {
        calls.push({ method: 'list', args: [actor, opts] })
        return { kind: 'ok' as const, data: { items: [DTO], nextCursor: null } }
      },
      get: async (actor, eventId) => {
        calls.push({ method: 'get', args: [actor, eventId] })
        return eventId === DTO.id
          ? { kind: 'ok' as const, data: DTO }
          : { kind: 'not_found' as const }
      },
      create: async (actor, input) => {
        calls.push({ method: 'create', args: [actor, input] })
        const body = input as { name?: string }
        if (!body.name) {
          return {
            kind: 'invalid' as const,
            issues: [{ path: 'name', message: 'Required' }],
          }
        }
        return { kind: 'ok' as const, data: { ...DTO, name: body.name } }
      },
      patch: async (actor, eventId, input) => {
        calls.push({ method: 'patch', args: [actor, eventId, input] })
        return { kind: 'ok' as const, data: DTO }
      },
      softDelete: async (actor, eventId) => {
        calls.push({ method: 'softDelete', args: [actor, eventId] })
        return { kind: 'ok' as const, data: true as const }
      },
      restore: async (actor, eventId) => {
        calls.push({ method: 'restore', args: [actor, eventId] })
        return { kind: 'conflict' as const, code: 'event_not_deleted' }
      },
      // Lineup-ingestion surface — exercised in lineup-ingest.d1.test.ts.
      ingestLineup: async () => ({ kind: 'not_found' as const }),
      listLineupIngestions: async () => ({ kind: 'ok' as const, data: [] }),
      getLineupIngestion: async () => ({ kind: 'not_found' as const }),
      approveLineupIngestion: async () => ({ kind: 'not_found' as const }),
      rejectLineupIngestion: async () => ({ kind: 'not_found' as const }),
    },
  }
}

describe('admin system-events routes — gate + EVENTS proxy', () => {
  let repos: Repos
  let envVars: Env
  let calls: Call[]
  let app: Hono<HonoApp>

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      ADMIN_USER_IDS: 'user_admin',
    })
    calls = []
    app = buildApp({ env: envVars, repos, services: makeServices(calls) })
  })

  async function mintSession(userId: string): Promise<string> {
    const bearer = generateRawToken(ADMIN_SESSION_BEARER_PREFIX)
    const idHash = hashToken(bearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: envVars,
      keyVersion: envVars.ADMIN_SESSION_KEY_VERSION,
    })
    await repos.sessions.create({
      idHash,
      userId,
      rpidBearerCiphertext: sealed.ciphertext,
      rpidBearerNonce: sealed.nonce,
      rpidBearerKeyVersion: sealed.keyVersion,
      absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ipHash: 'ip_hash_test',
      uaHash: 'ua_hash_test',
    })
    return bearer
  }

  function headers(cookieValue?: string): Record<string, string> {
    const cookies = [
      ...(cookieValue ? [`${envVars.ADMIN_SESSION_COOKIE_NAME}=${cookieValue}`] : []),
      `${envVars.ADMIN_CSRF_COOKIE_NAME}=${CSRF}`,
    ].join('; ')
    return {
      cookie: cookies,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
      origin: envVars.ADMIN_UI_ORIGIN,
    }
  }

  it('401 with no session; 403 for a non-allowlisted user', async () => {
    const anon = await app.request('http://localhost/api/v1/ui/system-events', {
      headers: headers(),
    })
    expect(anon.status).toBe(401)

    const bearer = await mintSession('user_regular')
    const res = await app.request('http://localhost/api/v1/ui/system-events', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(403)
    expect(calls.length).toBe(0) // gate fires before the proxy
  })

  it('lists system events and threads the acting admin as actor', async () => {
    const bearer = await mintSession('user_admin')
    const res = await app.request('http://localhost/api/v1/ui/system-events?include=deleted', {
      headers: headers(bearer),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: SystemEventDto[]; next_cursor: string | null }
    expect(body.items).toEqual([DTO])
    expect(calls.at(-1)).toEqual({
      method: 'list',
      args: ['user_admin', { includeDeleted: true }],
    })
  })

  it('creates via POST, maps invalid input to 400', async () => {
    const bearer = await mintSession('user_admin')
    const ok = await app.request('http://localhost/api/v1/ui/system-events', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ name: 'New Fest', timezone: 'UTC' }),
    })
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as SystemEventDto).name).toBe('New Fest')
    expect(calls.at(-1)?.args[0]).toBe('user_admin')

    const bad = await app.request('http://localhost/api/v1/ui/system-events', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ timezone: 'UTC' }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'validation_failed',
    )
  })

  it('GET/PATCH/DELETE round-trip; unknown id 404s; restore conflict maps to 409', async () => {
    const bearer = await mintSession('user_admin')

    const got = await app.request(`http://localhost/api/v1/ui/system-events/${DTO.id}`, {
      headers: headers(bearer),
    })
    expect(got.status).toBe(200)

    const missing = await app.request('http://localhost/api/v1/ui/system-events/event_nope', {
      headers: headers(bearer),
    })
    expect(missing.status).toBe(404)

    const patched = await app.request(`http://localhost/api/v1/ui/system-events/${DTO.id}`, {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(patched.status).toBe(200)

    const deleted = await app.request(`http://localhost/api/v1/ui/system-events/${DTO.id}`, {
      method: 'DELETE',
      headers: headers(bearer),
    })
    expect(deleted.status).toBe(204)

    const restore = await app.request(
      `http://localhost/api/v1/ui/system-events/${DTO.id}/restore`,
      { method: 'POST', headers: headers(bearer) },
    )
    expect(restore.status).toBe(409)
    expect(((await restore.json()) as { error: { code: string } }).error.code).toBe(
      'event_not_deleted',
    )
  })
})
