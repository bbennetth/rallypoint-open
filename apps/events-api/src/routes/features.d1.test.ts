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
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for per-event feature toggles (#216): the
// owner-only `features` PATCH surface, resolved defaults on reads,
// 404-when-off enforcement on the lineup/sessions/groups surfaces,
// and the attendee-visible "who's going" endpoints.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

interface EventJson {
  id: string
  slug: string
  features: { lineup: boolean; sessions: boolean; groups: boolean; attendees: boolean }
}

describe('D1 integration — per-event feature toggles (#216)', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
      batchLookupUsers: async (userIds: string[]) =>
        userIds.map((userId) => ({
          userId,
          email: `${userId}@example.test`,
          displayName: `Name of ${userId}`,
        })),
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

  async function createEvent(bearer: string, name: string): Promise<EventJson> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    expect(res.status).toBe(201)
    return (await res.json()) as EventJson
  }

  async function addMember(eventId: string, userId: string, role: 'editor' | 'viewer') {
    await repos.members.add({ id: `evm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, eventId, userId, role })
  }

  it('new events resolve to defaults: lineup/sessions/groups on, attendees off', async () => {
    const bearer = await loginAs(`user_${Date.now()}_defaults`)
    const event = await createEvent(bearer, 'Defaults Fest')
    expect(event.features).toEqual({
      lineup: true,
      sessions: true,
      groups: true,
      attendees: false,
    })
  })

  it('owner can patch features partially; merge preserves earlier toggles', async () => {
    const bearer = await loginAs(`user_${Date.now()}_fpatch`)
    const event = await createEvent(bearer, 'Patch Fest')

    const first = await req(bearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { lineup: false },
    })
    expect(first.status).toBe(200)
    expect(((await first.json()) as EventJson).features).toMatchObject({
      lineup: false,
      sessions: true,
    })

    const second = await req(bearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { attendees: true },
    })
    expect(second.status).toBe(200)
    const after = ((await second.json()) as EventJson).features
    expect(after).toEqual({ lineup: false, sessions: true, groups: true, attendees: true })
  })

  it('non-owner editors cannot patch features (403 features_owner_only); unknown keys 400', async () => {
    const owner = `user_${Date.now()}_fgate`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const event = await createEvent(ownerBearer, 'Gate Fest')
    await addMember(event.id, editor, 'editor')

    const res = await req(editorBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { lineup: false },
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'features_owner_only',
    )

    // Editor patching non-feature fields still works.
    const okPatch = await req(editorBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      description: 'still editable',
    })
    expect(okPatch.status).toBe(200)

    const bad = await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { lineups: false },
    })
    expect(bad.status).toBe(400)
  })

  it('lineup off → 404 for editors/viewers, owner keeps access', async () => {
    const owner = `user_${Date.now()}_loff`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const event = await createEvent(ownerBearer, 'Lineup Off Fest')
    await addMember(event.id, editor, 'editor')

    await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { lineup: false },
    })

    expect((await req(editorBearer, 'GET', `/api/v1/ui/events/${event.id}/lineup`)).status).toBe(404)
    expect((await req(editorBearer, 'GET', `/api/v1/ui/events/${event.id}/lineup/stars`)).status).toBe(404)
    // Owner exempt — toggling back on loses nothing.
    expect((await req(ownerBearer, 'GET', `/api/v1/ui/events/${event.id}/lineup`)).status).toBe(200)
    // Non-gated surfaces unaffected (stages/days are shared settings infra).
    expect((await req(editorBearer, 'GET', `/api/v1/ui/events/${event.id}/stages`)).status).toBe(200)
  })

  it('sessions off → 404 for editors, owner keeps access', async () => {
    const owner = `user_${Date.now()}_soff`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const event = await createEvent(ownerBearer, 'Sessions Off Fest')
    await addMember(event.id, editor, 'editor')

    await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { sessions: false },
    })

    expect((await req(editorBearer, 'GET', `/api/v1/ui/events/${event.id}/sessions`)).status).toBe(404)
    expect(
      (await req(editorBearer, 'POST', `/api/v1/ui/events/${event.id}/sessions`, { title: 'X' }))
        .status,
    ).toBe(404)
    expect(
      (
        await req(editorBearer, 'POST', `/api/v1/ui/events/${event.id}/sessions/bulk`, {
          creates: [{ title: 'X' }],
        })
      ).status,
    ).toBe(404)
    expect((await req(ownerBearer, 'GET', `/api/v1/ui/events/${event.id}/sessions`)).status).toBe(200)
  })

  it('groups off → create/list 404 for non-owners and join codes read as invalid', async () => {
    const owner = `user_${Date.now()}_goff`
    const editor = `${owner}_editor`
    const joiner = `${owner}_joiner`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const joinerBearer = await loginAs(joiner)
    const event = await createEvent(ownerBearer, 'Groups Off Fest')
    await addMember(event.id, editor, 'editor')

    // Create a group while groups are still on, so we have a live code.
    const created = (await (
      await req(editorBearer, 'POST', `/api/v1/ui/events/${event.id}/groups`, { name: 'Crew' })
    ).json()) as { join_code: string }
    expect(created.join_code).toBeTruthy()

    await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { groups: false },
    })

    expect(
      (await req(editorBearer, 'POST', `/api/v1/ui/events/${event.id}/groups`, { name: 'Nope' }))
        .status,
    ).toBe(404)
    expect((await req(editorBearer, 'GET', `/api/v1/ui/events/${event.id}/groups`)).status).toBe(404)
    // Join by code 404s like a dead code.
    expect(
      (await req(joinerBearer, 'POST', '/api/v1/ui/groups/join', { code: created.join_code }))
        .status,
    ).toBe(404)
    // Owner exempt.
    expect((await req(ownerBearer, 'GET', `/api/v1/ui/events/${event.id}/groups`)).status).toBe(200)
  })

  it("who's going: off by default (404), on → names only, no emails", async () => {
    const owner = `user_${Date.now()}_who`
    const viewer = `${owner}_viewer`
    const ownerBearer = await loginAs(owner)
    const viewerBearer = await loginAs(viewer)
    const event = await createEvent(ownerBearer, "Who's Going Fest")
    await addMember(event.id, viewer, 'viewer')
    await repos.attendees.upsert({ id: `eva_${Date.now()}_w`, eventId: event.id, userId: viewer })

    // Default off → 404 for the viewer.
    expect(
      (await req(viewerBearer, 'GET', `/api/v1/ui/events/${event.id}/attendees/community`)).status,
    ).toBe(404)

    await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { attendees: true },
    })

    const res = await req(viewerBearer, 'GET', `/api/v1/ui/events/${event.id}/attendees/community`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<Record<string, unknown>> }
    expect(body.items.length).toBe(1)
    expect(body.items[0]).toMatchObject({
      user_id: viewer,
      display_name: `Name of ${viewer}`,
    })
    expect(body.items[0]).not.toHaveProperty('email')
  })

  it("who's going via group membership: gated by the same toggle", async () => {
    const owner = `user_${Date.now()}_gwho`
    const member = `${owner}_member`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const event = await createEvent(ownerBearer, 'Group Who Fest')
    // Group create is editor+ on the event surface.
    await addMember(event.id, member, 'editor')

    const created = (await (
      await req(memberBearer, 'POST', `/api/v1/ui/events/${event.id}/groups`, { name: 'Crew' })
    ).json()) as { id: string }

    // Toggle off (default) → 404.
    expect((await req(memberBearer, 'GET', `/api/v1/ui/groups/${created.id}/attendees`)).status).toBe(404)

    await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { attendees: true },
    })
    const res = await req(memberBearer, 'GET', `/api/v1/ui/groups/${created.id}/attendees`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<Record<string, unknown>> }
    expect(body.items.every((i) => !('email' in i))).toBe(true)
  })

  it('PATCH with features by a non-owner is all-or-nothing — other fields untouched', async () => {
    const owner = `user_${Date.now()}_atomic`
    const editor = `${owner}_editor`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const event = await createEvent(ownerBearer, 'Atomic Fest')
    await addMember(event.id, editor, 'editor')

    const res = await req(editorBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      name: 'Sneaky rename',
      features: { lineup: false },
    })
    expect(res.status).toBe(403)
    const fresh = await repos.events.findById(event.id)
    expect(fresh!.name).toBe('Atomic Fest')
    expect(fresh!.features).toBeNull()
  })

  it('groups off → a consumed invite also reads as a dead code (no state leak)', async () => {
    const owner = `user_${Date.now()}_inviteleak`
    const editor = `${owner}_editor`
    const joinerA = `${owner}_ja`
    const joinerB = `${owner}_jb`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const joinerABearer = await loginAs(joinerA)
    const joinerBBearer = await loginAs(joinerB)
    const event = await createEvent(ownerBearer, 'Invite Leak Fest')
    await addMember(event.id, editor, 'editor')

    const group = (await (
      await req(editorBearer, 'POST', `/api/v1/ui/events/${event.id}/groups`, { name: 'Crew' })
    ).json()) as { id: string }
    const invite = (await (
      await req(editorBearer, 'POST', `/api/v1/ui/groups/${group.id}/invites`, {})
    ).json()) as { code: string }
    // Consume the invite while groups are still on.
    expect(
      (await req(joinerABearer, 'POST', '/api/v1/ui/groups/join', { code: invite.code })).status,
    ).toBe(200)

    await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { groups: false },
    })

    // With groups off, the consumed invite must NOT leak its consumed
    // state (409) — it reads as not-found like any dead code.
    const res = await req(joinerBBearer, 'POST', '/api/v1/ui/groups/join', { code: invite.code })
    expect(res.status).toBe(404)
  })

  it('public SDK lineup/sessions feeds 404 when the toggle is off', async () => {
    const owner = `user_${Date.now()}_sdkgate`
    const ownerBearer = await loginAs(owner)
    const event = await createEvent(ownerBearer, 'SDK Gate Fest')
    // Enable the public page so the feeds are reachable at all.
    await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      publicPageConfig: { enabled: true, sections: [{ kind: 'lineup' }] },
    })

    const anon = (path: string) => app.request(`http://localhost${path}`)
    expect((await anon(`/api/v1/sdk/events/${event.slug}/lineup`)).status).toBe(200)
    expect((await anon(`/api/v1/sdk/events/${event.slug}/sessions`)).status).toBe(200)

    await req(ownerBearer, 'PATCH', `/api/v1/ui/events/${event.id}`, {
      features: { lineup: false, sessions: false },
    })
    expect((await anon(`/api/v1/sdk/events/${event.slug}/lineup`)).status).toBe(404)
    expect((await anon(`/api/v1/sdk/events/${event.slug}/sessions`)).status).toBe(404)
  })
})
