import { describe, it, expect } from 'vitest'
import { buildApp } from '../build-app.js'
import { parseEnv } from '../env.js'
import { buildInMemoryRepos } from '../repos/memory.js'
import { createAlwaysAllowVerifier } from '../services/captcha.js'
import { createStubBreachedCheck } from '../services/breached-password.js'
import { createLogMailer } from '../services/mailer/log.js'
import type { UserId } from '@rallypoint/shared'

function build(env: Record<string, string>) {
  const repos = buildInMemoryRepos()
  const services = {
    mailer: createLogMailer({ sink: () => undefined }),
    captcha: createAlwaysAllowVerifier(),
    breachedPassword: createStubBreachedCheck(),
  }
  const app = buildApp({
    env: parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', ...env }),
    repos,
    services,
  })
  return { app, repos }
}

describe('admin namespace gating', () => {
  it('returns 404 not_found when ADMIN_TOKEN is unset (anti-fingerprint, P4.3)', async () => {
    const { app } = build({})
    const res = await app.request('/api/v1/admin/audit')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('not_found')
  })

  it('returns 403 when ADMIN_TOKEN is set but no Authorization header is supplied', async () => {
    const { app } = build({ ADMIN_TOKEN: 'secret-admin-token-1234567890123456' })
    const res = await app.request('/api/v1/admin/audit')
    expect(res.status).toBe(403)
  })

  it('returns 403 on a mismatched bearer', async () => {
    const { app } = build({ ADMIN_TOKEN: 'secret-admin-token-1234567890123456' })
    const res = await app.request('/api/v1/admin/audit', {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(403)
  })

  it('allows a valid bearer', async () => {
    const { app } = build({ ADMIN_TOKEN: 'secret-admin-token-1234567890123456' })
    const res = await app.request('/api/v1/admin/audit', {
      headers: { authorization: 'Bearer secret-admin-token-1234567890123456' },
    })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/v1/admin/audit pagination', () => {
  const TOKEN = 'admin-secret-1234567890123456789012'
  const headers = { authorization: `Bearer ${TOKEN}` }

  it('returns {items, next_cursor} and walks the opaque cursor to the end', async () => {
    const { app, repos } = build({ ADMIN_TOKEN: TOKEN })
    for (let i = 0; i < 5; i++) {
      await repos.audit.write({
        tenantId: 'rallypoint',
        eventType: `evt.${i}`,
        userId: null,
        ipHash: '',
        uaHash: '',
      })
    }

    const seen: string[] = []
    let cursor: string | null = null
    let guard = 0
    do {
      const url: string = `/api/v1/admin/audit?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await app.request(url, { headers })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; next_cursor: string | null }
      expect(Array.isArray(body.items)).toBe(true)
      for (const e of body.items) seen.push(e.id)
      cursor = body.next_cursor
      if (cursor) expect(cursor).not.toContain('|')
    } while (cursor && ++guard < 10)

    expect(cursor).toBeNull()
    expect(new Set(seen).size).toBe(5)
    expect(guard).toBeGreaterThan(1)
  })

  it('rejects an undecodable cursor with 400', async () => {
    const { app } = build({ ADMIN_TOKEN: TOKEN })
    const res = await app.request('/api/v1/admin/audit?cursor=not-a-cursor', { headers })
    expect(res.status).toBe(400)
  })

  it('rejects an out-of-range limit with 400', async () => {
    const { app } = build({ ADMIN_TOKEN: TOKEN })
    expect((await app.request('/api/v1/admin/audit?limit=0', { headers })).status).toBe(400)
    expect((await app.request('/api/v1/admin/audit?limit=9999', { headers })).status).toBe(400)
  })
})

describe('GET /api/v1/admin/version (P4.1 — commit moved out of /health)', () => {
  const TOKEN = 'admin-secret-1234567890123456789012'
  it('returns version + commit + env behind admin auth', async () => {
    const { app } = build({
      ADMIN_TOKEN: TOKEN,
      BUILD_VERSION: 'v1.2.3',
      BUILD_COMMIT: 'deadbeef',
    })
    const res = await app.request('/api/v1/admin/version', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.version).toBe('v1.2.3')
    expect(body.commit).toBe('deadbeef')
    expect(body.env).toBe('test')
  })
})

describe('GET /api/v1/admin/users', () => {
  const TOKEN = 'admin-secret-1234567890123456789012'
  const headers = { authorization: `Bearer ${TOKEN}` }

  it('returns {user: null} for a non-existent email', async () => {
    const { app } = build({ ADMIN_TOKEN: TOKEN })
    const res = await app.request('/api/v1/admin/users?email=ghost@example.com', { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: unknown }
    expect(body.user).toBeNull()
  })

  it('returns the user when looked up by email', async () => {
    const { app, repos } = build({ ADMIN_TOKEN: TOKEN })
    const id = 'user_01HXTEST00000000000000000A' as UserId
    await repos.users.create({
      id,
      tenantId: 'rallypoint',
      email: 'alice@example.com',
      username: 'alice',
    })
    const res = await app.request('/api/v1/admin/users?email=alice@example.com', { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user?: { id?: string; email?: string }; hasPasswordMethod?: boolean }
    expect(body.user?.id).toBe(id)
    expect(body.user?.email).toBe('alice@example.com')
    expect(body.hasPasswordMethod).toBe(false)
  })

  it('returns the user when looked up by userId', async () => {
    const { app, repos } = build({ ADMIN_TOKEN: TOKEN })
    const id = 'user_01HXTEST00000000000000000B' as UserId
    await repos.users.create({
      id,
      tenantId: 'rallypoint',
      email: 'bob@example.com',
      username: 'bob',
    })
    const res = await app.request(`/api/v1/admin/users?userId=${id}`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user?: { id?: string } }
    expect(body.user?.id).toBe(id)
  })

  it('returns 400 when no lookup parameter is supplied', async () => {
    const { app } = build({ ADMIN_TOKEN: TOKEN })
    const res = await app.request('/api/v1/admin/users', { headers })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('admin_query_required')
  })
})
