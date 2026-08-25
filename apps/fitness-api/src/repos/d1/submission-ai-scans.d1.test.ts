import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { UniqueConstraintError } from '@rallypoint/api-kit'
import { buildD1Repos, createDb } from './index.js'
import type { Repos } from '../types.js'

// Real workerd + Miniflare D1 (run: `npm run test:d1:fitness`). Exercises
// the submission_ai_scans table (migration 0033) — state machine,
// pending-unique race, latest-per-subject lookups — plus the two
// duplicate-shortlist candidate queries against the real schema.

describe('D1 submission_ai_scans repo', () => {
  let repos: Repos
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM submission_ai_scans')
    repos = buildD1Repos(createDb(env.DB))
  })

  it('creates pending, completes with verdict + findings, and reads back', async () => {
    const created = await repos.submissionAiScans.create({
      id: 'fscan_1',
      subjectType: 'exercise',
      subjectId: 'fsub_1',
      model: 'test-model',
    })
    expect(created.status).toBe('pending')
    expect(created.verdict).toBeNull()

    const done = await repos.submissionAiScans.complete('fscan_1', {
      verdict: 'warn',
      findings: [{ dimension: 'quality', severity: 'warn', message: 'Check macros.' }],
    })
    expect(done?.status).toBe('done')
    expect(done?.verdict).toBe('warn')
    expect(done?.findings).toEqual([
      { dimension: 'quality', severity: 'warn', message: 'Check macros.' },
    ])
    expect(done?.completedAt).not.toBeNull()
  })

  it('fails a pending row with a truncated error', async () => {
    await repos.submissionAiScans.create({
      id: 'fscan_1',
      subjectType: 'food',
      subjectId: 'fdsub_1',
      model: 'm',
    })
    const failed = await repos.submissionAiScans.fail('fscan_1', 'x'.repeat(600))
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toHaveLength(500)
    // complete() on a non-pending row is a guarded no-op.
    expect(
      await repos.submissionAiScans.complete('fscan_1', { verdict: 'ok', findings: [] }),
    ).toBeNull()
  })

  it('enforces one pending scan per subject (partial unique index)', async () => {
    await repos.submissionAiScans.create({
      id: 'fscan_1',
      subjectType: 'exercise',
      subjectId: 'fsub_1',
      model: 'm',
    })
    await expect(
      repos.submissionAiScans.create({
        id: 'fscan_2',
        subjectType: 'exercise',
        subjectId: 'fsub_1',
        model: 'm',
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError)
    // A different subject type with the same id is a separate subject.
    await repos.submissionAiScans.create({
      id: 'fscan_3',
      subjectType: 'food',
      subjectId: 'fsub_1',
      model: 'm',
    })
    // Once failed over, a new pending row is admitted.
    await repos.submissionAiScans.fail('fscan_1', 'stale')
    await repos.submissionAiScans.create({
      id: 'fscan_4',
      subjectType: 'exercise',
      subjectId: 'fsub_1',
      model: 'm',
    })
  })

  it('returns the latest scan per subject, batched', async () => {
    await repos.submissionAiScans.create({
      id: 'fscan_a1',
      subjectType: 'exercise',
      subjectId: 'fsub_a',
      model: 'm',
    })
    await repos.submissionAiScans.fail('fscan_a1', 'boom')
    await repos.submissionAiScans.create({
      id: 'fscan_a2',
      subjectType: 'exercise',
      subjectId: 'fsub_a',
      model: 'm',
    })
    await repos.submissionAiScans.create({
      id: 'fscan_b1',
      subjectType: 'exercise',
      subjectId: 'fsub_b',
      model: 'm',
    })

    const latest = await repos.submissionAiScans.getLatestBySubject('exercise', 'fsub_a')
    // Same created_at ms is possible in-test — the id ULID tiebreak keeps
    // the later insert winning.
    expect(latest?.id).toBe('fscan_a2')

    const map = await repos.submissionAiScans.getLatestForSubjects('exercise', [
      'fsub_a',
      'fsub_b',
      'fsub_missing',
    ])
    expect(map.get('fsub_a')?.id).toBe('fscan_a2')
    expect(map.get('fsub_b')?.id).toBe('fscan_b1')
    expect(map.has('fsub_missing')).toBe(false)
    expect(await repos.submissionAiScans.getLatestForSubjects('exercise', [])).toEqual(new Map())
  })
})

describe('D1 duplicate-shortlist candidate queries', () => {
  let repos: Repos
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM exercise_muscles WHERE exercise_id LIKE 'fex_scan_%'")
    await env.DB.exec("DELETE FROM exercises WHERE id LIKE 'fex_scan_%'")
    await env.DB.exec("DELETE FROM food_items WHERE id LIKE 'ff_scan_%'")
    repos = buildD1Repos(createDb(env.DB))
  })

  it('exercises: matches ANY name token against global rows only', async () => {
    await repos.exercises.createGlobal({
      id: 'fex_scan_1',
      name: 'Scanx Bench Press',
      discipline: 'strength',
      movementPattern: 'push',
      metricShape: 'reps_load',
      unilateral: false,
      muscles: [],
    })
    await repos.exercises.createCustom({
      id: 'fex_scan_2',
      ownerUserId: 'u_1',
      name: 'Scanx Custom Press',
      discipline: 'strength',
      movementPattern: 'push',
      metricShape: 'reps_load',
      unilateral: false,
      muscles: [],
    })
    // Tokens chosen to miss the seeded global catalog — only the OR-any
    // match against 'Scanx' should hit.
    const hits = await repos.exercises.searchGlobalCandidates('Scanx Zzzunseeded', 8)
    expect(hits.map((h) => h.id)).toEqual(['fex_scan_1'])
    expect(await repos.exercises.searchGlobalCandidates('   ', 8)).toEqual([])
  })

  it('food: exact upc sorts first; name/brand tokens match global rows only', async () => {
    const per100g = { kcal: 100, proteinG: 1, carbsG: 2, fatG: 3 }
    await repos.foodItems.create({
      id: 'ff_scan_upc',
      upc: '111222333',
      source: 'off',
      name: 'Zzzunrelated Product',
      per100g,
    })
    await repos.foodItems.create({
      id: 'ff_scan_name',
      source: 'off',
      name: 'Scanberry Jam',
      brand: 'AcmeScan',
      per100g,
    })
    await repos.foodItems.create({
      id: 'ff_scan_private',
      source: 'manual',
      name: 'Scanberry Private',
      ownerUserId: 'u_1',
      per100g,
    })
    const hits = await repos.foodItems.searchGlobalCandidates({
      upc: '111222333',
      name: 'Scanberry',
      brand: null,
      limit: 8,
    })
    expect(hits[0]?.id).toBe('ff_scan_upc')
    expect(hits.map((h) => h.id)).toContain('ff_scan_name')
    expect(hits.map((h) => h.id)).not.toContain('ff_scan_private')
  })
})
