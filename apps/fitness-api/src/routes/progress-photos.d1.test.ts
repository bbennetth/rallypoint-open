import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import type { R2Bucket } from '@cloudflare/workers-types'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { createBindingObjectStore } from '@rallypoint/object-store'
import { PROGRESS_PHOTO_MAX_BYTES } from '@rallypoint/fitness-shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb, type Db } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { encryptBearer } from '../crypto/encryption.js'
import { FITNESS_SESSION_BEARER_PREFIX } from '../middleware/session.js'
import type { ProgressPhotoDto } from '@rallypoint/fitness-shared'

// D1 + R2 integration tests for the Body Stats progress-picture surface.
// Runs inside a workerd isolate (Miniflare D1 + a real Miniflare R2
// bucket bound as OBJECT_STORE); migrations are applied by
// test/apply-d1-migrations.ts.

const CSRF = 'csrf_token_value_photos_aaaaaaaaaaaaaaaa'

// Minimal valid magic-byte prefixes per the shared sniffer.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

describe('D1 integration — progress pictures UI surface', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  let db: Db

  beforeAll(async () => {
    db = createDb(env.DB)
    repos = buildD1Repos(db)
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    const services: Services = {
      idClient: {
        verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
        signoutRpidBearer: async () => {},
      },
      rpidSso: { exchange: async () => ({ ok: false as const, reason: 'invalid' as const }) },
      profiles: { lookup: async () => null },
      settings: { get: async () => ({}), patch: async (_u, _n, p) => p },
      offClient: { lookup: async () => null, search: async () => [] },
      objectStore: createBindingObjectStore(env.OBJECT_STORE as R2Bucket),
    }
    app = buildApp({ env: envVars, logger: undefined, repos, services })
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

  function headers(bearer: string, contentType?: string): Record<string, string> {
    return {
      cookie: `${envVars.FITNESS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      origin: envVars.FITNESS_UI_ORIGIN,
      ...(contentType ? { 'content-type': contentType } : {}),
    }
  }

  async function upload(
    bearer: string,
    opts: {
      pose: string
      takenAt?: string
      note?: string
      setId?: string
      contentType?: string
      bytes?: Uint8Array
    },
  ): Promise<Response> {
    const params = new URLSearchParams({ pose: opts.pose })
    if (opts.takenAt) params.set('takenAt', opts.takenAt)
    if (opts.note) params.set('note', opts.note)
    if (opts.setId) params.set('setId', opts.setId)
    return app.request(`http://localhost/api/v1/ui/progress-photos?${params}`, {
      method: 'POST',
      headers: headers(bearer, opts.contentType ?? 'image/jpeg'),
      body: (opts.bytes ?? JPEG_BYTES).slice().buffer as ArrayBuffer,
    })
  }

  async function jsonReq(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer, 'application/json'),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('rejects the list without a session (401)', async () => {
    const res = await app.request('http://localhost/api/v1/ui/progress-photos', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.FITNESS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('uploads a photo (201) and serves the exact bytes back', async () => {
    const bearer = await loginAs('user_pp_upload')
    const res = await upload(bearer, {
      pose: 'front',
      takenAt: '2026-07-01T10:00:00.000Z',
      note: 'week 1',
    })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as ProgressPhotoDto
    expect(dto.id).toMatch(/^fpp_/)
    expect(dto.pose).toBe('front')
    expect(dto.takenAt).toBe('2026-07-01T10:00:00.000Z')
    expect(dto.note).toBe('week 1')
    expect(dto.contentType).toBe('image/jpeg')
    expect(dto.sizeBytes).toBe(JPEG_BYTES.byteLength)

    const imgRes = await app.request(
      `http://localhost/api/v1/ui/progress-photos/${dto.id}/image`,
      { headers: headers(bearer) },
    )
    expect(imgRes.status).toBe(200)
    expect(imgRes.headers.get('content-type')).toBe('image/jpeg')
    expect(imgRes.headers.get('cache-control')).toContain('private')
    const got = new Uint8Array(await imgRes.arrayBuffer())
    expect(got).toEqual(JPEG_BYTES)
  })

  it('mints a set id when absent and links photos that pass one back', async () => {
    const bearer = await loginAs('user_pp_sets')
    const first = (await (await upload(bearer, { pose: 'front' })).json()) as ProgressPhotoDto
    expect(first.setId).toMatch(/^fps_/)

    const second = (await (
      await upload(bearer, { pose: 'back', setId: first.setId! })
    ).json()) as ProgressPhotoDto
    expect(second.setId).toBe(first.setId)

    // A fresh upload without setId starts a new set.
    const third = (await (await upload(bearer, { pose: 'front' })).json()) as ProgressPhotoDto
    expect(third.setId).toMatch(/^fps_/)
    expect(third.setId).not.toBe(first.setId)

    // List DTOs carry the set id.
    const list = (await (await jsonReq(bearer, 'GET', '/api/v1/ui/progress-photos')).json()) as {
      items: ProgressPhotoDto[]
    }
    const linked = list.items.filter((p) => p.setId === first.setId)
    expect(linked.map((p) => p.pose).sort()).toEqual(['back', 'front'])
  })

  it('rejects a malformed setId (400)', async () => {
    const bearer = await loginAs('user_pp_bad_set')
    const res = await upload(bearer, { pose: 'front', setId: 'not-a-set-id' })
    expect(res.status).toBe(400)
  })

  it('defaults takenAt to now when omitted', async () => {
    const bearer = await loginAs('user_pp_default_taken')
    const before = Date.now()
    const res = await upload(bearer, { pose: 'side' })
    expect(res.status).toBe(201)
    const dto = (await res.json()) as ProgressPhotoDto
    const takenMs = new Date(dto.takenAt).getTime()
    expect(takenMs).toBeGreaterThanOrEqual(before - 1000)
    expect(takenMs).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('rejects an unsupported content type (400)', async () => {
    const bearer = await loginAs('user_pp_bad_type')
    const res = await upload(bearer, { pose: 'front', contentType: 'image/gif' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('unsupported_photo_type')
  })

  it('rejects bytes whose magic does not match the declared type (400)', async () => {
    const bearer = await loginAs('user_pp_polyglot')
    const res = await upload(bearer, {
      pose: 'front',
      contentType: 'image/jpeg',
      bytes: PNG_BYTES,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('unsupported_photo_type')
  })

  it('rejects an oversize declared content-length without buffering (400)', async () => {
    const bearer = await loginAs('user_pp_oversize')
    const res = await app.request('http://localhost/api/v1/ui/progress-photos?pose=front', {
      method: 'POST',
      headers: {
        ...headers(bearer, 'image/jpeg'),
        'content-length': String(PROGRESS_PHOTO_MAX_BYTES + 1),
      },
      body: JPEG_BYTES.slice().buffer as ArrayBuffer,
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('image_too_large')
  })

  it('rejects an invalid pose slug (400)', async () => {
    const bearer = await loginAs('user_pp_bad_pose')
    const res = await upload(bearer, { pose: 'Side Flexed' })
    expect(res.status).toBe(400)
  })

  it('lists newest takenAt first with pose filter, opaque cursor, and legacy pair', async () => {
    const bearer = await loginAs('user_pp_list')
    for (const [pose, takenAt] of [
      ['front', '2026-07-01T10:00:00.000Z'],
      ['back', '2026-07-02T10:00:00.000Z'],
      ['front', '2026-07-03T10:00:00.000Z'],
    ] as const) {
      const r = await upload(bearer, { pose, takenAt })
      expect(r.status).toBe(201)
    }

    const listRes = await jsonReq(bearer, 'GET', '/api/v1/ui/progress-photos')
    const list = (await listRes.json()) as { items: ProgressPhotoDto[]; next_cursor: string | null }
    expect(list.items.map((p) => p.takenAt)).toEqual([
      '2026-07-03T10:00:00.000Z',
      '2026-07-02T10:00:00.000Z',
      '2026-07-01T10:00:00.000Z',
    ])
    // Page not full → no cursor.
    expect(list.next_cursor).toBeNull()

    const frontRes = await jsonReq(bearer, 'GET', '/api/v1/ui/progress-photos?pose=front')
    const front = (await frontRes.json()) as { items: ProgressPhotoDto[] }
    expect(front.items).toHaveLength(2)
    expect(front.items.every((p) => p.pose === 'front')).toBe(true)

    // limit fills the page → opaque cursor set; pass it back to page past it.
    const page1Res = await jsonReq(bearer, 'GET', '/api/v1/ui/progress-photos?limit=2')
    const page1 = (await page1Res.json()) as {
      items: ProgressPhotoDto[]
      next_cursor: string | null
    }
    expect(page1.items).toHaveLength(2)
    expect(page1.next_cursor).not.toBeNull()
    // Opaque — not the old ISO takenAt plaintext.
    expect(page1.next_cursor).not.toContain('2026-07-02')
    const page2Res = await jsonReq(
      bearer,
      'GET',
      `/api/v1/ui/progress-photos?limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`,
    )
    const page2 = (await page2Res.json()) as { items: ProgressPhotoDto[]; next_cursor: string | null }
    expect(page2.items.map((p) => p.takenAt)).toEqual(['2026-07-01T10:00:00.000Z'])
    expect(page2.next_cursor).toBeNull()

    // Legacy `before` + `beforeId` param pair still pages (stale bundles).
    const legacyRes = await jsonReq(
      bearer,
      'GET',
      `/api/v1/ui/progress-photos?limit=2&before=${encodeURIComponent('2026-07-02T10:00:00.000Z')}&beforeId=${page1.items[1]!.id}`,
    )
    const legacy = (await legacyRes.json()) as { items: ProgressPhotoDto[] }
    expect(legacy.items.map((p) => p.takenAt)).toEqual(['2026-07-01T10:00:00.000Z'])

    // `before` without `beforeId` is still a validation error.
    const badPair = await jsonReq(
      bearer,
      'GET',
      `/api/v1/ui/progress-photos?before=${encodeURIComponent('2026-07-02T10:00:00.000Z')}`,
    )
    expect(badPair.status).toBe(400)

    // An undecodable opaque cursor is a 400, not a silent restart.
    const badCursor = await jsonReq(bearer, 'GET', '/api/v1/ui/progress-photos?cursor=not-a-cursor')
    expect(badCursor.status).toBe(400)
  })

  it('pages through photos sharing an identical takenAt without skipping', async () => {
    const bearer = await loginAs('user_pp_same_taken')
    const takenAt = '2026-07-05T08:00:00.000Z'
    for (const pose of ['front', 'back', 'side'] as const) {
      const r = await upload(bearer, { pose, takenAt })
      expect(r.status).toBe(201)
    }

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const qs = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1'
      const res = await jsonReq(bearer, 'GET', `/api/v1/ui/progress-photos${qs}`)
      const body = (await res.json()) as {
        items: ProgressPhotoDto[]
        next_cursor: string | null
      }
      seen.push(...body.items.map((p) => p.id))
      if (!body.next_cursor) break
      cursor = body.next_cursor
    }
    // All three equal-takenAt rows arrive exactly once.
    expect(new Set(seen).size).toBe(3)
    expect(seen).toHaveLength(3)
  })

  it('merges curated and custom slugs in the poses endpoint', async () => {
    const bearer = await loginAs('user_pp_poses')
    await upload(bearer, { pose: 'side_flexed' })
    await upload(bearer, { pose: 'front' })
    const res = await jsonReq(bearer, 'GET', '/api/v1/ui/progress-photos/poses')
    const body = (await res.json()) as { poses: string[] }
    expect(body.poses).toEqual(['front', 'back', 'side', 'side_flexed'])
  })

  it('isolates photos between users (404 on foreign GET/PATCH/DELETE)', async () => {
    const owner = await loginAs('user_pp_owner')
    const intruder = await loginAs('user_pp_intruder')
    const created = (await (await upload(owner, { pose: 'front' })).json()) as ProgressPhotoDto

    const img = await app.request(
      `http://localhost/api/v1/ui/progress-photos/${created.id}/image`,
      { headers: headers(intruder) },
    )
    expect(img.status).toBe(404)

    const patch = await jsonReq(intruder, 'PATCH', `/api/v1/ui/progress-photos/${created.id}`, {
      pose: 'back',
    })
    expect(patch.status).toBe(404)

    const del = await jsonReq(intruder, 'DELETE', `/api/v1/ui/progress-photos/${created.id}`)
    expect(del.status).toBe(404)

    // The intruder's list never contains the owner's photo.
    const list = (await (await jsonReq(intruder, 'GET', '/api/v1/ui/progress-photos')).json()) as {
      items: ProgressPhotoDto[]
    }
    expect(list.items.some((p) => p.id === created.id)).toBe(false)
  })

  it('patches pose, takenAt, and note; null clears the note', async () => {
    const bearer = await loginAs('user_pp_patch')
    const created = (await (
      await upload(bearer, { pose: 'front', note: 'original' })
    ).json()) as ProgressPhotoDto

    const res = await jsonReq(bearer, 'PATCH', `/api/v1/ui/progress-photos/${created.id}`, {
      pose: 'side_flexed',
      takenAt: '2026-06-15T09:00:00.000Z',
      note: null,
    })
    expect(res.status).toBe(200)
    const dto = (await res.json()) as ProgressPhotoDto
    expect(dto.pose).toBe('side_flexed')
    expect(dto.takenAt).toBe('2026-06-15T09:00:00.000Z')
    expect(dto.note).toBeNull()
  })

  it('deletes the row and the object; the image 404s afterwards', async () => {
    const bearer = await loginAs('user_pp_delete')
    const created = (await (await upload(bearer, { pose: 'back' })).json()) as ProgressPhotoDto

    const del = await jsonReq(bearer, 'DELETE', `/api/v1/ui/progress-photos/${created.id}`)
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })

    const img = await app.request(
      `http://localhost/api/v1/ui/progress-photos/${created.id}/image`,
      { headers: headers(bearer) },
    )
    expect(img.status).toBe(404)

    // The underlying object is gone from the bucket too.
    const bucket = env.OBJECT_STORE as R2Bucket
    const listed = await bucket.list({ prefix: 'progress-photos/user_pp_delete/' })
    expect(listed.objects).toHaveLength(0)
  })
})
