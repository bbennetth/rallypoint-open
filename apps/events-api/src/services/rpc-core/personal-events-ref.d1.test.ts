import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import { ulid } from 'ulid'
import { noopRealtimeBus } from '@rallypoint/realtime'
import { buildD1Repos, createDb } from '../../repos/d1/index.js'
import { parseEnv, type Env } from '../../env.js'
import type { Repos } from '../../repos/types.js'
import type { Logger } from '../../logger.js'
import type { Services } from '../types.js'
import {
  makeNoopMoneyClient,
  makeNoopListsClient,
  makeStubObjectStore,
} from '../../routes/_test-services.js'
import { createPersonalEventCore } from './personal-events-core.js'
import type { EventsRpcDeps } from './deps.js'

// Integration tests for the personal-event offline-create idempotency key
// (repo-wide "offline create retries must be idempotent" fix; mirrors
// money-api's expense/settlement `ref` — apps/money-api/src/routes/expenses.ts).
// An offline client carries a stable `tmp_<uuid>` across retries and sends
// it as `ref`; a create that times out AFTER commit but retries should find
// the original row via (owner_user_id, ref) rather than duplicating it.
// Covers:
//   - same ref twice → one row, second call returns the first's id
//   - different ref → two distinct rows
//   - no ref → duplicates allowed (historical, un-keyed behavior)
//   - concurrent same-ref creates race past the pre-flight and converge on
//     one row via the UniqueConstraintError catch + re-find fallback

const logger = { info() {}, warn() {}, error() {} } as unknown as Logger

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
    patch: async (_u: string, _n: string, patch: Record<string, unknown>) => patch,
  },
}

describe('D1 integration — personal-event idempotent create (ref dedup)', () => {
  let repos: Repos
  let envVars: Env
  let deps: EventsRpcDeps

  beforeAll(() => {
    repos = buildD1Repos(createDb(env.DB))
    envVars = parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' })
    deps = { env: envVars, logger, repos, services, realtime: noopRealtimeBus() }
  })

  async function countRows(ownerUserId: string, ref: string): Promise<number> {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM events WHERE owner_user_id = ? AND ref = ?',
    )
      .bind(ownerUserId, ref)
      .first<{ c: number }>()
    return row?.c ?? 0
  }

  it('same ref twice returns the same row instead of inserting a duplicate', async () => {
    const actor = `user_${ulid()}`
    const ref = `tmp_${ulid()}`

    const first = await createPersonalEventCore(actor, { name: 'Morning run', ref }, deps)
    const second = await createPersonalEventCore(
      actor,
      { name: 'Morning run (retried)', ref },
      deps,
    )

    expect(second.id).toBe(first.id)
    // The retry's differing name must NOT have overwritten the original —
    // the preflight hit returns the existing row verbatim, no update.
    expect(second.name).toBe('Morning run')
    expect(await countRows(actor, ref)).toBe(1)
  })

  it('a different ref creates a distinct row', async () => {
    const actor = `user_${ulid()}`
    const refA = `tmp_${ulid()}`
    const refB = `tmp_${ulid()}`

    const first = await createPersonalEventCore(actor, { name: 'Event A', ref: refA }, deps)
    const second = await createPersonalEventCore(actor, { name: 'Event B', ref: refB }, deps)

    expect(second.id).not.toBe(first.id)
    expect(await countRows(actor, refA)).toBe(1)
    expect(await countRows(actor, refB)).toBe(1)
  })

  it('omitting ref allows duplicates (historical, un-keyed behavior)', async () => {
    const actor = `user_${ulid()}`

    const first = await createPersonalEventCore(actor, { name: 'Untracked event' }, deps)
    const second = await createPersonalEventCore(actor, { name: 'Untracked event' }, deps)

    expect(second.id).not.toBe(first.id)
  })

  it('two different owners may use the same ref independently', async () => {
    const ownerA = `user_${ulid()}`
    const ownerB = `user_${ulid()}`
    const ref = `tmp_${ulid()}`

    const a = await createPersonalEventCore(ownerA, { name: 'Owner A event', ref }, deps)
    const b = await createPersonalEventCore(ownerB, { name: 'Owner B event', ref }, deps)

    expect(a.id).not.toBe(b.id)
    expect(a.ownerUserId).toBe(ownerA)
    expect(b.ownerUserId).toBe(ownerB)
  })

  it('a ref matching a soft-deleted event 409s instead of resurrecting the tombstone', async () => {
    const actor = `user_${ulid()}`
    const ref = `tmp_${ulid()}`

    const created = await createPersonalEventCore(actor, { name: 'To be deleted', ref }, deps)
    await repos.events.softDelete(created.id, new Date())

    // The retry's ref now matches a tombstoned row; findByOwnerAndRef spans
    // soft-deleted rows, so the core must 409 rather than return the stale
    // event as a fake success (which would also re-arm a deleted event's
    // planner notification).
    await expect(
      createPersonalEventCore(actor, { name: 'Retry after delete', ref }, deps),
    ).rejects.toMatchObject({ code: 'event_ref_taken_by_deleted', status: 409 })
  })

  it('concurrent creates with the same ref race past the preflight and still converge on one row', async () => {
    const actor = `user_${ulid()}`
    const ref = `tmp_${ulid()}`

    const [a, b] = await Promise.all([
      createPersonalEventCore(actor, { name: 'Race A', ref }, deps),
      createPersonalEventCore(actor, { name: 'Race B', ref }, deps),
    ])

    expect(a.id).toBe(b.id)
    expect(await countRows(actor, ref)).toBe(1)
  })
})
