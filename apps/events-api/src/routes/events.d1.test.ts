import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type { Hono } from 'hono'
import type { RealtimeBus, RealtimeEnvelope, Subscription } from '@rallypoint/realtime'
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

// D1 integration tests for the events CRUD surface + invites + activity.
// Replaces events.it.test.ts. Runs inside a workerd isolate (Miniflare D1),
// migrations applied by apps/events-api/test/apply-d1-migrations.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface RecordingBus extends RealtimeBus {
  published: { channel: string; env: RealtimeEnvelope }[]
}

function makeRecordingBus(): RecordingBus {
  const published: { channel: string; env: RealtimeEnvelope }[] = []
  return {
    published,
    async publish(channel, e) {
      published.push({ channel, env: e })
    },
    subscribe(): Subscription {
      return { unsubscribe() {} }
    },
    async close() {},
  }
}

describe('D1 integration — events CRUD + invites + activity', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>
  const bus = makeRecordingBus()

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
    app = buildApp({ env: envVars, logger: undefined, repos, services, realtime: bus })
  })

  beforeEach(() => {
    bus.published.length = 0
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

  it('rejects an unauthenticated request to the events surface', async () => {
    const res = await app.request('http://localhost/api/v1/ui/events', {
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}` },
    })
    expect(res.status).toBe(401)
  })

  it('creates an event, records activity, and serializes owner role', async () => {
    const owner = `user_${Date.now()}_owner`
    const bearer = await loginAs(owner)
    const res = await req(bearer, 'POST', '/api/v1/ui/events', {
      name: 'Summer Fest',
      timezone: 'America/New_York',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('Summer Fest')
    expect(body.slug as string).toMatch(/^summer-fest-[2-9a-hjkmnp-tv-z]{4}$/)
    expect(body.viewer_role).toBe('owner')
    expect(body.owner_user_id).toBe(owner)

    const activity = await repos.activity.listForEvent(body.id as string)
    expect(activity.map((a) => a.eventType)).toContain('event.created')
  })

  it('ignores a client-supplied slug — server always auto-generates', async () => {
    const bearer = await loginAs(`user_${Date.now()}_cs`)
    const res = await req(bearer, 'POST', '/api/v1/ui/events', {
      name: 'Custom Slug Attempt',
      slug: 'i-want-this',
      timezone: 'UTC',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { slug: string }
    expect(body.slug).not.toBe('i-want-this')
    expect(body.slug).toMatch(/^custom-slug-attempt-[2-9a-hjkmnp-tv-z]{4}$/)
  })

  it('two events created with the same name get distinct random suffixes', async () => {
    const bearer = await loginAs(`user_${Date.now()}_dup`)
    const first = (await (
      await req(bearer, 'POST', '/api/v1/ui/events', {
        name: 'Same Name',
        timezone: 'UTC',
      })
    ).json()) as { slug: string }
    const second = (await (
      await req(bearer, 'POST', '/api/v1/ui/events', {
        name: 'Same Name',
        timezone: 'UTC',
      })
    ).json()) as { slug: string }
    expect(first.slug).not.toBe(second.slug)
    expect(first.slug).toMatch(/^same-name-/)
    expect(second.slug).toMatch(/^same-name-/)
  })

  it('lists owned ∪ collaborated events and filters soft-deleted by default', async () => {
    const owner = `user_${Date.now()}_list`
    const collab = `${owner}_collab`
    const ownerBearer = await loginAs(owner)
    const collabBearer = await loginAs(collab)

    const a = (await (
      await req(ownerBearer, 'POST', '/api/v1/ui/events', {
        name: 'Owned A',
        timezone: 'UTC',
      })
    ).json()) as { id: string; slug: string }
    const b = (await (
      await req(ownerBearer, 'POST', '/api/v1/ui/events', {
        name: 'Owned B',
        timezone: 'UTC',
      })
    ).json()) as { id: string }

    // Make collab an editor on event A.
    await repos.members.add({
      id: `evm_${Date.now()}`,
      eventId: a.id,
      userId: collab,
      role: 'editor',
    })

    const collabList = (await (
      await req(collabBearer, 'GET', '/api/v1/ui/events')
    ).json()) as {
      items: Array<{ id: string; viewer_role: string }>
    }
    const collabIds = collabList.items.map((i) => i.id)
    expect(collabIds).toContain(a.id)
    expect(collabIds).not.toContain(b.id)
    expect(collabList.items.find((i) => i.id === a.id)?.viewer_role).toBe('editor')

    // Soft-delete B; default list hides it, include=deleted shows it.
    const del = await req(ownerBearer, 'DELETE', `/api/v1/ui/events/${b.id}`)
    expect(del.status).toBe(204)

    const def = (await (
      await req(ownerBearer, 'GET', '/api/v1/ui/events')
    ).json()) as {
      items: Array<{ id: string }>
    }
    expect(def.items.map((i) => i.id)).not.toContain(b.id)

    const withDeleted = (await (
      await req(ownerBearer, 'GET', '/api/v1/ui/events?include=deleted')
    ).json()) as { items: Array<{ id: string }> }
    expect(withDeleted.items.map((i) => i.id)).toContain(b.id)
  })

  it('patches an event and records the changed fields', async () => {
    const owner = `user_${Date.now()}_patch`
    const bearer = await loginAs(owner)
    const created = (await (
      await req(bearer, 'POST', '/api/v1/ui/events', {
        name: 'Before',
        timezone: 'UTC',
      })
    ).json()) as { id: string }

    const res = await req(bearer, 'PATCH', `/api/v1/ui/events/${created.id}`, {
      name: 'After',
      privacyMode: 'public',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('After')
    expect(body.privacy_mode).toBe('public')

    const activity = await repos.activity.listForEvent(created.id)
    expect(activity.map((a) => a.eventType)).toContain('event.patched')
  })

  it('publishes an events pointer envelope on PATCH', async () => {
    const owner = `user_${Date.now()}_patchpub`
    const bearer = await loginAs(owner)
    const created = (await (
      await req(bearer, 'POST', '/api/v1/ui/events', {
        name: 'Pub Before',
        timezone: 'UTC',
      })
    ).json()) as { id: string }

    const before = bus.published.length
    const res = await req(bearer, 'PATCH', `/api/v1/ui/events/${created.id}`, { name: 'Pub After' })
    expect(res.status).toBe(200)
    expect(bus.published.length).toBe(before + 1)
    const last = bus.published[bus.published.length - 1]!
    expect(last.channel).toBe(`events:event:${created.id}`)
    expect(last.env.resource).toBe('events')
    expect(last.env.operation).toBe('update')
    expect(last.env.payload.id).toBe(created.id)
    expect(last.env.authorId).toBe(owner)
  })

  it('publishes events delete then update envelopes on soft-delete and restore', async () => {
    const owner = `user_${Date.now()}_delpub`
    const bearer = await loginAs(owner)
    const created = (await (
      await req(bearer, 'POST', '/api/v1/ui/events', {
        name: 'Del Pub',
        timezone: 'UTC',
      })
    ).json()) as { id: string }
    const channel = `events:event:${created.id}`
    const onChannel = () => bus.published.filter((p) => p.channel === channel)

    const beforeDel = onChannel().length
    expect((await req(bearer, 'DELETE', `/api/v1/ui/events/${created.id}`)).status).toBe(204)
    let last = onChannel()[onChannel().length - 1]!
    expect(onChannel().length).toBe(beforeDel + 1)
    expect(last.env.resource).toBe('events')
    expect(last.env.operation).toBe('delete')
    expect(last.env.payload.id).toBe(created.id)
    expect(last.env.authorId).toBe(owner)

    const beforeRestore = onChannel().length
    expect((await req(bearer, 'POST', `/api/v1/ui/events/${created.id}/restore`)).status).toBe(200)
    last = onChannel()[onChannel().length - 1]!
    expect(onChannel().length).toBe(beforeRestore + 1)
    expect(last.env.resource).toBe('events')
    expect(last.env.operation).toBe('update')
    expect(last.env.payload.id).toBe(created.id)
  })

  it('clears a description via PATCH with an empty string', async () => {
    const owner = `user_${Date.now()}_clear`
    const bearer = await loginAs(owner)
    const created = (await (
      await req(bearer, 'POST', '/api/v1/ui/events', {
        name: 'Has Desc',
        timezone: 'UTC',
        description: 'something',
      })
    ).json()) as { id: string; description: string | null }
    expect(created.description).toBe('something')

    const res = await req(bearer, 'PATCH', `/api/v1/ui/events/${created.id}`, {
      description: '',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { description: string | null }
    expect(body.description).toBeNull()
  })

  it('restores within the grace window and 409s past it', async () => {
    const owner = `user_${Date.now()}_restore`
    const bearer = await loginAs(owner)

    // In-grace restore.
    const fresh = (await (
      await req(bearer, 'POST', '/api/v1/ui/events', {
        name: 'Restore Me',
        timezone: 'UTC',
      })
    ).json()) as { id: string }
    await req(bearer, 'DELETE', `/api/v1/ui/events/${fresh.id}`)
    const restore = await req(bearer, 'POST', `/api/v1/ui/events/${fresh.id}/restore`)
    expect(restore.status).toBe(200)
    const restored = (await restore.json()) as { deleted_at: string | null }
    expect(restored.deleted_at).toBeNull()

    // Out-of-grace restore: soft-delete with a date 31 days ago.
    const stale = (await (
      await req(bearer, 'POST', '/api/v1/ui/events', {
        name: 'Too Late',
        timezone: 'UTC',
      })
    ).json()) as { id: string }
    await repos.events.softDelete(stale.id, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000))
    const late = await req(bearer, 'POST', `/api/v1/ui/events/${stale.id}/restore`)
    expect(late.status).toBe(409)
    const body = (await late.json()) as { error: { code: string } }
    expect(body.error.code).toBe('event_purge_window_elapsed')
  })

  it('creates an invite and lets another user accept it', async () => {
    const owner = `user_${Date.now()}_inv`
    const invitee = `${owner}_invitee`
    const ownerBearer = await loginAs(owner)
    const inviteeBearer = await loginAs(invitee)

    const event = (await (
      await req(ownerBearer, 'POST', '/api/v1/ui/events', {
        name: 'Invite Event',
        timezone: 'UTC',
      })
    ).json()) as { id: string; slug: string }

    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${event.id}/invites`, {
      role: 'editor',
    })
    expect(inviteRes.status).toBe(201)
    const invite = (await inviteRes.json()) as { code: string; role: string }
    expect(invite.role).toBe('editor')
    expect(invite.code).toMatch(/^rpe_/)

    const accept = await req(inviteeBearer, 'POST', '/api/v1/ui/invites/accept', {
      code: invite.code,
    })
    expect(accept.status).toBe(200)
    const accepted = (await accept.json()) as { event_slug: string; role: string }
    expect(accepted.event_slug).toBe(event.slug)
    expect(accepted.role).toBe('editor')

    const member = await repos.members.findByEventAndUser(event.id, invitee)
    expect(member?.role).toBe('editor')

    // Re-accepting a consumed invite conflicts.
    const replay = await req(inviteeBearer, 'POST', '/api/v1/ui/invites/accept', {
      code: invite.code,
    })
    expect(replay.status).toBe(409)

    const activity = await repos.activity.listForEvent(event.id)
    const types = activity.map((a) => a.eventType)
    expect(types).toContain('event.invite_created')
    expect(types).toContain('event.invite_accepted')
  })
})
