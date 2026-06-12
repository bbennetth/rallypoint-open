import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import {
  makeNoopMoneyClient,
  makeNoopListsClient,
  makeStubObjectStore,
} from './_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { SHORT_CODE_ALPHABET } from '@rallypoint/events-shared'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for #440: group 6-char short codes (create-time
// mint, lazy backfill, re-show on detail), the join preview endpoint,
// and join-by-code accepting both code shapes.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHORT_RE = new RegExp(`^[${SHORT_CODE_ALPHABET}]{6}$`)

describe('D1 integration — group short codes + join preview (#440)', () => {
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
      getEventWeather: async () => ({
        forecast: null,
        airQuality: null,
        issuedAt: new Date().toISOString(),
      }),
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

  function headers(bearer: string): Record<string, string> {
    return {
      cookie: `${envVars.EVENTS_SESSION_COOKIE_NAME}=${bearer}; ${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}`,
      'x-rp-csrf': CSRF,
      'content-type': 'application/json',
    }
  }

  async function req(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return app.request(`http://localhost${path}`, {
      method,
      headers: headers(bearer),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function createEvent(bearer: string, name: string): Promise<{ id: string; slug: string }> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    expect(res.status).toBe(201)
    return (await res.json()) as { id: string; slug: string }
  }

  interface GroupCreateJson {
    id: string
    join_code: string
    short_code: string | null
  }

  async function createGroup(bearer: string, eventId: string, name: string): Promise<GroupCreateJson> {
    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name })
    expect(res.status).toBe(201)
    return (await res.json()) as GroupCreateJson
  }

  it('group create mints a 6-char short code alongside the rpj_ token', async () => {
    const owner = `user_${Date.now()}_mint`
    const bearer = await loginAs(owner)
    const event = await createEvent(bearer, 'Mint Fest')
    const group = await createGroup(bearer, event.id, 'Crew')
    expect(group.join_code).toMatch(/^rpj_/)
    expect(group.short_code).toMatch(SHORT_RE)

    // Re-showable on detail.
    const detail = (await (
      await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}`)
    ).json()) as { short_code: string }
    expect(detail.short_code).toBe(group.short_code)
  })

  it('lazy backfill: a pre-#440 group (null short_code) gets one on first detail read', async () => {
    const owner = `user_${Date.now()}_backfill`
    const bearer = await loginAs(owner)
    const event = await createEvent(bearer, 'Backfill Fest')
    const group = await createGroup(bearer, event.id, 'Old Crew')
    // Simulate a pre-#440 row.
    await env.DB.prepare('UPDATE groups SET short_code = NULL WHERE id = ?').bind(group.id).run()

    const detail = (await (
      await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}`)
    ).json()) as { short_code: string }
    expect(detail.short_code).toMatch(SHORT_RE)

    // Stable across reads.
    const again = (await (
      await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}`)
    ).json()) as { short_code: string }
    expect(again.short_code).toBe(detail.short_code)
  })

  it('join preview resolves a short code (any casing/spacing) and an rpj_ token', async () => {
    const owner = `user_${Date.now()}_preview`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const event = await createEvent(ownerBearer, 'Preview Fest')
    const group = await createGroup(ownerBearer, event.id, 'Preview Crew')

    const messy = ` ${group.short_code!.toLowerCase().slice(0, 3)}-${group.short_code!.toLowerCase().slice(3)} `
    const res = await req(
      strangerBearer,
      'GET',
      `/api/v1/ui/groups/join/preview?code=${encodeURIComponent(messy)}`,
    )
    expect(res.status).toBe(200)
    const preview = (await res.json()) as Record<string, unknown>
    expect(preview).toMatchObject({
      group_id: group.id,
      name: 'Preview Crew',
      member_count: 1,
      event_name: 'Preview Fest',
      you_are_member: false,
    })

    // rpj_ token resolves too; owner is flagged as member.
    const ownPreview = (await (
      await req(
        ownerBearer,
        'GET',
        `/api/v1/ui/groups/join/preview?code=${encodeURIComponent(group.join_code)}`,
      )
    ).json()) as { you_are_member: boolean }
    expect(ownPreview.you_are_member).toBe(true)

    // Garbage 404s without leaking shape.
    expect(
      (await req(strangerBearer, 'GET', '/api/v1/ui/groups/join/preview?code=ZZZZZZ')).status,
    ).toBe(404)
  })

  it('join accepts the 6-char short code (normalized) and the rpj_ token', async () => {
    const owner = `user_${Date.now()}_join6`
    const joinerA = `${owner}_a`
    const joinerB = `${owner}_b`
    const ownerBearer = await loginAs(owner)
    const aBearer = await loginAs(joinerA)
    const bBearer = await loginAs(joinerB)
    const event = await createEvent(ownerBearer, 'Join6 Fest')
    const group = await createGroup(ownerBearer, event.id, 'Join Crew')

    const lower = group.short_code!.toLowerCase()
    const resA = await req(aBearer, 'POST', '/api/v1/ui/groups/join', { code: ` ${lower} ` })
    expect(resA.status).toBe(200)
    expect(((await resA.json()) as { group_id: string }).group_id).toBe(group.id)

    const resB = await req(bBearer, 'POST', '/api/v1/ui/groups/join', { code: group.join_code })
    expect(resB.status).toBe(200)

    // Wrong short code → invalid, same shape as a dead rpj_ token.
    const bad = await req(aBearer, 'POST', '/api/v1/ui/groups/join', { code: 'ABABAB' })
    expect([404, 409]).toContain(bad.status) // 409 only if astronomically colliding
  })

  it('events list + slug detail expose my_group_id for attendee routing', async () => {
    const owner = `user_${Date.now()}_mygrp`
    const viewer = `${owner}_viewer`
    const ownerBearer = await loginAs(owner)
    const viewerBearer = await loginAs(viewer)
    const event = await createEvent(ownerBearer, 'MyGroup Fest')
    await repos.members.add({ id: `evm_${Date.now()}_v`, eventId: event.id, userId: viewer, role: 'viewer' })

    const group = await createGroup(ownerBearer, event.id, 'Routing Crew')
    await req(viewerBearer, 'POST', '/api/v1/ui/groups/join', { code: group.short_code })

    const list = (await (
      await req(viewerBearer, 'GET', '/api/v1/ui/events')
    ).json()) as { items: Array<{ id: string; my_group_id: string | null }> }
    const item = list.items.find((i) => i.id === event.id)!
    expect(item.my_group_id).toBe(group.id)

    const detail = (await (
      await req(viewerBearer, 'GET', `/api/v1/ui/events/${event.slug}`)
    ).json()) as { my_group_id: string | null }
    expect(detail.my_group_id).toBe(group.id)

    // The owner created the group (createWithOwner), so they're a
    // member too and get the same group id.
    const ownerList = (await (
      await req(ownerBearer, 'GET', '/api/v1/ui/events')
    ).json()) as { items: Array<{ id: string; my_group_id: string | null }> }
    expect(ownerList.items.find((i) => i.id === event.id)!.my_group_id).toBe(group.id)
  })

  it('join + preview are per-user rate limited', async () => {
    const user = `user_${Date.now()}_ratelimit`
    const bearer = await loginAs(user)
    // 20 allowed join attempts per 5 min — the 21st 429s.
    let last: Response | null = null
    for (let i = 0; i < 21; i++) {
      last = await req(bearer, 'POST', '/api/v1/ui/groups/join', { code: 'ZZZZZZ' })
    }
    expect(last!.status).toBe(429)
  })

  it('D1 short-code unique violation carries the column name the retry matcher expects', async () => {
    const owner = `user_${Date.now()}_uniq`
    const bearer = await loginAs(owner)
    const event = await createEvent(bearer, 'Uniq Fest')
    const a = await createGroup(bearer, event.id, 'Crew A')
    const b = await createGroup(bearer, event.id, 'Crew B')

    // Force a collision through the real D1 path and assert the
    // constraint name shape ("groups.short_code") that the route's
    // `.includes('short_code')` matcher relies on.
    let caught: unknown
    try {
      await repos.groups.setShortCode(b.id, a.short_code!)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeTruthy()
    expect(String((caught as { constraintName?: string }).constraintName)).toContain('short_code')
  })
})
