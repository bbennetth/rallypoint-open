import { env } from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Logger } from '@rallypoint/logger'
import { buildD1Repos, createDb } from '../repos/d1/index.js'
import type { Env } from '../env.js'
import { createListCore, createSeriesCore, type ListsRpcDeps } from './rpc-core.js'

// D1 (Miniflare/workerd) coverage for createSeriesCore's ref idempotency.
// The memory-repo test (rpc-core-series-ref.test.ts) covers the decision
// logic; this one drives the REAL D1 series repo whose create wraps a
// `db.batch([...])` (series row + occurrence inserts) in the try/catch that
// maps a unique-index violation to UniqueConstraintError — the exact
// error-propagation path the memory backend can't exercise.

const noopLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

const seriesInput = {
  title: 'Water the plants',
  freq: 'weekly' as const,
  interval: 1,
  dtstart: '2026-06-01',
}

describe('D1 integration — createSeriesCore ref idempotency', () => {
  let deps: ListsRpcDeps

  beforeAll(() => {
    deps = { env: {} as Env, logger: noopLogger, repos: buildD1Repos(createDb(env.DB)) }
  })

  async function makeList(actor: string): Promise<string> {
    const created = await createListCore(
      actor,
      {
        scopeType: 'group',
        scopeId: `grp_${actor}`,
        listType: 'tasks',
        name: 'Series ref D1',
        visibility: 'all',
      },
      deps,
    )
    if (created.kind !== 'ok') throw new Error(`createListCore: ${created.kind}`)
    return created.data.id
  }

  it('replay with the same (list_id, ref) returns the existing series, not a duplicate', async () => {
    const actor = 'user_series_d1_replay'
    const listId = await makeList(actor)

    const first = await createSeriesCore(actor, listId, { ...seriesInput, ref: 'chore:d1' }, deps)
    expect(first.kind).toBe('ok')
    const firstId = first.kind === 'ok' ? first.data.id : ''

    const replay = await createSeriesCore(
      actor,
      listId,
      { ...seriesInput, title: 'Different title', ref: 'chore:d1' },
      deps,
    )
    expect(replay.kind).toBe('ok')
    if (replay.kind === 'ok') expect(replay.data.id).toBe(firstId)

    expect(await deps.repos.series.list(listId)).toHaveLength(1)
  })

  it('concurrent same-ref creates race past the preflight and converge on one row', async () => {
    const actor = 'user_series_d1_race'
    const listId = await makeList(actor)

    const [a, b] = await Promise.all([
      createSeriesCore(actor, listId, { ...seriesInput, ref: 'race' }, deps),
      createSeriesCore(actor, listId, { ...seriesInput, ref: 'race' }, deps),
    ])

    expect(a.kind).toBe('ok')
    expect(b.kind).toBe('ok')
    if (a.kind === 'ok' && b.kind === 'ok') expect(a.data.id).toBe(b.data.id)
    expect(await deps.repos.series.list(listId)).toHaveLength(1)
  })
})
