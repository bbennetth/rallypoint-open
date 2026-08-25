import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { SYSTEM_USER_ID } from '@rallypoint/shared'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the self-service attendance endpoints
// (owner "join as attendee") and the system-owned-event access rules
// (sentinel owner + ADMIN_USER_IDS allowlist).

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const ADMIN = 'user_admin_attendance_tests'

describe('D1 integration — attendance self-join + system events', () => {
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
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', ADMIN_USER_IDS: ` ${ADMIN} , ` })
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
      origin: envVars.EVENTS_UI_ORIGIN,
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

  async function createSystemEvent(name: string): Promise<{ id: string; slug: string }> {
    const event = await repos.events.create({
      id: `event_${ulid()}`,
      tenantId: 'rallypoint',
      ownerUserId: SYSTEM_USER_ID,
      slug: `sys-${ulid().toLowerCase()}`,
      name,
      timezone: 'UTC',
      privacyMode: 'unlisted',
    })
    return { id: event.id, slug: event.slug }
  }

  // ── owner self-join / leave ───────────────────────────────────────
  it('owner joins as attendee, appears in the roster with role owner, and can leave', async () => {
    const owner = `user_${Date.now()}_ajo`
    const bearer = await loginAs(owner)
    const { id, slug } = await createEvent(bearer, 'Owner Join')

    // Not attending initially.
    const before = (await (await req(bearer, 'GET', `/api/v1/ui/events/${slug}`)).json()) as {
      viewer_attending: boolean
      viewer_role: string
    }
    expect(before.viewer_role).toBe('owner')
    expect(before.viewer_attending).toBe(false)

    const join = await req(bearer, 'POST', `/api/v1/ui/events/${id}/attendance`)
    expect(join.status).toBe(200)
    expect(((await join.json()) as { attending: boolean }).attending).toBe(true)

    const roster = (await (
      await req(bearer, 'GET', `/api/v1/ui/events/${id}/attendees`)
    ).json()) as { items: { user_id: string; role: string | null }[] }
    expect(roster.items.map((i) => [i.user_id, i.role])).toContainEqual([owner, 'owner'])

    const detail = (await (await req(bearer, 'GET', `/api/v1/ui/events/${slug}`)).json()) as {
      viewer_attending: boolean
    }
    expect(detail.viewer_attending).toBe(true)

    // Leave: roster row soft-removed, but owner access is untouched.
    const leave = await req(bearer, 'DELETE', `/api/v1/ui/events/${id}/attendance`)
    expect(leave.status).toBe(200)
    const after = (await (await req(bearer, 'GET', `/api/v1/ui/events/${slug}`)).json()) as {
      viewer_attending: boolean
      viewer_role: string
    }
    expect(after.viewer_role).toBe('owner')
    expect(after.viewer_attending).toBe(false)
  })

  it('join is idempotent and re-join after leave re-activates the row', async () => {
    const owner = `user_${Date.now()}_aji`
    const bearer = await loginAs(owner)
    const { id } = await createEvent(bearer, 'Idempotent Join')

    expect((await req(bearer, 'POST', `/api/v1/ui/events/${id}/attendance`)).status).toBe(200)
    expect((await req(bearer, 'POST', `/api/v1/ui/events/${id}/attendance`)).status).toBe(200)
    expect((await req(bearer, 'DELETE', `/api/v1/ui/events/${id}/attendance`)).status).toBe(200)
    expect((await req(bearer, 'POST', `/api/v1/ui/events/${id}/attendance`)).status).toBe(200)
    const attendee = await repos.attendees.findByEventAndUser(id, owner)
    expect(attendee?.removedAt).toBeNull()
  })

  it('leave 409s when not attending, and 409s for non-owner roles', async () => {
    const owner = `user_${Date.now()}_alo`
    const guest = `user_${Date.now()}_alg`
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const { id } = await createEvent(ownerBearer, 'Leave Guards')

    const notAttending = await req(ownerBearer, 'DELETE', `/api/v1/ui/events/${id}/attendance`)
    expect(notAttending.status).toBe(409)
    expect(((await notAttending.json()) as { error: { code: string } }).error.code).toBe('not_attending')

    // Bring in a viewer collaborator via invite; their self-leave is
    // refused (it would revoke their access entirely).
    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${id}/invites`, {
      role: 'viewer',
    })
    const { code } = (await inviteRes.json()) as { code: string }
    expect((await req(guestBearer, 'POST', '/api/v1/ui/invites/accept', { code })).status).toBe(200)
    const guestLeave = await req(guestBearer, 'DELETE', `/api/v1/ui/events/${id}/attendance`)
    expect(guestLeave.status).toBe(409)
    expect(((await guestLeave.json()) as { error: { code: string } }).error.code).toBe('self_leave_owner_only')
  })

  it('404s for a user with no access to the event', async () => {
    const owner = `user_${Date.now()}_ano`
    const stranger = `user_${Date.now()}_ans`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const { id } = await createEvent(ownerBearer, 'No Access')
    expect((await req(strangerBearer, 'POST', `/api/v1/ui/events/${id}/attendance`)).status).toBe(404)
  })

  // ── system-owned events ───────────────────────────────────────────
  it('allowlisted admin resolves as owner on a system event and can join as attendee', async () => {
    const adminBearer = await loginAs(ADMIN)
    const { id, slug } = await createSystemEvent('System Fest')

    const detail = await req(adminBearer, 'GET', `/api/v1/ui/events/${slug}`)
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { viewer_role: string }).viewer_role).toBe('owner')

    expect((await req(adminBearer, 'POST', `/api/v1/ui/events/${id}/attendance`)).status).toBe(200)
    const roster = (await (
      await req(adminBearer, 'GET', `/api/v1/ui/events/${id}/attendees`)
    ).json()) as { items: { user_id: string; role: string | null }[] }
    // The joined admin reports role 'owner' (actorRole parity), and
    // the sentinel itself never has an attendee row.
    expect(roster.items.map((i) => [i.user_id, i.role])).toContainEqual([ADMIN, 'owner'])
    expect(roster.items.map((i) => i.user_id)).not.toContain(SYSTEM_USER_ID)
  })

  it('non-allowlisted users 404 on a system event; admins get no special access to normal events', async () => {
    const user = `user_${Date.now()}_sysx`
    const userBearer = await loginAs(user)
    const adminBearer = await loginAs(ADMIN)

    const { slug } = await createSystemEvent('System Hidden')
    expect((await req(userBearer, 'GET', `/api/v1/ui/events/${slug}`)).status).toBe(404)

    const normal = await createEvent(userBearer, 'Normal Event')
    expect((await req(adminBearer, 'GET', `/api/v1/ui/events/${normal.slug}`)).status).toBe(404)
  })

  // ── My Events visibility for self-attended system events ──────────
  // An admin gets 'owner' on a system event via the actorRole
  // short-circuit, never an event_members row — so self-attendance is
  // what has to surface it in GET /api/v1/ui/events.
  it('self-attended system event appears in My Events for an admin, and leaves again on leave', async () => {
    const adminBearer = await loginAs(ADMIN)
    const { id } = await createSystemEvent('System In My Events')

    const listIds = async (): Promise<{ id: string; viewer_role: string }[]> => {
      const res = await req(adminBearer, 'GET', '/api/v1/ui/events?limit=100')
      expect(res.status).toBe(200)
      return ((await res.json()) as { items: { id: string; viewer_role: string }[] }).items
    }

    expect((await listIds()).map((e) => e.id)).not.toContain(id)

    expect((await req(adminBearer, 'POST', `/api/v1/ui/events/${id}/attendance`)).status).toBe(200)
    const joined = await listIds()
    expect(joined.map((e) => e.id)).toContain(id)
    expect(joined.find((e) => e.id === id)?.viewer_role).toBe('owner')
    // No membership row was materialized to achieve this.
    expect(await repos.members.findByEventAndUser(id, ADMIN)).toBeNull()

    expect((await req(adminBearer, 'DELETE', `/api/v1/ui/events/${id}/attendance`)).status).toBe(200)
    expect((await listIds()).map((e) => e.id)).not.toContain(id)
  })

  it('a non-admin who browse-joins a system event still sees it via their member row', async () => {
    const joiner = `user_${Date.now()}_sysjoin`
    const joinerBearer = await loginAs(joiner)
    const { id } = await createSystemEvent('System Browse Join')

    expect((await req(joinerBearer, 'POST', `/api/v1/ui/events/${id}/join`)).status).toBe(200)
    const res = await req(joinerBearer, 'GET', '/api/v1/ui/events?limit=100')
    const items = ((await res.json()) as { items: { id: string; viewer_role: string }[] }).items
    expect(items.map((e) => e.id)).toContain(id)
    expect(items.find((e) => e.id === id)?.viewer_role).toBe('viewer')
  })

  it('a bare attendee row on a system event does not surface it for a non-admin', async () => {
    const user = `user_${Date.now()}_bareatt`
    const userBearer = await loginAs(user)
    const { id } = await createSystemEvent('System Bare Attendee')
    // Attendance without membership — the exact shape the admin path
    // produces, but for a caller the allowlist doesn't cover.
    await repos.attendees.upsert({ id: `eva_${ulid()}`, eventId: id, userId: user })

    const res = await req(userBearer, 'GET', '/api/v1/ui/events?limit=100')
    const items = ((await res.json()) as { items: { id: string }[] }).items
    expect(items.map((e) => e.id)).not.toContain(id)
  })

  it('system events cannot be transferred', async () => {
    const adminBearer = await loginAs(ADMIN)
    const { id } = await createSystemEvent('System Locked')
    const res = await req(adminBearer, 'POST', `/api/v1/ui/events/${id}/transfer`, {
      newOwnerUserId: 'user_someoneelse',
      currentPassword: 'irrelevant',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('system_event_not_transferable')
  })
})
