import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Hono } from 'hono'
import { parseEnv, type Env } from '../env.js'
import { buildApp } from '../build-app.js'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { HonoApp } from '../context.js'
import type { Repos } from '../repos/types.js'
import type { Services } from '../services/types.js'
import { generateRawToken, hashToken } from '@rallypoint/crypto'
import { encryptBearer } from '../crypto/encryption.js'
import { MONEY_SESSION_BEARER_PREFIX } from '../middleware/session.js'

// D1 integration tests for the ledger-invites surface.
// Replaces ledger-invites.it.test.ts.

const CSRF = 'csrf_token_value_aaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('D1 integration — ledger invites', () => {
  let repos: Repos
  let envVars: Env
  let app: Hono<HonoApp>

  const services: Services = {
    idClient: {
      verifyRpidBearer: async (bearer: string) => ({ ok: true as const, userId: bearer }),
      signoutRpidBearer: async () => {},
    },
    rpidSso: {
      exchange: async () => ({ ok: false as const, reason: 'invalid' as const }),
    },
    settings: {
      get: async () => ({}),
      patch: async (_u, _n, p) => p,
    },
  }

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    app = buildApp({ env: envVars, logger: undefined, repos, services })
  })

  async function loginAs(userId: string): Promise<string> {
    const rawBearer = generateRawToken(MONEY_SESSION_BEARER_PREFIX)
    const idHash = hashToken(rawBearer)
    const sealed = encryptBearer({
      plaintext: userId,
      aad: idHash,
      env: { MONEY_SESSION_KEY_V1: envVars.MONEY_SESSION_KEY_V1 },
      keyVersion: envVars.MONEY_SESSION_KEY_VERSION,
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
      cookie: `${envVars.MONEY_SESSION_COOKIE_NAME}=${bearer}; ${envVars.MONEY_CSRF_COOKIE_NAME}=${CSRF}`,
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

  async function createLedger(bearer: string, owner: string): Promise<string> {
    const created = await (await req(bearer, 'POST', '/api/v1/ui/ledgers', {
      name: 'Invite test',
      currency: 'USD',
      scopeType: 'personal',
      scopeId: owner,
    })).json() as { id: string }
    return created.id
  }

  it('mints an invite (owner only), then a stranger accepts it and joins', async () => {
    const owner = `user_${Date.now()}_inv_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    const mintRes = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/invites`, {
      invitedEmail: 'peer@example.com',
    })
    expect(mintRes.status).toBe(201)
    const minted = (await mintRes.json()) as { id: string; code: string; expires_at: string }
    expect(minted.code).toMatch(/^rpm_inv_/)
    expect(new Date(minted.expires_at).getTime()).toBeGreaterThan(Date.now())

    // Peer joins.
    const peer = `user_${Date.now()}_inv_peer`
    const peerBearer = await loginAs(peer)
    const joinRes = await req(peerBearer, 'POST', '/api/v1/ui/ledgers/join', { code: minted.code })
    expect(joinRes.status).toBe(200)
    const joined = (await joinRes.json()) as { ledger_id: string; role: string; already_member: boolean }
    expect(joined.ledger_id).toBe(ledgerId)
    expect(joined.role).toBe('member')
    expect(joined.already_member).toBe(false)

    // Peer now appears in the members list and the ledger shows up in
    // their /api/v1/ui/ledgers as a viewer_role='member' row.
    const members = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/members`)).json()) as { items: Array<{ user_id: string }> }
    expect(members.items.find((m) => m.user_id === peer)).toBeDefined()

    const peerList = (await (await req(peerBearer, 'GET', '/api/v1/ui/ledgers')).json()) as { items: Array<{ id: string; viewer_role: string }> }
    expect(peerList.items.find((l) => l.id === ledgerId)?.viewer_role).toBe('member')

    // Replay attempt: the invite is now consumed.
    const replay = await req(peerBearer, 'POST', '/api/v1/ui/ledgers/join', { code: minted.code })
    expect(replay.status).toBe(409)
    const replayErr = (await replay.json()) as { error: { code: string } }
    expect(replayErr.error.code).toBe('ledger_invite_already_consumed')
  })

  it('rejects an unknown invite code as ledger_invite_code_invalid', async () => {
    const peer = `user_${Date.now()}_unknown`
    const peerBearer = await loginAs(peer)
    const res = await req(peerBearer, 'POST', '/api/v1/ui/ledgers/join', {
      code: 'rpm_inv_zzzzzzzzzzzzzzzzzzzz',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('ledger_invite_code_invalid')
  })

  it('rejects an expired invite as ledger_invite_expired', async () => {
    const owner = `user_${Date.now()}_exp_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    // Inject an invite row directly with expiry in the past.
    const rawCode = 'rpm_inv_' + 'a'.repeat(40)
    await repos.ledgerInvites.create({
      id: `lin_${Date.now()}`,
      ledgerId,
      codeHash: hashToken(rawCode),
      invitedByUserId: owner,
      role: 'member',
      expiresAt: new Date(Date.now() - 60_000),
    })

    const peer = `user_${Date.now()}_exp_peer`
    const peerBearer = await loginAs(peer)
    const res = await req(peerBearer, 'POST', '/api/v1/ui/ledgers/join', { code: rawCode })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ledger_invite_expired')
  })

  it('lists active invites for the owner', async () => {
    const owner = `user_${Date.now()}_list_inv`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/invites`, {})
    await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/invites`, {
      invitedEmail: 'two@example.com',
    })

    const listRes = await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/invites`)
    expect(listRes.status).toBe(200)
    const page = (await listRes.json()) as { items: Array<{ id: string; invited_email: string | null }> }
    expect(page.items).toHaveLength(2)
    // The raw code is NOT in the listing.
    expect(JSON.stringify(page.items)).not.toContain('rpm_inv_')
  })

  it('rejects mint by a non-owner with 404 (don\'t leak existence)', async () => {
    const owner = `user_${Date.now()}_inv_x_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    const stranger = `user_${Date.now()}_inv_x_stranger`
    const strangerBearer = await loginAs(stranger)
    const res = await req(strangerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/invites`, {})
    expect(res.status).toBe(404)
  })

  it('owner cannot leave but a regular member can', async () => {
    const owner = `user_${Date.now()}_leave_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    const peer = `user_${Date.now()}_leave_peer`
    const peerBearer = await loginAs(peer)
    const minted = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/invites`, {})).json()) as { code: string }
    await req(peerBearer, 'POST', '/api/v1/ui/ledgers/join', { code: minted.code })

    // Owner can't leave their own ledger.
    const ownerLeave = await req(ownerBearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/members/me`)
    expect(ownerLeave.status).toBe(409)
    expect(((await ownerLeave.json()) as { error: { code: string } }).error.code).toBe('owner_cannot_leave')

    // Peer can.
    const peerLeave = await req(peerBearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/members/me`)
    expect(peerLeave.status).toBe(204)
    const members = (await (await req(ownerBearer, 'GET', `/api/v1/ui/ledgers/${ledgerId}/members`)).json()) as { items: unknown[] }
    expect(members.items).toHaveLength(0)
  })

  it('owner kicks a member; cannot kick themselves', async () => {
    const owner = `user_${Date.now()}_kick_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    const peer = `user_${Date.now()}_kick_peer`
    const peerBearer = await loginAs(peer)
    const minted = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/invites`, {})).json()) as { code: string }
    await req(peerBearer, 'POST', '/api/v1/ui/ledgers/join', { code: minted.code })

    // Owner kicks peer.
    const kick = await req(ownerBearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/members/${peer}`)
    expect(kick.status).toBe(204)

    // Owner cannot kick themselves.
    const selfKick = await req(ownerBearer, 'DELETE', `/api/v1/ui/ledgers/${ledgerId}/members/${owner}`)
    expect(selfKick.status).toBe(409)
    expect(((await selfKick.json()) as { error: { code: string } }).error.code).toBe('cannot_remove_owner')
  })

  it('transfers ownership; old owner becomes a member, new owner becomes canonical', async () => {
    const owner = `user_${Date.now()}_xfer_owner`
    const ownerBearer = await loginAs(owner)
    const ledgerId = await createLedger(ownerBearer, owner)

    const peer = `user_${Date.now()}_xfer_peer`
    const peerBearer = await loginAs(peer)
    const minted = (await (await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/invites`, {})).json()) as { code: string }
    await req(peerBearer, 'POST', '/api/v1/ui/ledgers/join', { code: minted.code })

    const xfer = await req(ownerBearer, 'POST', `/api/v1/ui/ledgers/${ledgerId}/transfer`, {
      newOwnerUserId: peer,
    })
    expect(xfer.status).toBe(200)

    const led = await repos.ledgers.findById(ledgerId)
    expect(led!.ownerUserId).toBe(peer)

    // The previous owner is now a member.
    const oldOwnerMembership = await repos.ledgerMembers.findByLedgerAndUser(ledgerId, owner)
    expect(oldOwnerMembership).not.toBeNull()
    expect(oldOwnerMembership!.role).toBe('member')

    // The new owner no longer has a separate member row (was removed
    // before being promoted to canonical owner).
    const newOwnerMembership = await repos.ledgerMembers.findByLedgerAndUser(ledgerId, peer)
    expect(newOwnerMembership).toBeNull()
  })
})
