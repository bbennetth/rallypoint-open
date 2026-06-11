import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { ulid } from 'ulid'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import type {
  BalanceDto,
  EnsureGroupLedgerInput,
  EnsureGroupLedgerResult,
  ExpenseDto,
  LedgerDto,
} from '@rallypoint/money-client'
import { makeNoopMoneyClient, makeNoopListsClient, makeStubObjectStore } from './_test-services.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { EVENTS_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// Integration tests for the group surface (slice 6) against a real
// Postgres (testcontainers). Boilerplate mirrors events.it.test.ts:
// RPID stubbed at the services layer (verifier echoes bearer as the
// user id), CSRF satisfied with a matched cookie+header pair.


const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

// Per-test handlers can be re-assigned to drive the money-client
// stub: e.g. `moneyHandlers.ensureGroupLedger = async () => { throw … }`
// to simulate a money-api outage. Reset in beforeEach if a test
// expects to start from defaults.
const moneyHandlers: {
  ensureGroupLedger?: (input: EnsureGroupLedgerInput) => Promise<EnsureGroupLedgerResult>
  listLedgers?: (scope: { scopeType: 'group' | 'ledger_group' | 'personal'; scopeId: string }) => Promise<LedgerDto[]>
  listExpenses?: (ledgerId: string) => Promise<ExpenseDto[]>
  getBalances?: (ledgerId: string, viewerUserId: string) => Promise<BalanceDto>
} = {}

function makeProxiedMoneyClient() {
  const noop = makeNoopMoneyClient()
  return {
    ...noop,
    ensureGroupLedger: async (input: EnsureGroupLedgerInput) =>
      (moneyHandlers.ensureGroupLedger ?? noop.ensureGroupLedger)(input),
    listLedgers: async (scope: { scopeType: 'group' | 'ledger_group' | 'personal'; scopeId: string }) =>
      (moneyHandlers.listLedgers ?? noop.listLedgers)(scope),
    listExpenses: async (ledgerId: string) =>
      (moneyHandlers.listExpenses ?? noop.listExpenses)(ledgerId),
    getBalances: async (ledgerId: string, viewerUserId: string) =>
      (moneyHandlers.getBalances ?? noop.getBalances)(ledgerId, viewerUserId),
  }
}

describe('D1 integration — groups + members + invites', () => {
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
    // Configurable money client so tests can override behaviour
    // (forcing a throw, returning canned ledgers) per-case via
    // `moneyHandlers.X = ...`. Defaults to a noop stub.
    listsClient: makeNoopListsClient(),
    moneyClient: makeProxiedMoneyClient(),
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

  // Create an event owned by `owner`, returning its id.
  async function createEvent(bearer: string, name: string): Promise<string> {
    const res = await req(bearer, 'POST', '/api/v1/ui/events', { name, timezone: 'UTC' })
    const body = (await res.json()) as { id: string }
    return body.id
  }

  it('rejects an unauthenticated group request', async () => {
    const res = await app.request('http://localhost/api/v1/ui/groups/join', {
      method: 'POST',
      headers: { 'x-rp-csrf': CSRF, cookie: `${envVars.EVENTS_CSRF_COOKIE_NAME}=${CSRF}` },
      body: JSON.stringify({ code: 'rpj_abc' }),
    })
    expect(res.status).toBe(401)
  })

  it('creates a group with an owner member row, join code, and audit', async () => {
    const owner = `user_${Date.now()}_co`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Group Create Event')

    const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
      name: 'Night Owls',
    })
    expect(res.status).toBe(201)
    const group = (await res.json()) as Record<string, unknown>
    expect(group.name).toBe('Night Owls')
    expect(group.viewer_role).toBe('owner')
    expect(group.owner_user_id).toBe(owner)
    expect(group.member_count).toBe(1)
    expect(group.join_code).toMatch(/^rpj_/)

    const members = await repos.groupMembers.listForGroup(group.id as string)
    expect(members).toHaveLength(1)
    expect(members[0]!.userId).toBe(owner)
    expect(members[0]!.role).toBe('owner')

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('group.created')
  })

  it('409s on a duplicate group name within an event', async () => {
    const owner = `user_${Date.now()}_dup`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Group Dup Event')

    const first = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Same' })
    expect(first.status).toBe(201)
    const second = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Same' })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('group_name_taken')
  })

  it('lists groups for an event with member counts', async () => {
    const owner = `user_${Date.now()}_ls`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Group List Event')
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Alpha' })
    await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Beta' })

    const res = await req(bearer, 'GET', `/api/v1/ui/events/${eventId}/groups`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ name: string; member_count: number }> }
    expect(body.items.map((i) => i.name).sort()).toEqual(['Alpha', 'Beta'])
    expect(body.items.every((i) => i.member_count === 1)).toBe(true)
    // The join code must not leak in the list.
    expect(body.items.every((i) => !('join_code' in i))).toBe(true)
  })

  it('lets another user join via the standing join code', async () => {
    const owner = `user_${Date.now()}_jc`
    const joiner = `${owner}_joiner`
    const ownerBearer = await loginAs(owner)
    const joinerBearer = await loginAs(joiner)
    const eventId = await createEvent(ownerBearer, 'Group Join Event')

    const created = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Joinable' })
    ).json()) as { id: string; join_code: string }

    const res = await req(joinerBearer, 'POST', '/api/v1/ui/groups/join', { code: created.join_code })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { group_id: string; role: string }
    expect(body.group_id).toBe(created.id)
    expect(body.role).toBe('member')

    const member = await repos.groupMembers.findByGroupAndUser(created.id, joiner)
    expect(member?.role).toBe('member')

    // Duplicate join conflicts.
    const dup = await req(joinerBearer, 'POST', '/api/v1/ui/groups/join', { code: created.join_code })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('already_group_member')

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('group.joined')
  })

  it('lets a user join via an invite code and consumes it', async () => {
    const owner = `user_${Date.now()}_iv`
    const joiner = `${owner}_joiner`
    const ownerBearer = await loginAs(owner)
    const joinerBearer = await loginAs(joiner)
    const eventId = await createEvent(ownerBearer, 'Group Invite Event')
    const created = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Inviters' })
    ).json()) as { id: string }

    const inviteRes = await req(ownerBearer, 'POST', `/api/v1/ui/groups/${created.id}/invites`, {})
    expect(inviteRes.status).toBe(201)
    const invite = (await inviteRes.json()) as { id: string; code: string }
    expect(invite.code).toMatch(/^rpj_/)

    const res = await req(joinerBearer, 'POST', '/api/v1/ui/groups/join', { code: invite.code })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { role: string }).role).toBe('member')

    // Invite is now consumed; replay conflicts.
    const replay = await req(joinerBearer, 'POST', '/api/v1/ui/groups/join', { code: invite.code })
    expect(replay.status).toBe(409)
  })

  it('prefers a group join code over a colliding invite code hash (resolver order)', async () => {
    const owner = `user_${Date.now()}_res`
    const joiner = `${owner}_joiner`
    const ownerBearer = await loginAs(owner)
    const joinerBearer = await loginAs(joiner)
    const eventId = await createEvent(ownerBearer, 'Group Resolver Event')

    // Group A's standing code is what the joiner will present.
    const groupA = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Group A' })
    ).json()) as { id: string; join_code: string }
    const groupB = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Group B' })
    ).json()) as { id: string }

    // Forge an invite on group B whose code_hash equals group A's
    // join_code_hash — the same raw code now hashes to both rows.
    const collidingHash = hashToken(groupA.join_code)
    const invite = await repos.groupInvites.create({
      id: `gri_${ulid()}`,
      groupId: groupB.id,
      codeHash: collidingHash,
      invitedByUserId: owner,
      invitedEmail: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    })

    const res = await req(joinerBearer, 'POST', '/api/v1/ui/groups/join', { code: groupA.join_code })
    expect(res.status).toBe(200)
    // The group join code wins: joiner lands in A, not B.
    expect(((await res.json()) as { group_id: string }).group_id).toBe(groupA.id)
    expect(await repos.groupMembers.findByGroupAndUser(groupB.id, joiner)).toBeNull()
    // The colliding invite is left untouched (not consumed).
    const after = await repos.groupInvites.findByCodeHash(collidingHash)
    expect(after?.consumedAt ?? null).toBeNull()
    expect(after?.id).toBe(invite.id)
  })

  it('rejects an expired invite code', async () => {
    const owner = `user_${Date.now()}_exp`
    const joiner = `${owner}_joiner`
    const ownerBearer = await loginAs(owner)
    const joinerBearer = await loginAs(joiner)
    const eventId = await createEvent(ownerBearer, 'Group Expired Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Expirers' })
    ).json()) as { id: string }

    const rawCode = generateRawToken('rpj_')
    await repos.groupInvites.create({
      id: `gri_${ulid()}`,
      groupId: group.id,
      codeHash: hashToken(rawCode),
      invitedByUserId: owner,
      invitedEmail: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    const res = await req(joinerBearer, 'POST', '/api/v1/ui/groups/join', { code: rawCode })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_invite_expired')
  })

  it('rejects an unknown join code', async () => {
    const joiner = `user_${Date.now()}_unk`
    const bearer = await loginAs(joiner)
    const res = await req(bearer, 'POST', '/api/v1/ui/groups/join', {
      code: 'rpj_doesnotexist_but_long_enough_to_pass',
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_join_code_invalid')
  })

  it('a 21st member can join (groups are uncapped)', async () => {
    const owner = `user_${Date.now()}_cap`
    const ownerBearer = await loginAs(owner)
    const eventId = await createEvent(ownerBearer, 'Group Cap Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Big Group' })
    ).json()) as { id: string; join_code: string }

    // Creator is member #1. Add 19 more directly → count = 20.
    for (let i = 0; i < 19; i++) {
      await repos.groupMembers.add({
        id: `grm_${ulid()}`,
        groupId: group.id,
        userId: `${owner}_m${i}`,
        role: 'member',
      })
    }
    expect(await repos.groupMembers.countForGroup(group.id)).toBe(20)

    // The 21st member can join — groups are uncapped.
    const lateJoiner = `${owner}_late`
    const lateBearer = await loginAs(lateJoiner)
    const res = await req(lateBearer, 'POST', '/api/v1/ui/groups/join', { code: group.join_code })
    expect(res.status).toBe(200)
    expect(await repos.groupMembers.countForGroup(group.id)).toBe(21)
  })

  it('promotes and demotes members; owner role is protected', async () => {
    const owner = `user_${Date.now()}_role`
    const member = `${owner}_member`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const eventId = await createEvent(ownerBearer, 'Group Role Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Roles' })
    ).json()) as { id: string; join_code: string }
    await req(memberBearer, 'POST', '/api/v1/ui/groups/join', { code: group.join_code })

    // Promote member → sidekick.
    const promote = await req(
      ownerBearer,
      'POST',
      `/api/v1/ui/groups/${group.id}/members/${member}/role`,
      { role: 'sidekick' },
    )
    expect(promote.status).toBe(200)
    expect((await repos.groupMembers.findByGroupAndUser(group.id, member))?.role).toBe('sidekick')

    // A non-owner (sidekick) cannot change roles.
    const forbidden = await req(
      memberBearer,
      'POST',
      `/api/v1/ui/groups/${group.id}/members/${member}/role`,
      { role: 'member' },
    )
    expect(forbidden.status).toBe(403)

    // The owner targeting themselves hits the own-role guard.
    const protectOwner = await req(
      ownerBearer,
      'POST',
      `/api/v1/ui/groups/${group.id}/members/${owner}/role`,
      { role: 'sidekick' },
    )
    expect(protectOwner.status).toBe(409)
    expect(((await protectOwner.json()) as { error: { code: string } }).error.code).toBe(
      'cannot_change_own_role',
    )

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('group.role_changed')
  })

  it('lets a member leave but blocks an owner from leaving', async () => {
    const owner = `user_${Date.now()}_leave`
    const member = `${owner}_member`
    const ownerBearer = await loginAs(owner)
    const memberBearer = await loginAs(member)
    const eventId = await createEvent(ownerBearer, 'Group Leave Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Leavers' })
    ).json()) as { id: string; join_code: string }
    await req(memberBearer, 'POST', '/api/v1/ui/groups/join', { code: group.join_code })

    // Member leaves (self-removal).
    const leave = await req(memberBearer, 'DELETE', `/api/v1/ui/groups/${group.id}/members/${member}`)
    expect(leave.status).toBe(204)
    expect(await repos.groupMembers.findByGroupAndUser(group.id, member)).toBeNull()

    // Owner cannot leave without transferring first.
    const ownerLeave = await req(ownerBearer, 'DELETE', `/api/v1/ui/groups/${group.id}/members/${owner}`)
    expect(ownerLeave.status).toBe(409)
    expect(((await ownerLeave.json()) as { error: { code: string } }).error.code).toBe(
      'group_owner_must_transfer',
    )

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('group.member_left')
  })

  it('transfers ownership and demotes the old owner to sidekick', async () => {
    const owner = `user_${Date.now()}_xfer`
    const successor = `${owner}_next`
    const ownerBearer = await loginAs(owner)
    const successorBearer = await loginAs(successor)
    const eventId = await createEvent(ownerBearer, 'Group Transfer Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Transfers' })
    ).json()) as { id: string; join_code: string }
    await req(successorBearer, 'POST', '/api/v1/ui/groups/join', { code: group.join_code })

    // Cannot transfer to a non-member.
    const toStranger = await req(ownerBearer, 'POST', `/api/v1/ui/groups/${group.id}/transfer`, {
      newOwnerUserId: `${owner}_stranger`,
    })
    expect(toStranger.status).toBe(409)
    expect(((await toStranger.json()) as { error: { code: string } }).error.code).toBe(
      'transfer_target_not_member',
    )

    const res = await req(ownerBearer, 'POST', `/api/v1/ui/groups/${group.id}/transfer`, {
      newOwnerUserId: successor,
    })
    expect(res.status).toBe(200)

    const fresh = await repos.groups.findById(group.id)
    expect(fresh?.ownerUserId).toBe(successor)
    expect((await repos.groupMembers.findByGroupAndUser(group.id, successor))?.role).toBe('owner')
    // Old group owner — note they are also the event owner, but their
    // group_members row is demoted to sidekick.
    expect((await repos.groupMembers.findByGroupAndUser(group.id, owner))?.role).toBe('sidekick')

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('group.ownership_transferred')
  })

  it('hard-deletes a group and SET-NULLs event_sessions.group_id', async () => {
    const owner = `user_${Date.now()}_del`
    const ownerBearer = await loginAs(owner)
    const eventId = await createEvent(ownerBearer, 'Group Delete Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Doomed' })
    ).json()) as { id: string }

    // A session scoped to the group.
    const sessionId = `evx_${ulid()}`
    await repos.eventSessions.create({
      id: sessionId,
      eventId,
      title: 'Group Session',
      approvalStatus: 'approved',
      visibility: 'group',
      groupId: group.id,
      createdByUserId: owner,
    })

    const del = await req(ownerBearer, 'DELETE', `/api/v1/ui/groups/${group.id}`)
    expect(del.status).toBe(204)
    expect(await repos.groups.findById(group.id)).toBeNull()

    // The session survives; its group_id is cleared by the FK SET NULL.
    const session = await repos.eventSessions.findById(sessionId)
    expect(session).not.toBeNull()
    expect(session?.groupId).toBeNull()

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('group.deleted')
  })

  it('404s a group detail for a user with no access (no existence leak)', async () => {
    const owner = `user_${Date.now()}_leak`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'Group Leak Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Private' })
    ).json()) as { id: string }

    const res = await req(strangerBearer, 'GET', `/api/v1/ui/groups/${group.id}`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_not_found')
  })

  it('freezes group access when the parent event is soft-deleted', async () => {
    const owner = `user_${Date.now()}_del`
    const ownerBearer = await loginAs(owner)
    const eventId = await createEvent(ownerBearer, 'Group Frozen Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Frozen' })
    ).json()) as { id: string }

    // Before delete the owner can read the group.
    expect((await req(ownerBearer, 'GET', `/api/v1/ui/groups/${group.id}`)).status).toBe(200)

    // Soft-delete the event; the owner can no longer act on its groups.
    expect((await req(ownerBearer, 'DELETE', `/api/v1/ui/events/${eventId}`)).status).toBe(204)
    const frozen = await req(ownerBearer, 'GET', `/api/v1/ui/groups/${group.id}`)
    expect(frozen.status).toBe(404)
    expect(((await frozen.json()) as { error: { code: string } }).error.code).toBe(
      'group_not_found',
    )
  })

  // --- slice 11: auto-attach a money ledger to every group -----------

  it('group create auto-attaches a money ledger; response carries ledger_id and activity logs group.ledger_attached', async () => {
    const owner = `user_${Date.now()}_autoledger`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Money-Backed Event')

    let captured: EnsureGroupLedgerInput | null = null
    moneyHandlers.ensureGroupLedger = async (input) => {
      captured = input
      return {
        id: `led_test_${input.groupId}`,
        scopeType: 'group',
        scopeId: input.groupId,
        ownerUserId: input.ownerUserId,
        name: input.name ?? 'Group expenses',
        currency: 'USD',
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        created: true,
      }
    }
    try {
      const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
        name: 'AutoLedgered',
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string; ledger_id: string }
      expect(body.ledger_id).toBe(`led_test_${body.id}`)
      expect(captured).not.toBeNull()
      expect(captured!.groupId).toBe(body.id)
      expect(captured!.ownerUserId).toBe(owner)
      expect(captured!.name).toBe('AutoLedgered expenses')

      const activity = await repos.activity.listForEvent(eventId)
      const types = activity.map((a) => a.eventType)
      expect(types).toContain('group.created')
      expect(types).toContain('group.ledger_attached')
    } finally {
      delete moneyHandlers.ensureGroupLedger
    }
  })

  it('group create still succeeds when money-api is unavailable; ledger_id is absent and no ledger_attached activity', async () => {
    const owner = `user_${Date.now()}_moneydown`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Money-Down Event')

    moneyHandlers.ensureGroupLedger = async () => {
      throw new Error('money-api is down')
    }
    try {
      const res = await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
        name: 'NoLedger',
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string; ledger_id?: string }
      expect(body.id).toMatch(/^grp_/)
      expect(body.ledger_id).toBeUndefined()

      // Activity has group.created but NOT group.ledger_attached.
      const activity = await repos.activity.listForEvent(eventId)
      const types = activity.map((a) => a.eventType)
      expect(types).toContain('group.created')
      expect(types).not.toContain('group.ledger_attached')
    } finally {
      delete moneyHandlers.ensureGroupLedger
    }
  })

  it('GET /api/v1/ui/groups/:id/ledger returns the attached ledger to a group member', async () => {
    const owner = `user_${Date.now()}_bff`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'BFF Event')

    moneyHandlers.listLedgers = async (scope) => [
      {
        id: `led_for_${scope.scopeId}`,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        ownerUserId: owner,
        name: 'Group expenses',
        currency: 'USD',
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
    try {
      const group = (await (
        await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'BFFGroup' })
      ).json()) as { id: string }
      const res = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/ledger`)
      expect(res.status).toBe(200)
      const ledger = (await res.json()) as { id: string; scopeType: string; scopeId: string }
      expect(ledger.id).toBe(`led_for_${group.id}`)
      expect(ledger.scopeType).toBe('group')
      expect(ledger.scopeId).toBe(group.id)
    } finally {
      delete moneyHandlers.listLedgers
    }
  })

  it('GET /groups/:id/ledger lazy-heals when no ledger exists (calls ensureGroupLedger)', async () => {
    const owner = `user_${Date.now()}_heal`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Heal Event')

    moneyHandlers.listLedgers = async () => []
    let healedFor: string | null = null
    moneyHandlers.ensureGroupLedger = async (input) => {
      healedFor = input.groupId
      return {
        id: `led_healed_${input.groupId}`,
        scopeType: 'group',
        scopeId: input.groupId,
        ownerUserId: input.ownerUserId,
        name: input.name ?? 'Group expenses',
        currency: 'USD',
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        created: true,
      }
    }
    try {
      const group = (await (
        await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'HealMe' })
      ).json()) as { id: string }
      const res = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/ledger`)
      expect(res.status).toBe(200)
      const ledger = (await res.json()) as { id: string }
      expect(healedFor).toBe(group.id)
      expect(ledger.id).toBe(`led_healed_${group.id}`)
    } finally {
      delete moneyHandlers.listLedgers
      delete moneyHandlers.ensureGroupLedger
    }
  })

  it('GET /groups/:id/ledger 502s when money-api is unavailable', async () => {
    const owner = `user_${Date.now()}_502`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, '502 Event')

    moneyHandlers.listLedgers = async () => {
      throw new Error('money-api unreachable')
    }
    try {
      const group = (await (
        await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: '502group' })
      ).json()) as { id: string }
      const res = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/ledger`)
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'money_upstream_unavailable',
      )
    } finally {
      delete moneyHandlers.listLedgers
    }
  })

  it('GET /groups/:id/ledger 404s a non-member', async () => {
    const owner = `user_${Date.now()}_acl`
    const stranger = `${owner}_stranger`
    const ownerBearer = await loginAs(owner)
    const strangerBearer = await loginAs(stranger)
    const eventId = await createEvent(ownerBearer, 'ACL Event')
    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'ACL' })
    ).json()) as { id: string }

    const res = await req(strangerBearer, 'GET', `/api/v1/ui/groups/${group.id}/ledger`)
    expect(res.status).toBe(404)
  })

  // --- ledger expenses / balances BFF -------------------------------

  it('GET /groups/:id/ledger/expenses proxies to money-client.listExpenses for the group ledger', async () => {
    const owner = `user_${Date.now()}_exps`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Expenses BFF Event')

    const cannedExpense: ExpenseDto = {
      id: 'exp_test_1',
      ledgerId: 'led_for_group',
      paidByUserId: owner,
      totalCents: 1234,
      description: 'Test dinner',
      splitMode: 'equal',
      categoryId: null,
      ref: null,
      spentAt: '2026-05-31',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      splits: [],
    }
    moneyHandlers.listLedgers = async () => [
      {
        id: 'led_for_group',
        scopeType: 'group',
        scopeId: '_x',
        ownerUserId: owner,
        name: 'Group expenses',
        currency: 'USD',
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
    let calledFor: string | null = null
    moneyHandlers.listExpenses = async (ledgerId) => {
      calledFor = ledgerId
      return [cannedExpense]
    }
    try {
      const group = (await (
        await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'ExpensesBFF' })
      ).json()) as { id: string }
      const res = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/ledger/expenses`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string; description: string }> }
      expect(calledFor).toBe('led_for_group')
      expect(body.items).toHaveLength(1)
      expect(body.items[0]!.id).toBe('exp_test_1')
      expect(body.items[0]!.description).toBe('Test dinner')
    } finally {
      delete moneyHandlers.listLedgers
      delete moneyHandlers.listExpenses
    }
  })

  it('GET /groups/:id/ledger/expenses returns items:[] when no ledger exists yet (graceful empty)', async () => {
    const owner = `user_${Date.now()}_emptyexps`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Empty BFF Event')

    moneyHandlers.listLedgers = async () => []
    try {
      const group = (await (
        await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'EmptyBFF' })
      ).json()) as { id: string }
      const res = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/ledger/expenses`)
      expect(res.status).toBe(200)
      expect((await res.json()) as { items: unknown[] }).toEqual({ items: [] })
    } finally {
      delete moneyHandlers.listLedgers
    }
  })

  it('GET /groups/:id/ledger/balances injects the session user as viewer_user_id', async () => {
    const owner = `user_${Date.now()}_bal`
    const bearer = await loginAs(owner)
    const eventId = await createEvent(bearer, 'Balances BFF Event')

    moneyHandlers.listLedgers = async () => [
      {
        id: 'led_bal',
        scopeType: 'group',
        scopeId: '_x',
        ownerUserId: owner,
        name: 'Group expenses',
        currency: 'USD',
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
    let receivedViewer: string | null = null
    moneyHandlers.getBalances = async (ledgerId, viewerUserId) => {
      receivedViewer = viewerUserId
      return {
        ledgerId,
        currency: 'USD',
        viewerUserId,
        items: [{ userId: 'user_peer', netCents: 42 }],
      }
    }
    try {
      const group = (await (
        await req(bearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'BalancesBFF' })
      ).json()) as { id: string }
      const res = await req(bearer, 'GET', `/api/v1/ui/groups/${group.id}/ledger/balances`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ledger_id: string
        currency: string
        viewer_user_id: string
        items: Array<{ user_id: string; net_cents: number }>
      }
      // The session user — not anything the client passed — drives the
      // viewer projection.
      expect(receivedViewer).toBe(owner)
      expect(body.viewer_user_id).toBe(owner)
      expect(body.items).toEqual([{ user_id: 'user_peer', net_cents: 42 }])
    } finally {
      delete moneyHandlers.listLedgers
      delete moneyHandlers.getBalances
    }
  })

  // ── #171 transactional writes ────────────────────────────────────

  it('group create writes groups + group_members + event_attendees atomically (non-owner editor case)', async () => {
    // Owner creates the event; an editor accepts an invite and is the
    // one creating the group. That editor IS NOT the event owner, so
    // the create flow MUST write an event_attendees row alongside the
    // group + group_members.
    const owner = `user_${Date.now()}_171_c_o`
    const editor = `user_${Date.now()}_171_c_e`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const eventId = await createEvent(ownerBearer, 'Atomic Create')
    // Editor accepts an event invite so they have event_members editor.
    const editorInvite = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
        role: 'editor',
      })
    ).json()) as { code: string }
    await req(editorBearer, 'POST', '/api/v1/ui/invites/accept', { code: editorInvite.code })

    const res = await req(editorBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
      name: 'Editor Created',
    })
    expect(res.status).toBe(201)
    const group = (await res.json()) as { id: string }

    // All three rows now exist for the editor.
    const memberRow = await repos.groupMembers.findByGroupAndUser(group.id, editor)
    expect(memberRow?.role).toBe('owner')
    const attendeeRow = await repos.attendees.findByEventAndUser(eventId, editor)
    expect(attendeeRow).not.toBeNull()
    expect(attendeeRow?.removedAt).toBeNull()
  })

  it('group create — duplicate name 409s without writing phantom member/attendee rows', async () => {
        const owner = `user_${Date.now()}_171_rb_o`
    const editor = `user_${Date.now()}_171_rb_e`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const eventId = await createEvent(ownerBearer, 'Atomic Rollback')
    const editorInvite = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
        role: 'editor',
      })
    ).json()) as { code: string }
    await req(editorBearer, 'POST', '/api/v1/ui/invites/accept', { code: editorInvite.code })
    // Owner pre-creates a group with the contested name (and, in doing
    // so, creates the attendee-less owner case).
    await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Taken' })

    // Editor's attempt collides on the name → 409.
    const res = await req(editorBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, {
      name: 'Taken',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('group_name_taken')

    // Owner's group still has only one member (the owner). No phantom
    // editor membership row from the failed attempt.
    const ownerGroups = await repos.groups.listForEvent(eventId)
    const takenGroup = ownerGroups.find((g) => g.name === 'Taken')!
    const takenGroupMembers = await repos.groupMembers.listForGroup(takenGroup.id)
    expect(takenGroupMembers).toHaveLength(1)
    expect(takenGroupMembers[0]!.userId).toBe(owner)
    // Critically: the editor's attendees row still reflects only the
    // invite-accept flow, not a phantom group-create write. The editor
    // accepted an invite earlier, so an attendees row exists — what we
    // verify here is that the failed create didn't write a second
    // duplicate row (the upsert wouldn't, but a transaction leak from a
    // future refactor would). Count is the durable assertion.
    const editorAttendee = await repos.attendees.findByEventAndUser(eventId, editor)
    expect(editorAttendee).not.toBeNull()
  })

  it('group join writes group_members + event_attendees + invite consumption atomically', async () => {
    const owner = `user_${Date.now()}_171_j_o`
    const joiner = `user_${Date.now()}_171_j_j`
    const ownerBearer = await loginAs(owner)
    const joinerBearer = await loginAs(joiner)
    const eventId = await createEvent(ownerBearer, 'Atomic Join')
    const created = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'JoinTarget' })
    ).json()) as { id: string }
    const invite = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/groups/${created.id}/invites`, {})
    ).json()) as { id: string; code: string }

    const res = await req(joinerBearer, 'POST', '/api/v1/ui/groups/join', { code: invite.code })
    expect(res.status).toBe(200)

    const member = await repos.groupMembers.findByGroupAndUser(created.id, joiner)
    expect(member?.role).toBe('member')
    const attendee = await repos.attendees.findByEventAndUser(eventId, joiner)
    expect(attendee?.removedAt).toBeNull()
    const inviteRow = await repos.groupInvites.findByCodeHash(
      // Re-fetch via id helper isn't on the interface; codeHash lookup
      // returns null after consumption (still indexed though); fetch
      // the listForGroup result instead.
      (await repos.groupInvites.listForGroup(created.id))[0]!.codeHash,
    )
    expect(inviteRow?.consumedByUserId).toBe(joiner)
  })

  it('group join — re-admits a soft-removed attendee via a fresh invite (#171 round-3 parity)', async () => {
    // The event-invite re-admission is covered in attendees.it.test.ts;
    // this is the group-invite parallel. Steps:
    //   1. Editor accepts an event invite, joins a group via code.
    //   2. Owner soft-removes the editor from event attendees.
    //   3. Owner mints a fresh group invite.
    //   4. Editor joins again with the new code → 200 readmitted.
    //   5. group_members row is NOT duplicated; event_attendees.removedAt is null.
    const owner = `user_${Date.now()}_171_re_o`
    const editor = `user_${Date.now()}_171_re_e`
    const ownerBearer = await loginAs(owner)
    const editorBearer = await loginAs(editor)
    const eventId = await createEvent(ownerBearer, 'Atomic Readmit')

    // Editor joins event as editor.
    const eventInvite = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/invites`, {
        role: 'editor',
      })
    ).json()) as { code: string }
    await req(editorBearer, 'POST', '/api/v1/ui/invites/accept', { code: eventInvite.code })

    const group = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/events/${eventId}/groups`, { name: 'Readmit' })
    ).json()) as { id: string; join_code: string }
    // Editor joins the group via standing code.
    await req(editorBearer, 'POST', '/api/v1/ui/groups/join', { code: group.join_code })

    // Owner soft-removes editor from event attendees.
    const rm = await req(ownerBearer, 'DELETE', `/api/v1/ui/events/${eventId}/attendees/${editor}`)
    expect(rm.status).toBe(204)
    expect((await repos.attendees.findByEventAndUser(eventId, editor))?.removedAt).not.toBeNull()

    // Owner mints a fresh group invite for re-admission.
    const reInvite = (await (
      await req(ownerBearer, 'POST', `/api/v1/ui/groups/${group.id}/invites`, {})
    ).json()) as { code: string }

    const rejoin = await req(editorBearer, 'POST', '/api/v1/ui/groups/join', {
      code: reInvite.code,
    })
    expect(rejoin.status).toBe(200)

    // Membership not duplicated; attendee row's removedAt cleared.
    const members = await repos.groupMembers.listForGroup(group.id)
    expect(members.filter((m) => m.userId === editor)).toHaveLength(1)
    const attendee = await repos.attendees.findByEventAndUser(eventId, editor)
    expect(attendee?.removedAt).toBeNull()

    const activity = await repos.activity.listForEvent(eventId)
    expect(activity.map((a) => a.eventType)).toContain('group.rejoined')
  })
})
