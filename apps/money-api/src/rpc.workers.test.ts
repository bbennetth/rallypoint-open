import { env, createExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { MoneyRPC } from './rpc.js'
import { buildD1Repos, createDb } from './repos/d1/index.js'

// Cross-Worker RPC contract tests for MoneyRPC (feat/rpc-bindings PR 1).
// Drives the WorkerEntrypoint directly against real D1 to cover the
// happy + key negative branches of each method. The HTTP integration
// suite under routes/*.d1.test.ts continues to exercise the legacy
// surface that calls the same *Core fns.

const repos = buildD1Repos(createDb(env.DB))
const TENANT = 'rallypoint'

async function clearAll(): Promise<void> {
  for (const t of [
    'ledger_activity',
    'expense_splits',
    'expenses',
    'settlements',
    'ledger_members',
    'ledger_invites',
    'ledgers',
    'ledger_groups',
    'rate_limits',
    'sessions',
  ]) {
    try {
      await env.DB.exec(`DELETE FROM ${t}`)
    } catch {
      // tolerate tables that may not exist in this schema slice
    }
  }
}
beforeEach(clearAll)

function rpc(): MoneyRPC {
  return new MoneyRPC(createExecutionContext(), env as never)
}

async function makeLedger(
  ownerUserId: string,
  scopeType: 'personal' | 'group' = 'personal',
  scopeId?: string,
): Promise<string> {
  const ledger = await repos.ledgers.create({
    id: `led_${Math.random().toString(36).slice(2, 12)}`,
    tenantId: TENANT,
    scopeType,
    scopeId: scopeId ?? ownerUserId,
    ownerUserId,
    name: 'Test ledger',
    currency: 'USD',
    description: null,
  })
  return ledger.id
}

describe('MoneyRPC.listLedgers', () => {
  it('returns non-deleted ledgers in the scope', async () => {
    await makeLedger('user_alice', 'personal', 'user_alice')
    await makeLedger('user_alice', 'personal', 'user_alice')
    await makeLedger('user_bob', 'personal', 'user_bob')

    const out = await rpc().listLedgers('personal', 'user_alice')
    expect(out.length).toBe(2)
    expect(out.every((l) => l.scopeId === 'user_alice')).toBe(true)
  })

  it('returns an empty array for an unknown scope', async () => {
    const out = await rpc().listLedgers('personal', 'user_ghost')
    expect(out).toEqual([])
  })
})

describe('MoneyRPC.ensureGroupLedger', () => {
  it('creates a new ledger and reports created:true', async () => {
    const result = await rpc().ensureGroupLedger({
      scopeId: 'grp_one',
      ownerUserId: 'user_carl',
    })
    expect(result.created).toBe(true)
    expect(result.scopeType).toBe('group')
    expect(result.scopeId).toBe('grp_one')
    expect(result.ownerUserId).toBe('user_carl')
    expect(result.currency).toBe('USD')
  })

  it('returns the existing ledger with created:false when one already exists', async () => {
    const first = await rpc().ensureGroupLedger({
      scopeId: 'grp_two',
      ownerUserId: 'user_dee',
      name: 'Custom name',
    })
    const second = await rpc().ensureGroupLedger({
      scopeId: 'grp_two',
      ownerUserId: 'user_eve',
    })
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
    expect(second.name).toBe('Custom name')
  })
})

describe('MoneyRPC.listExpenses', () => {
  it('returns not_found when the ledger does not exist', async () => {
    const out = await rpc().listExpenses('led_ghost', 'user_alice')
    expect(out).toEqual({ kind: 'not_found' })
  })

  it('returns ok with [] for the owner when no expenses are recorded', async () => {
    const ledgerId = await makeLedger('user_fay')
    const out = await rpc().listExpenses(ledgerId, 'user_fay')
    expect(out).toEqual({ kind: 'ok', data: [] })
  })

  it('returns not_found when the viewer is not a member', async () => {
    const ledgerId = await makeLedger('user_gus')
    const out = await rpc().listExpenses(ledgerId, 'user_outsider')
    expect(out).toEqual({ kind: 'not_found' })
  })
})

describe('MoneyRPC.getBalances', () => {
  it('returns not_found when the ledger does not exist', async () => {
    const out = await rpc().getBalances('led_ghost', 'user_alice')
    expect(out).toEqual({ kind: 'not_found' })
  })

  it('returns an empty items array for the owner of a new ledger', async () => {
    const ledgerId = await makeLedger('user_hal')
    const out = await rpc().getBalances(ledgerId, 'user_hal')
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') {
      expect(out.data.ledgerId).toBe(ledgerId)
      expect(out.data.viewerUserId).toBe('user_hal')
      expect(out.data.items).toEqual([])
    }
  })

  it('returns not_found when the viewer is not a member (anti-enumeration)', async () => {
    const ledgerId = await makeLedger('user_ivy')
    const out = await rpc().getBalances(ledgerId, 'user_outsider')
    expect(out).toEqual({ kind: 'not_found' })
  })
})
