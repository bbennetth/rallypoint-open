import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import type { R2Bucket } from '@cloudflare/workers-types'
import { createBindingObjectStore } from '@rallypoint/object-store'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createPasswordHasher } from '../crypto/password.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'
import { issueSession } from '../session/issue.js'
import type { UserId } from '@rallypoint/shared'
import { AVATAR_MAX_BYTES } from '@rallypoint/shared'

// HTTP-level avatar route behaviour against the in-memory repos and a
// REAL Miniflare R2 binding (env.OBJECT_STORE) — no store mocking (#409).
// Covers the single-request upload, inline type/size validation,
// previous-object reaping, delete, and the public streamed serve.

const ENV = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
const SESSION_COOKIE_NAME = ENV.SESSION_COOKIE_NAME
const CSRF_COOKIE_NAME = ENV.CSRF_COOKIE_NAME
const TEST_CSRF = 'test-csrf-' + 'x'.repeat(40)
const bucket = env.OBJECT_STORE as unknown as R2Bucket

// Headers for a credentialed, CSRF-bearing raw-bytes upload.
function uploadHeaders(cookie: string, contentType: string): Record<string, string> {
  return {
    cookie: [cookie, `${CSRF_COOKIE_NAME}=${TEST_CSRF}`].filter(Boolean).join('; '),
    'x-rp-csrf': TEST_CSRF,
    'content-type': contentType,
  }
}

function csrfOnly(cookie: string): Record<string, string> {
  return {
    cookie: [cookie, `${CSRF_COOKIE_NAME}=${TEST_CSRF}`].filter(Boolean).join('; '),
    'x-rp-csrf': TEST_CSRF,
  }
}

function buildTestApp() {
  const repos = buildInMemoryRepos()
  const objectStore = createBindingObjectStore(bucket)
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
    objectStore,
  }
  const passwordHasher = createPasswordHasher({ pepper: ENV.ARGON2_PEPPER })
  const app = buildApp({ env: ENV, repos, services, passwordHasher })
  return { app, repos, objectStore }
}

let userSeq = 0
async function authed(app: ReturnType<typeof buildTestApp>['app'], repos: ReturnType<typeof buildTestApp>['repos']) {
  const userId = `user_01HXTEST0000000000000${String(userSeq++).padStart(5, '0')}` as UserId
  await repos.users.create({
    id: userId,
    tenantId: 'rallypoint',
    email: `u${userId}@example.com`,
    username: 'avatar tester',
  })
  await repos.users.setEmailVerified(userId, true)
  const { rawToken } = await issueSession(repos.sessions, {
    userId,
    tenantId: 'rallypoint',
    ipHash: 'a'.repeat(64),
    uaHash: 'b'.repeat(64),
  })
  return { userId, cookie: `${SESSION_COOKIE_NAME}=${rawToken}` }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])
// A polyglot body: HTML bytes that carry a valid image/png Content-Type header.
const HTML_BYTES = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]) // <html>

beforeEach(async () => {
  const listed = await bucket.list()
  await Promise.all(listed.objects.map((o) => bucket.delete(o.key)))
})

describe('POST /api/v1/ui/me/avatar (upload)', () => {
  it('401s without a session', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-rp-csrf': TEST_CSRF, cookie: `${CSRF_COOKIE_NAME}=${TEST_CSRF}` },
      body: PNG_BYTES,
    })
    expect(res.status).toBe(401)
  })

  it('stores the bytes, sets avatar_key, and exposes the serve URL as picture', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    const res = await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/png'),
      body: PNG_BYTES,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { picture: string | null }
    expect(body.picture).toBe(`${ENV.PUBLIC_BASE_URL}/api/v1/avatars/${userId}`)
    const stored = await repos.users.findById(userId)
    expect(stored?.avatarKey?.startsWith(`avatars/${userId}/`)).toBe(true)
    expect(stored?.avatarKey?.endsWith('.png')).toBe(true)
    // Bytes really landed in R2.
    const obj = await bucket.get(stored!.avatarKey!)
    expect(obj).not.toBeNull()
  })

  it('400s on an unsupported content type', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    const res = await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/gif'),
      body: PNG_BYTES,
    })
    expect(res.status).toBe(400)
    const stored = await repos.users.findById(userId)
    expect(stored?.avatarKey).toBeNull()
  })

  it('400s on an oversize body', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    const res = await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/png'),
      body: new Uint8Array(AVATAR_MAX_BYTES + 1),
    })
    expect(res.status).toBe(400)
    const stored = await repos.users.findById(userId)
    expect(stored?.avatarKey).toBeNull()
  })

  // --- Magic-byte (file signature) gate -----------------------------------

  it('400s when magic bytes do not match declared image/png (polyglot attack)', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    const res = await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/png'),
      body: HTML_BYTES, // HTML bytes, declared as PNG
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('unsupported_image_type')
    // Nothing was stored in R2 or on the user row.
    const stored = await repos.users.findById(userId)
    expect(stored?.avatarKey).toBeNull()
    expect((await bucket.list()).objects.length).toBe(0)
  })

  it('400s when magic bytes do not match declared image/jpeg', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    const res = await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/jpeg'),
      body: HTML_BYTES, // HTML bytes, declared as JPEG
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('unsupported_image_type')
    const stored = await repos.users.findById(userId)
    expect(stored?.avatarKey).toBeNull()
  })

  it('accepts a valid JPEG body declared as image/jpeg', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    const res = await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/jpeg'),
      body: JPEG_BYTES,
    })
    expect(res.status).toBe(200)
    const stored = await repos.users.findById(userId)
    expect(stored?.avatarKey?.endsWith('.jpg')).toBe(true)
  })

  it('accepts a valid WebP body declared as image/webp', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    const res = await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/webp'),
      body: WEBP_BYTES,
    })
    expect(res.status).toBe(200)
    const stored = await repos.users.findById(userId)
    expect(stored?.avatarKey?.endsWith('.webp')).toBe(true)
  })

  it('reaps the previous object when a new one is uploaded', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/png'),
      body: PNG_BYTES,
    })
    const first = (await repos.users.findById(userId))!.avatarKey!
    await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/png'),
      body: PNG_BYTES,
    })
    const second = (await repos.users.findById(userId))!.avatarKey!
    expect(second).not.toBe(first)
    expect(await bucket.get(first)).toBeNull()
    expect(await bucket.get(second)).not.toBeNull()
  })
})

describe('DELETE /api/v1/ui/me/avatar', () => {
  it('clears the avatar key and reaps the object', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/png'),
      body: PNG_BYTES,
    })
    const key = (await repos.users.findById(userId))!.avatarKey!
    const res = await app.request('/api/v1/ui/me/avatar', { method: 'DELETE', headers: csrfOnly(cookie) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { picture: string | null }
    expect(body.picture).toBeNull()
    expect(await bucket.get(key)).toBeNull()
    const stored = await repos.users.findById(userId)
    expect(stored?.avatarKey).toBeNull()
  })

  it('is a no-op 200 when no avatar is set', async () => {
    const { app, repos } = buildTestApp()
    const { cookie } = await authed(app, repos)
    const res = await app.request('/api/v1/ui/me/avatar', { method: 'DELETE', headers: csrfOnly(cookie) })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/v1/avatars/:userId (public serve)', () => {
  it('streams the stored bytes with content-type + cross-origin CORP', async () => {
    const { app, repos } = buildTestApp()
    const { userId, cookie } = await authed(app, repos)
    await app.request('/api/v1/ui/me/avatar', {
      method: 'POST',
      headers: uploadHeaders(cookie, 'image/png'),
      body: PNG_BYTES,
    })
    const res = await app.request(`/api/v1/avatars/${userId}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    const got = new Uint8Array(await res.arrayBuffer())
    expect(got).toEqual(PNG_BYTES)
  })

  it('404s when the user has no avatar', async () => {
    const { app, repos } = buildTestApp()
    const { userId } = await authed(app, repos)
    const res = await app.request(`/api/v1/avatars/${userId}`)
    expect(res.status).toBe(404)
  })

  it('404s for an unknown user', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/api/v1/avatars/user_doesnotexist')
    expect(res.status).toBe(404)
  })
})
