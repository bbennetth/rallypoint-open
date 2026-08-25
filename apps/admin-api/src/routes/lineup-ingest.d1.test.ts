import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { LineupIngestionDto } from '@rallypoint/events-api'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import { encryptBearer } from '../crypto/encryption.js'
import { ADMIN_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the lineup-ingestion proxy routes: real
// session rows in Miniflare D1, a stubbed EVENTS binding recording calls
// (assert actor threading + envelope mapping). The pipeline itself is
// covered in events-api's lineup-ingest-core.d1.test.ts.

const CSRF = 'csrf_token_value_admin_lineupingest_aaaa'

const INGESTION: LineupIngestionDto = {
  id: 'lin_01TEST',
  event_id: 'event_sys1',
  source_kind: 'pasted',
  source_url: null,
  source_excerpt: 'MOCHAKK VTSS',
  model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
  status: 'pending',
  error: null,
  proposal: {
    plan: {
      rows: [],
      errors: [],
      deletes: [],
      summary: { create: 2, update: 0, delete: 0, error: 0 },
    },
    inputRows: [],
    warnings: [],
    truncated: false,
    replace: false,
    // Catalog/enrichment info must pass through the proxy DTO untouched.
    artists: [
      {
        name: 'MOCHAKK',
        enrichment: {
          mbid: 'mb-mochakk',
          confidence: 'high',
          genre: 'house',
          links: {
            spotify: 'https://open.spotify.com/artist/mochakk',
            soundcloud: null,
            appleMusic: null,
            youtubeMusic: null,
            instagram: null,
          },
        },
      },
    ],
  },
  created_by: 'user_admin',
  reviewed_by: null,
  created_at: '2026-08-01T10:00:00.000Z',
  reviewed_at: null,
}

interface Call {
  method: string
  args: unknown[]
}

function makeServices(calls: Call[]): Services {
  const systemEvents: Services['systemEvents'] = {
    list: async () => ({ kind: 'ok', data: { items: [], nextCursor: null } }),
    get: async () => ({ kind: 'not_found' }),
    create: async () => ({ kind: 'not_found' as never }),
    patch: async () => ({ kind: 'not_found' }),
    softDelete: async () => ({ kind: 'not_found' }),
    restore: async () => ({ kind: 'not_found' }),
    ingestLineup: async (actor, eventId, input) => {
      calls.push({ method: 'ingestLineup', args: [actor, eventId, input] })
      const body = input as { sourceUrl?: string; pastedText?: string }
      if (!body.sourceUrl && !body.pastedText) {
        return { kind: 'invalid', issues: [{ path: '', message: 'Provide a source URL or pasted text.' }] }
      }
      if (eventId === 'event_nope') return { kind: 'not_found' }
      if (body.sourceUrl === 'https://blocked.example/') {
        return { kind: 'failed', code: 'fetch_failed', data: { ...INGESTION, status: 'failed' } }
      }
      return { kind: 'ok', data: INGESTION }
    },
    listLineupIngestions: async (actor, eventId, opts) => {
      calls.push({ method: 'listLineupIngestions', args: [actor, eventId, opts] })
      return { kind: 'ok', data: [INGESTION] }
    },
    getLineupIngestion: async (actor, ingestionId) => {
      calls.push({ method: 'getLineupIngestion', args: [actor, ingestionId] })
      return ingestionId === INGESTION.id ? { kind: 'ok', data: INGESTION } : { kind: 'not_found' }
    },
    approveLineupIngestion: async (actor, ingestionId) => {
      calls.push({ method: 'approveLineupIngestion', args: [actor, ingestionId] })
      if (ingestionId === 'lin_stale') return { kind: 'conflict', code: 'stale_proposal' }
      return {
        kind: 'ok',
        data: {
          ingestion: { ...INGESTION, status: 'approved' },
          applied: { upserted: 2, deleted: 0, artistsCreated: 2, artistsEnriched: 1 },
        },
      }
    },
    rejectLineupIngestion: async (actor, ingestionId) => {
      calls.push({ method: 'rejectLineupIngestion', args: [actor, ingestionId] })
      return { kind: 'ok', data: { ...INGESTION, status: 'rejected' } }
    },
  }
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
      bulkDecideAiReviews: async () => ({ applied: 0, dismissed: 0, failed: 0, items: [] }),
    },
    systemEvents,
  } as unknown as Services
}

describe('admin lineup-ingest routes — gate + EVENTS proxy', () => {
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
    const anon = await app.request('http://localhost/api/v1/ui/lineup-ingestions/lin_x', {
      headers: headers(),
    })
    expect(anon.status).toBe(401)

    const bearer = await mintSession('user_regular')
    const res = await app.request(
      'http://localhost/api/v1/ui/system-events/event_sys1/lineup-ingestions',
      { headers: headers(bearer) },
    )
    expect(res.status).toBe(403)
    expect(calls.length).toBe(0)
  })

  it('POST ingest maps body to camelCase input and threads the actor', async () => {
    const bearer = await mintSession('user_admin')
    const res = await app.request(
      'http://localhost/api/v1/ui/system-events/event_sys1/lineup-ingestions',
      {
        method: 'POST',
        headers: headers(bearer),
        body: JSON.stringify({ pasted_text: 'MOCHAKK', replace: true }),
      },
    )
    expect(res.status).toBe(201)
    expect(((await res.json()) as LineupIngestionDto).id).toBe(INGESTION.id)
    expect(calls.at(-1)).toEqual({
      method: 'ingestLineup',
      args: ['user_admin', 'event_sys1', { sourceUrl: undefined, pastedText: 'MOCHAKK', replace: true }],
    })
  })

  it('maps invalid → 400, not_found → 404, failed → 422 with the audit row attached', async () => {
    const bearer = await mintSession('user_admin')

    const bad = await app.request(
      'http://localhost/api/v1/ui/system-events/event_sys1/lineup-ingestions',
      { method: 'POST', headers: headers(bearer), body: JSON.stringify({}) },
    )
    expect(bad.status).toBe(400)

    const missing = await app.request(
      'http://localhost/api/v1/ui/system-events/event_nope/lineup-ingestions',
      { method: 'POST', headers: headers(bearer), body: JSON.stringify({ pasted_text: 'x' }) },
    )
    expect(missing.status).toBe(404)

    const failed = await app.request(
      'http://localhost/api/v1/ui/system-events/event_sys1/lineup-ingestions',
      {
        method: 'POST',
        headers: headers(bearer),
        body: JSON.stringify({ source_url: 'https://blocked.example/' }),
      },
    )
    expect(failed.status).toBe(422)
    const failedBody = (await failed.json()) as {
      error: { code: string; details: { ingestion: LineupIngestionDto } }
    }
    expect(failedBody.error.code).toBe('fetch_failed')
    expect(failedBody.error.details.ingestion.status).toBe('failed')
  })

  it('lists, gets, approves, and rejects through the binding', async () => {
    const bearer = await mintSession('user_admin')

    const list = await app.request(
      'http://localhost/api/v1/ui/system-events/event_sys1/lineup-ingestions?status=pending',
      { headers: headers(bearer) },
    )
    expect(list.status).toBe(200)
    expect(((await list.json()) as { items: LineupIngestionDto[] }).items).toHaveLength(1)
    expect(calls.at(-1)).toEqual({
      method: 'listLineupIngestions',
      args: ['user_admin', 'event_sys1', { status: 'pending' }],
    })

    const got = await app.request(`http://localhost/api/v1/ui/lineup-ingestions/${INGESTION.id}`, {
      headers: headers(bearer),
    })
    expect(got.status).toBe(200)
    // The proposal's catalog/enrichment info survives the proxy untouched.
    expect(((await got.json()) as LineupIngestionDto).proposal?.artists).toEqual(
      INGESTION.proposal!.artists,
    )

    const approved = await app.request(
      `http://localhost/api/v1/ui/lineup-ingestions/${INGESTION.id}/approve`,
      { method: 'POST', headers: headers(bearer) },
    )
    expect(approved.status).toBe(200)
    const approvedBody = (await approved.json()) as {
      ingestion: LineupIngestionDto
      applied: { upserted: number }
    }
    expect(approvedBody.ingestion.status).toBe('approved')
    expect(approvedBody.applied.upserted).toBe(2)

    const stale = await app.request('http://localhost/api/v1/ui/lineup-ingestions/lin_stale/approve', {
      method: 'POST',
      headers: headers(bearer),
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('stale_proposal')

    const rejected = await app.request(
      `http://localhost/api/v1/ui/lineup-ingestions/${INGESTION.id}/reject`,
      { method: 'POST', headers: headers(bearer) },
    )
    expect(rejected.status).toBe(200)
    expect(((await rejected.json()) as LineupIngestionDto).status).toBe('rejected')
  })
})
