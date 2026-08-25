import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { ArtistMbReviewDto } from '@rallypoint/events-shared'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import { encryptBearer } from '../crypto/encryption.js'
import { ADMIN_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import { artistListCursorCodec, artistReviewCursorCodec } from '../lib/artist-review-cursor.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'

// D1 integration tests for the admin artist MB-review proxy routes: real
// session rows in Miniflare D1, a stubbed EVENTS binding (same
// conventions as exercises.d1.test.ts).

const CSRF = 'csrf_token_value_admin_artists_aaaaaaaaaaa'

const REVIEW: ArtistMbReviewDto = {
  id: 'amr_1',
  artistId: 'art_1',
  artistName: 'Nova Act',
  mbid: 'mb-1',
  matchKind: 'auto',
  currentFields: {
    genre: null,
    soundcloud: null,
    spotify: null,
    appleMusic: null,
    youtubeMusic: null,
    instagram: null,
    mbid: null,
  },
  proposedFields: { genre: 'techno', spotify: 'https://open.spotify.com/artist/x' },
  status: 'pending',
  createdAt: '2026-08-01T10:00:00.000Z',
  reviewedAt: null,
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
      bulkDecideAiReviews: async () => ({ applied: 0, dismissed: 0, failed: 0, items: [] }),
    },
    systemEvents: {
      list: async () => ({ kind: 'ok' as const, data: { items: [], nextCursor: null } }),
      get: async () => ({ kind: 'not_found' as const }),
      create: async () => ({ kind: 'forbidden' as const }),
      patch: async () => ({ kind: 'not_found' as const }),
      softDelete: async () => ({ kind: 'not_found' as const }),
      restore: async () => ({ kind: 'not_found' as const }),
      listArtists: async (actor, opts) => {
        calls.push({ method: 'listArtists', args: [actor, opts] })
        return {
          kind: 'ok' as const,
          data: {
            items: [
              {
                id: 'art_1',
                name: 'Nova Act',
                genre: 'techno',
                soundcloud: null,
                spotify: null,
                appleMusic: null,
                youtubeMusic: null,
                instagram: null,
                mbid: 'mb-1',
                updatedAt: '2026-08-01T10:00:00.000Z',
              },
            ],
            nextCursor: { name: 'Nova Act', id: 'art_1' },
          },
        }
      },
      patchArtist: async (actor, artistId, input) => {
        calls.push({ method: 'patchArtist', args: [actor, artistId, input] })
        if (artistId === 'art_missing') return { kind: 'not_found' as const }
        if (artistId === 'art_taken') {
          return { kind: 'conflict' as const, code: 'artist_name_taken' }
        }
        if ((input as { spotify?: string }).spotify === 'not-a-url') {
          return { kind: 'invalid' as const, issues: [{ path: 'spotify', message: 'Invalid url' }] }
        }
        return {
          kind: 'ok' as const,
          data: {
            id: artistId,
            name: 'Nova Act',
            genre: (input as { genre?: string | null }).genre ?? null,
            soundcloud: null,
            spotify: null,
            appleMusic: null,
            youtubeMusic: null,
            instagram: null,
            mbid: null,
            updatedAt: '2026-08-01T10:00:00.000Z',
          },
        }
      },
      artistMbReview: async (actor, artistId) => {
        calls.push({ method: 'artistMbReview', args: [actor, artistId] })
        if (artistId === 'art_missing') {
          return { kind: 'ok' as const, data: { outcome: 'not_found' as const, review: null } }
        }
        return { kind: 'ok' as const, data: { outcome: 'proposed' as const, review: REVIEW } }
      },
      artistMbSweepBatch: async (actor, opts) => {
        calls.push({ method: 'artistMbSweepBatch', args: [actor, opts] })
        return {
          kind: 'ok' as const,
          data: { processed: 3, proposed: 1, unchanged: 1, skipped: 1, nextCursor: 'art_x' },
        }
      },
      listArtistMbReviews: async (actor, opts) => {
        calls.push({ method: 'listArtistMbReviews', args: [actor, opts] })
        return { kind: 'ok' as const, data: [REVIEW] }
      },
      applyArtistMbReview: async (actor, id) => {
        calls.push({ method: 'applyArtistMbReview', args: [actor, id] })
        if (id === 'amr_done') return { kind: 'not_pending' as const }
        if (id !== REVIEW.id) return { kind: 'not_found' as const }
        return { kind: 'ok' as const, data: { ...REVIEW, status: 'applied' as const } }
      },
      dismissArtistMbReview: async (actor, id) => {
        calls.push({ method: 'dismissArtistMbReview', args: [actor, id] })
        if (id !== REVIEW.id) return { kind: 'not_found' as const }
        return { kind: 'ok' as const, data: { ...REVIEW, status: 'dismissed' as const } }
      },
      bulkDecideArtistMbReviews: async (actor, ids, action) => {
        calls.push({ method: 'bulkDecideArtistMbReviews', args: [actor, ids, action] })
        return {
          kind: 'ok' as const,
          data: {
            applied: action === 'apply' ? ids.length : 0,
            dismissed: action === 'dismiss' ? ids.length : 0,
            failed: 0,
            items: ids.map((id) => ({
              id,
              outcome: action === 'apply' ? ('applied' as const) : ('dismissed' as const),
            })),
          },
        }
      },
    } as Services['systemEvents'],
  }
}

describe('admin artist MB-review routes — gate + EVENTS proxy', () => {
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

  it('401 without a session, 403 for a non-admin', async () => {
    const anon = await app.request('http://localhost/api/v1/ui/artist-mb-reviews', {
      headers: headers(),
    })
    expect(anon.status).toBe(401)

    const bearer = await mintSession('user_regular')
    const nonAdmin = await app.request('http://localhost/api/v1/ui/artist-mb-reviews', {
      headers: headers(bearer),
    })
    expect(nonAdmin.status).toBe(403)
  })

  it('GET /artists lists with opaque (name,id) cursor round-trip; 400s bad cursor/limit', async () => {
    const bearer = await mintSession('user_admin')
    const list = await app.request('http://localhost/api/v1/ui/artists?q=nova&limit=50', {
      headers: headers(bearer),
    })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { items: { mbid: string }[]; nextCursor: string }
    expect(body.items[0]!.mbid).toBe('mb-1')
    expect(artistListCursorCodec.decode(body.nextCursor)).toEqual({
      name: 'Nova Act',
      id: 'art_1',
    })
    expect(calls.at(-1)).toEqual({
      method: 'listArtists',
      args: ['user_admin', { q: 'nova', cursor: null, limit: 50 }],
    })

    const page2 = await app.request(
      `http://localhost/api/v1/ui/artists?cursor=${encodeURIComponent(body.nextCursor)}`,
      { headers: headers(bearer) },
    )
    expect(page2.status).toBe(200)
    expect(calls.at(-1)).toEqual({
      method: 'listArtists',
      args: ['user_admin', { cursor: { name: 'Nova Act', id: 'art_1' } }],
    })

    const badCursor = await app.request('http://localhost/api/v1/ui/artists?cursor=garbage', {
      headers: headers(bearer),
    })
    expect(badCursor.status).toBe(400)
    const badLimit = await app.request('http://localhost/api/v1/ui/artists?limit=1000', {
      headers: headers(bearer),
    })
    expect(badLimit.status).toBe(400)

    const anon = await app.request('http://localhost/api/v1/ui/artists', { headers: headers() })
    expect(anon.status).toBe(401)
  })

  it('PATCH /artists/:id maps markers to 400/404/409', async () => {
    const bearer = await mintSession('user_admin')
    const ok = await app.request('http://localhost/api/v1/ui/artists/art_1', {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify({ genre: 'techno' }),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { genre: string }).genre).toBe('techno')
    expect(calls.at(-1)).toEqual({
      method: 'patchArtist',
      args: ['user_admin', 'art_1', { genre: 'techno' }],
    })

    const invalid = await app.request('http://localhost/api/v1/ui/artists/art_1', {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify({ spotify: 'not-a-url' }),
    })
    expect(invalid.status).toBe(400)

    const missing = await app.request('http://localhost/api/v1/ui/artists/art_missing', {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify({ genre: 'x' }),
    })
    expect(missing.status).toBe(404)

    const taken = await app.request('http://localhost/api/v1/ui/artists/art_taken', {
      method: 'PATCH',
      headers: headers(bearer),
      body: JSON.stringify({ name: 'Dup' }),
    })
    expect(taken.status).toBe(409)
  })

  it('single review proxies; unknown artist 404s', async () => {
    const bearer = await mintSession('user_admin')
    const ok = await app.request('http://localhost/api/v1/ui/artists/art_1/mb-review', {
      method: 'POST',
      headers: headers(bearer),
      body: '{}',
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { outcome: string }).outcome).toBe('proposed')
    expect(calls.at(-1)).toEqual({ method: 'artistMbReview', args: ['user_admin', 'art_1'] })

    const missing = await app.request('http://localhost/api/v1/ui/artists/art_missing/mb-review', {
      method: 'POST',
      headers: headers(bearer),
      body: '{}',
    })
    expect(missing.status).toBe(404)
  })

  it('batch: opaque cursor round-trip incl. legacy bare id', async () => {
    const bearer = await mintSession('user_admin')
    const batch = await app.request('http://localhost/api/v1/ui/artist-mb-reviews/batch', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ cursor: null, limit: 5 }),
    })
    expect(batch.status).toBe(200)
    const body = (await batch.json()) as { nextCursor: string }
    expect(body.nextCursor).not.toBe('art_x')
    expect(artistReviewCursorCodec.decode(body.nextCursor)).toEqual({ id: 'art_x' })
    expect(calls.at(-1)).toEqual({
      method: 'artistMbSweepBatch',
      args: ['user_admin', { cursor: null, limit: 5 }],
    })

    const batch2 = await app.request('http://localhost/api/v1/ui/artist-mb-reviews/batch', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ cursor: body.nextCursor, limit: 5 }),
    })
    expect(batch2.status).toBe(200)
    expect(calls.at(-1)).toEqual({
      method: 'artistMbSweepBatch',
      args: ['user_admin', { cursor: 'art_x', limit: 5 }],
    })

    const legacy = await app.request('http://localhost/api/v1/ui/artist-mb-reviews/batch', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ cursor: 'art_legacy' }),
    })
    expect(legacy.status).toBe(200)
    expect(calls.at(-1)).toEqual({
      method: 'artistMbSweepBatch',
      args: ['user_admin', { cursor: 'art_legacy' }],
    })
  })

  it('list, apply, dismiss, bulk map markers to statuses', async () => {
    const bearer = await mintSession('user_admin')

    const list = await app.request('http://localhost/api/v1/ui/artist-mb-reviews', {
      headers: headers(bearer),
    })
    expect(list.status).toBe(200)
    expect((await list.json()) as unknown).toEqual({ items: [REVIEW] })
    expect(calls.at(-1)).toEqual({
      method: 'listArtistMbReviews',
      args: ['user_admin', { status: 'pending' }],
    })

    const badStatus = await app.request(
      'http://localhost/api/v1/ui/artist-mb-reviews?status=nope',
      { headers: headers(bearer) },
    )
    expect(badStatus.status).toBe(400)

    const apply = await app.request(
      `http://localhost/api/v1/ui/artist-mb-reviews/${REVIEW.id}/apply`,
      { method: 'POST', headers: headers(bearer), body: '{}' },
    )
    expect(apply.status).toBe(200)

    const conflict = await app.request(
      'http://localhost/api/v1/ui/artist-mb-reviews/amr_done/apply',
      { method: 'POST', headers: headers(bearer), body: '{}' },
    )
    expect(conflict.status).toBe(409)

    const missing = await app.request(
      'http://localhost/api/v1/ui/artist-mb-reviews/amr_missing/dismiss',
      { method: 'POST', headers: headers(bearer), body: '{}' },
    )
    expect(missing.status).toBe(404)

    const bulk = await app.request('http://localhost/api/v1/ui/artist-mb-reviews/bulk', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ ids: ['amr_1', 'amr_2'], action: 'dismiss' }),
    })
    expect(bulk.status).toBe(200)
    expect(calls.at(-1)).toEqual({
      method: 'bulkDecideArtistMbReviews',
      args: ['user_admin', ['amr_1', 'amr_2'], 'dismiss'],
    })

    const empty = await app.request('http://localhost/api/v1/ui/artist-mb-reviews/bulk', {
      method: 'POST',
      headers: headers(bearer),
      body: JSON.stringify({ ids: [], action: 'apply' }),
    })
    expect(empty.status).toBe(400)
  })
})
