import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services, UserBatchEntry } from '../services/types.js'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the Phase 0 attendees + privacy rule surface.
// Replaces attendees.it.test.ts. Runs inside a workerd isolate (Miniflare D1),
// migrations applied by apps/events-api/test/apply-d1-migrations.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — Phase 0 attendees + privacy rule', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  // Configurable batch-lookup stub: tests can preload `lookupTable`
  // before calling endpoints that surface emails.
  const lookupTable = new Map<string, UserBatchEntry>()

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
      batchLookupUsers: async (userIds) => {
        const out: UserBatchEntry[] = []
        for (const id of userIds) {
          const e = lookupTable.get(id)
          if (e) out.push(e)
        }
        return out
      },
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

  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    const body = (await res.json()) as { id: string }
    return body.id
  }

  // ── attendees list + remove ───────────────────────────────────────
  it('shows the owner + invite-accepted attendees with email + role from RPID lookup', async () => {
    const owner = `user_${Date.now()}_p0o`
    const guest = `user_${Date.now()}_p0g`
    lookupTable.set(owner, {
      userId: owner,
      email: 'owner@example.test',
      emailVerified: true,
      displayName: 'Owner Ow',
      pictureUrl: null,
    })
    lookupTable.set(guest, {
      userId: guest,
      email: 'guest@example.test',
      emailVerified: true,
      displayName: 'Guest G',
      pictureUrl: null,
    })
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const eventId = await createEvent(ownerBearer, 'Attendees Smoke')

    // The owner is auto-attending (event create flow). Plus a guest
    // accepts an invite.
    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
      role: 'viewer',
      invitedEmail: 'guest@example.test',
    })
    const { code } = (await inviteRes.json()) as { code: string }
    const acceptRes = await req(guestBearer, 'POST', '/api/v1/ui/invites/accept', { code })
    expect(acceptRes.status).toBe(200)

    const listRes = await req(ownerBearer, 'GET', `/api/v1/ui/events/${eventId}/attendees`)
    expect(listRes.status).toBe(200)
    const { items } = (await listRes.json()) as {
      items: Array<{ user_id: string; email: string | null; role: string | null }>
    }
    expect(items.find((x) => x.user_id === guest)?.email).toBe('guest@example.test')
    expect(items.find((x) => x.user_id === guest)?.role).toBe('viewer')
  })

  it('soft-removes an attendee and blocks owner self-removal', async () => {
    const owner = `user_${Date.now()}_p0r1`
    const guest = `user_${Date.now()}_p0r2`
    lookupTable.set(owner, {
      userId: owner,
      email: 'r-owner@example.test',
      emailVerified: true,
      displayName: null,
      pictureUrl: null,
    })
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const eventId = await createEvent(ownerBearer, 'Remove Smoke')

    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
      role: 'viewer',
    })
    const { code } = (await inviteRes.json()) as { code: string }
    await req(guestBearer, 'POST', '/api/v1/ui/invites/accept', { code })

    // Self-removal blocked.
    const selfRm = await req(ownerBearer, 'DELETE', `/api/v1/ui/events/${eventId}/attendees/${owner}`)
    expect(selfRm.status).toBe(409)

    // Guest removal works.
    const removeRes = await req(
      ownerBearer,
      'DELETE',
      `/api/v1/ui/events/${eventId}/attendees/${guest}`,
    )
    expect(removeRes.status).toBe(204)

    const listAfter = await req(ownerBearer, 'GET', `/api/v1/ui/events/${eventId}/attendees`)
    const after = (await listAfter.json()) as { items: Array<{ user_id: string }> }
    expect(after.items.some((x) => x.user_id === guest)).toBe(false)
  })

  it('re-admits a soft-removed attendee via a fresh invite (round 3)', async () => {
    // A soft-removed attendee keeps their event_members row, so a
    // naive "already_member" guard on accept-invite would lock them
    // out. The re-admission path unblocks: a second invite-accept
    // clears removed_at and the attendee shows back up in the list.
    const owner = `user_${Date.now()}_p0re_o`
    const guest = `user_${Date.now()}_p0re_g`
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const eventId = await createEvent(ownerBearer, 'Re-admit Smoke')

    // First invite + accept.
    const first = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
      role: 'viewer',
    })
    const firstCode = ((await first.json()) as { code: string }).code
    const firstAccept = await req(guestBearer, 'POST', '/api/v1/ui/invites/accept', {
      code: firstCode,
    })
    expect(firstAccept.status).toBe(200)

    // Owner removes guest.
    const removeRes = await req(
      ownerBearer,
      'DELETE',
      `/api/v1/ui/events/${eventId}/attendees/${guest}`,
    )
    expect(removeRes.status).toBe(204)

    // Guest is gone from the list.
    const gone = await req(ownerBearer, 'GET', `/api/v1/ui/events/${eventId}/attendees`)
    const goneBody = (await gone.json()) as { items: Array<{ user_id: string }> }
    expect(goneBody.items.some((x) => x.user_id === guest)).toBe(false)

    // Fresh invite — re-admission path: accept must succeed even
    // though event_members row still exists.
    const second = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
      role: 'viewer',
    })
    const secondCode = ((await second.json()) as { code: string }).code
    const secondAccept = await req(guestBearer, 'POST', '/api/v1/ui/invites/accept', {
      code: secondCode,
    })
    expect(secondAccept.status).toBe(200)

    // Guest is back in the list.
    const back = await req(ownerBearer, 'GET', `/api/v1/ui/events/${eventId}/attendees`)
    const backBody = (await back.json()) as { items: Array<{ user_id: string }> }
    expect(backBody.items.some((x) => x.user_id === guest)).toBe(true)
  })

  // ── pending invites + bulk + revoke ──────────────────────────────
  it('lists pending invites and revokes them by id', async () => {
    const owner = `user_${Date.now()}_p0i`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Invites Smoke')

    const inviteRes = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
      role: 'viewer',
      invitedEmail: 'pending@example.test',
    })
    const created = (await inviteRes.json()) as { id: string }

    const list = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/invites`)
    expect(list.status).toBe(200)
    const { items } = (await list.json()) as {
      items: Array<{ id: string; invited_email: string | null }>
    }
    expect(items.find((x) => x.id === created.id)?.invited_email).toBe('pending@example.test')

    const rm = await req(bearer, 'DELETE', `/api/v1/ui/events/${eventId}/invites/${created.id}`)
    expect(rm.status).toBe(204)

    const listAfter = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/invites`)
    const after = (await listAfter.json()) as { items: Array<{ id: string }> }
    expect(after.items.some((x) => x.id === created.id)).toBe(false)
  })

  it('bulk-creates invites and de-duplicates within the request', async () => {
    const owner = `user_${Date.now()}_p0b`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Bulk Smoke')

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/invites/bulk`, {
      emails: ['a@x.test', 'b@x.test', 'A@X.test'],
      role: 'editor',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      created: Array<{ email: string; code: string }>
    }
    // 3 inputs, but A@X.test and a@x.test normalize to the same email.
    expect(body.created.length).toBe(2)
    expect(new Set(body.created.map((x) => x.email))).toEqual(
      new Set(['a@x.test', 'b@x.test']),
    )
  })

  // ── privacy rule ─────────────────────────────────────────────────
  it('blocks event-owner from group routes when not a group member', async () => {
    const owner = `user_${Date.now()}_p0v_o`
    const member = `user_${Date.now()}_p0v_m`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const eventId = await createEvent(ownerBearer, 'Privacy Smoke')

    // Member accepts an editor-role invite into the event, then creates
    // a group. The owner is NOT a group member.
    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
      role: 'editor',
    })
    const { code } = (await inviteRes.json()) as { code: string }
    await req(memberBearer, 'POST', '/api/v1/ui/invites/accept', { code })

    const groupRes = await req(memberBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
      name: 'Owls',
    })
    expect(groupRes.status).toBe(201)
    const { id: groupId } = (await groupRes.json()) as { id: string }

    // Owner gets 404 (privacy: don't leak existence).
    const ownerProbe = await req(ownerBearer, 'GET', `/api/v1/ui/groups/${groupId}`)
    expect(ownerProbe.status).toBe(404)

    // Owner's "list groups in this event" returns empty for them.
    const ownerList = await req(ownerBearer, 'GET', `/api/v1/ui/events/${eventId}/groups`)
    const ownerListBody = (await ownerList.json()) as { items: Array<{ id: string }> }
    expect(ownerListBody.items.some((g) => g.id === groupId)).toBe(false)

    // But the member sees their own group.
    const memberList = await req(memberBearer, 'GET', `/api/v1/ui/events/${eventId}/groups`)
    const memberListBody = (await memberList.json()) as { items: Array<{ id: string }> }
    expect(memberListBody.items.some((g) => g.id === groupId)).toBe(true)
  })

  // ── #171 atomic invite accept ────────────────────────────────────

  it('accept-invite writes event_members + event_attendees + invite consumed atomically', async () => {
    const owner = `user_${Date.now()}_171_aa_o`
    const guest = `user_${Date.now()}_171_aa_g`
    const ownerBearer = await loginAs(owner)
    const guestBearer = await loginAs(guest)
    const eventId = await createEvent(ownerBearer, 'Atomic Accept')

    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
      role: 'editor',
    })
    const invite = (await inviteRes.json()) as { id: string; code: string }

    const accept = await req(guestBearer, 'POST', '/api/v1/ui/invites/accept', {
      code: invite.code,
    })
    expect(accept.status).toBe(200)

    // All three rows are present and self-consistent.
    const memberRow = await repos.members.findByEventAndUser(eventId, guest)
    expect(memberRow?.role).toBe('editor')
    const attendeeRow = await repos.attendees.findByEventAndUser(eventId, guest)
    expect(attendeeRow).not.toBeNull()
    expect(attendeeRow?.removedAt).toBeNull()
    const inviteRow = await repos.invites.findById(invite.id)
    expect(inviteRow?.consumedByUserId).toBe(guest)
    expect(inviteRow?.consumedAt).not.toBeNull()
  })
})
