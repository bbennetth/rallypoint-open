import { describe, it, expect } from 'vitest'
import type { Logger } from '@rallypoint/logger'
import { buildMemoryRepos } from '../repos/memory.js'
import type { Env } from '../env.js'
import {
  createListCore,
  createSeriesCore,
  deleteSeriesCore,
  type ListsRpcDeps,
} from './rpc-core.js'

// Memory-repo (node pool, no D1/Miniflare needed) coverage for the
// createSeriesCore ref-idempotency path — the series-create analogue of
// apps/lists-api/src/routes/list-items-ref-idempotency.d1.test.ts. Series
// have no dedicated lists-api HTTP route (creation is RPC-only, consumed
// by planner-api — see rpc.ts), so this drives createSeriesCore directly
// against an in-memory Repos bag instead of a route-level D1 test.

const noopLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

function makeDeps(): ListsRpcDeps {
  return { env: {} as Env, logger: noopLogger, repos: buildMemoryRepos() }
}

async function makeList(deps: ListsRpcDeps, actor: string): Promise<string> {
  // scopeType 'group' is an Events-owned scope, opaque + trusted (no
  // list_group membership row needed), so this needs no extra setup.
  const created = await createListCore(
    actor,
    {
      scopeType: 'group',
      scopeId: `grp_${Math.random().toString(36).slice(2)}`,
      listType: 'tasks',
      name: 'Series ref test',
      visibility: 'all',
    },
    deps,
  )
  if (created.kind !== 'ok') throw new Error(`unexpected createListCore result: ${created.kind}`)
  return created.data.id
}

describe('createSeriesCore — ref idempotency', () => {
  const actor = 'user_series_ref_test'
  const seriesInput = {
    title: 'Water the plants',
    freq: 'weekly' as const,
    interval: 1,
    dtstart: '2026-06-01',
  }

  it('replay with the same (list_id, ref) returns the existing series, not a duplicate', async () => {
    const deps = makeDeps()
    const listId = await makeList(deps, actor)

    const first = await createSeriesCore(actor, listId, { ...seriesInput, ref: 'chore:42' }, deps)
    expect(first.kind).toBe('ok')
    const firstId = first.kind === 'ok' ? first.data.id : ''

    const replay = await createSeriesCore(
      actor,
      listId,
      { ...seriesInput, title: 'Different title', ref: 'chore:42' },
      deps,
    )
    expect(replay.kind).toBe('ok')
    if (replay.kind === 'ok') {
      expect(replay.data.id).toBe(firstId)
      // The original title wins — ref pins the first writer.
      expect(replay.data.title).toBe('Water the plants')
    }

    const all = await deps.repos.series.list(listId)
    expect(all).toHaveLength(1)
  })

  it('different refs create distinct series', async () => {
    const deps = makeDeps()
    const listId = await makeList(deps, actor)

    await createSeriesCore(actor, listId, { ...seriesInput, ref: 'a' }, deps)
    await createSeriesCore(actor, listId, { ...seriesInput, ref: 'b' }, deps)

    expect(await deps.repos.series.list(listId)).toHaveLength(2)
  })

  it('series without a ref are unconstrained — duplicates allowed', async () => {
    const deps = makeDeps()
    const listId = await makeList(deps, actor)

    await createSeriesCore(actor, listId, seriesInput, deps)
    await createSeriesCore(actor, listId, seriesInput, deps)

    expect(await deps.repos.series.list(listId)).toHaveLength(2)
  })

  it('after soft-delete, the ref is reserved — a replay throws series_ref_taken_by_deleted', async () => {
    const deps = makeDeps()
    const listId = await makeList(deps, actor)

    const created = await createSeriesCore(actor, listId, { ...seriesInput, ref: 'doomed' }, deps)
    expect(created.kind).toBe('ok')
    const seriesId = created.kind === 'ok' ? created.data.id : ''

    const deleted = await deleteSeriesCore(actor, seriesId, deps)
    expect(deleted.kind).toBe('ok')

    await expect(
      createSeriesCore(actor, listId, { ...seriesInput, ref: 'doomed' }, deps),
    ).rejects.toMatchObject({
      code: 'series_ref_taken_by_deleted',
      status: 409,
      details: { ref: 'doomed', series_id: seriesId },
    })
  })
})
