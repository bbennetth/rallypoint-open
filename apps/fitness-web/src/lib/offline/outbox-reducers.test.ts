import { describe, expect, it } from 'vitest'
import type { OutboxEntry, OutboxOp } from './outbox-ops.js'
import { distinctAffectedSurfaces, opAffectedSurface, opItemId } from './outbox-ops.js'
import {
  applyFavoriteOps,
  applyFoodFavoriteOps,
  applyPlanItemOps,
  applyWorkoutOps,
  buildOutboxEntry,
  coalesceEntries,
  fitnessCodec,
  remapTmpId,
  resolveOpTmpIds,
  resolveTemplateBodyTmpIds,
  synthTemplate,
  synthWorkout,
} from './outbox-reducers.js'

// Fitness domain reducers — pure, no Dexie/React/I-O. The generic walk
// lives in @rallypoint/offline-kit; these tests pin the fitness codec's
// identities and the rebase appliers.

function entry(op: OutboxOp, seq: number): OutboxEntry {
  return { seq, ...buildOutboxEntry(op, 1000) }
}

describe('coalescing', () => {
  it('adjacent workout updates on the same id merge, later values winning', () => {
    const out = coalesceEntries([
      entry({ type: 'workout:update', workoutId: 'w1', patch: { title: 'a', rpe: 7 } }, 1),
      entry({ type: 'workout:update', workoutId: 'w1', patch: { rpe: 9 } }, 2),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.op).toMatchObject({ patch: { title: 'a', rpe: 9 } })
  })

  it('favorite:set coalesces last-wins (star → unstar collapses to unstar)', () => {
    const out = coalesceEntries([
      entry({ type: 'favorite:set', exerciseId: 'ex1', starred: true }, 1),
      entry({ type: 'favorite:set', exerciseId: 'ex1', starred: false }, 2),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.op).toMatchObject({ starred: false })
  })

  it('settings patches coalesce per namespace', () => {
    const out = coalesceEntries([
      entry({ type: 'settings:update', namespace: 'fitness', patch: { weightUnit: 'lb' } }, 1),
      entry({ type: 'settings:update', namespace: 'fitness', patch: { weightUnit: 'kg' } }, 2),
      entry({ type: 'settings:update', namespace: 'shared', patch: { themeMode: 'dark' } }, 3),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]?.op).toMatchObject({ patch: { weightUnit: 'kg' } })
  })

  it('creates and deletes never coalesce', () => {
    const out = coalesceEntries([
      entry({ type: 'workout:delete', workoutId: 'w1' }, 1),
      entry({ type: 'workout:delete', workoutId: 'w1' }, 2),
    ])
    expect(out).toHaveLength(2)
  })
})

describe('tmp-id remap', () => {
  it('rewrites nested references: workout sets + plan item planId/sourceId', () => {
    const tmpEx = 'tmp_exercise'
    const tmpPlan = 'tmp_plan'
    const entries: OutboxEntry[] = [
      entry(
        {
          type: 'workout:create',
          tmpId: 'tmp_w',
          input: {
            performedAt: '2026-07-08T10:00:00Z',
            modality: 'strength',
            sets: [{ exerciseId: tmpEx, reps: 5 }],
          },
        },
        1,
      ),
      entry(
        {
          type: 'planItem:create',
          planId: tmpPlan,
          tmpId: 'tmp_pi',
          input: { dayKey: 'mon', position: 0, sourceKind: 'exercise', sourceId: tmpEx },
        },
        2,
      ),
    ]
    const fixed = remapTmpId(entries, tmpEx, 'ex_real')
    const w = fixed[0]?.op
    expect(w?.type === 'workout:create' && w.input.sets[0]?.exerciseId).toBe('ex_real')
    const pi = fixed[1]?.op
    expect(pi?.type === 'planItem:create' && pi.input.sourceId).toBe('ex_real')

    const afterPlan = remapTmpId(fixed, tmpPlan, 'plan_real')
    const pi2 = afterPlan[1]?.op
    expect(pi2?.type === 'planItem:create' && pi2.planId).toBe('plan_real')
  })

  it('rewrites exercise refs inside template bodies (WOD movements, buy-in, strength blocks)', () => {
    const tmpEx = 'tmp_exercise'
    const entries: OutboxEntry[] = [
      entry(
        {
          type: 'template:create',
          tmpId: 'tmp_t1',
          input: {
            name: 'Custom WOD',
            wodType: 'for_time',
            body: {
              wodType: 'for_time',
              rounds: 3,
              schemeRounds: [21, 15, 9],
              movements: [{ exerciseId: tmpEx, reps: 21 }, { exerciseId: 'fx_seed_run' }],
              perMinuteBuyIn: { exerciseId: tmpEx, reps: 5 },
            },
          },
        },
        1,
      ),
      entry(
        {
          type: 'template:update',
          templateId: 't2',
          patch: {
            body: {
              kind: 'strength',
              blocks: [{ exerciseId: tmpEx, name: 'thing', sets: [{ reps: 5 }] }],
            },
          },
        },
        2,
      ),
    ]
    const fixed = remapTmpId(entries, tmpEx, 'ex_real')
    const t1 = fixed[0]?.op
    if (
      t1?.type !== 'template:create' ||
      !('wodType' in t1.input.body) ||
      t1.input.body.wodType !== 'for_time'
    ) {
      throw new Error('unexpected op shape')
    }
    expect(t1.input.body.movements[0]?.exerciseId).toBe('ex_real')
    expect(t1.input.body.movements[1]?.exerciseId).toBe('fx_seed_run')
    expect(t1.input.body.perMinuteBuyIn?.exerciseId).toBe('ex_real')
    const t2 = fixed[1]?.op
    if (t2?.type !== 'template:update' || !t2.patch.body || !('blocks' in t2.patch.body)) {
      throw new Error('unexpected op shape')
    }
    expect(t2.patch.body.blocks[0]?.exerciseId).toBe('ex_real')
  })

  it('submission:create follows its exercise tmp id (queue remap + enqueue-time resolve)', () => {
    const entries: OutboxEntry[] = [
      entry({ type: 'submission:create', exerciseId: 'tmp_exercise' }, 1),
    ]
    const fixed = remapTmpId(entries, 'tmp_exercise', 'ex_real')
    expect(fixed[0]?.op).toMatchObject({ type: 'submission:create', exerciseId: 'ex_real' })
    const op: OutboxOp = { type: 'submission:create', exerciseId: 'tmp_exercise' }
    expect(resolveOpTmpIds(op, () => 'ex_real')).toMatchObject({ exerciseId: 'ex_real' })
  })

  it('resolveOpTmpIds rewrites an enqueue-time target but never a create', () => {
    const up: OutboxOp = { type: 'metric:update', metricId: 'tmp_m', patch: { value: 80 } }
    expect(resolveOpTmpIds(up, () => 'm_real')).toMatchObject({ metricId: 'm_real' })
    const create: OutboxOp = {
      type: 'metric:create',
      tmpId: 'tmp_m',
      input: { recordedAt: '2026-07-08T10:00:00Z', kind: 'bodyweight', value: 80 },
    }
    expect(resolveOpTmpIds(create, () => 'm_real')).toBe(create)
  })

  it('codec identities: tmpIdOf / targetIdOf agree with opItemId', () => {
    const op: OutboxOp = { type: 'favorite:set', exerciseId: 'ex1', starred: true }
    expect(fitnessCodec.tmpIdOf(op)).toBeUndefined()
    expect(fitnessCodec.targetIdOf(op)).toBe(opItemId(op))
  })
})

describe('resolveTemplateBodyTmpIds', () => {
  const isTemp = (id: string) => id.startsWith('tmp_')
  const resolve = (id: string) => (id === 'tmp_exercise' ? 'ex_real' : id)

  it('rewrites resolved tmp ids across blocks/movements/perMinuteBuyIn', () => {
    const body = {
      wodType: 'for_time' as const,
      movements: [{ exerciseId: 'tmp_exercise', reps: 21 }, { exerciseId: 'fx_seed_run' }],
      perMinuteBuyIn: { exerciseId: 'tmp_exercise', reps: 5 },
      blocks: [{ exerciseId: 'tmp_exercise', sets: 3 }],
    }
    const out = resolveTemplateBodyTmpIds(body, isTemp, resolve)
    expect(out.movements[0]?.exerciseId).toBe('ex_real')
    expect(out.movements[1]?.exerciseId).toBe('fx_seed_run')
    expect(out.perMinuteBuyIn?.exerciseId).toBe('ex_real')
    expect(out.blocks[0]?.exerciseId).toBe('ex_real')
  })

  it('leaves still-unresolved tmp ids in place', () => {
    const body = { movements: [{ exerciseId: 'tmp_other' }] }
    const identity = (id: string) => id
    const out = resolveTemplateBodyTmpIds(body, isTemp, identity)
    expect(out).toBe(body)
    expect(out.movements[0]?.exerciseId).toBe('tmp_other')
  })

  it('leaves real ids untouched', () => {
    const body = { movements: [{ exerciseId: 'ex_already_real' }] }
    const out = resolveTemplateBodyTmpIds(body, isTemp, resolve)
    expect(out).toBe(body)
  })
})

describe('affected surfaces', () => {
  it('maps each family and dedupes per (kind, scope)', () => {
    const ops: OutboxOp[] = [
      { type: 'workout:delete', workoutId: 'w1' },
      { type: 'workout:update', workoutId: 'w2', patch: {} },
      { type: 'planItem:delete', planId: 'p1', itemId: 'i1' },
      { type: 'planItem:delete', planId: 'p2', itemId: 'i2' },
      { type: 'settings:update', namespace: 'fitness', patch: {} },
    ]
    const surfaces = distinctAffectedSurfaces(ops)
    expect(surfaces).toEqual([
      { kind: 'workout', scope: '' },
      { kind: 'planItem', scope: 'p1' },
      { kind: 'planItem', scope: 'p2' },
      { kind: 'settings', scope: 'fitness' },
    ])
    expect(opAffectedSurface(ops[0]!)).toEqual({ kind: 'workout', scope: '' })
  })
})

describe('rebase appliers', () => {
  const createOp: OutboxOp = {
    type: 'workout:create',
    tmpId: 'tmp_w',
    input: {
      performedAt: '2026-07-08T10:00:00Z',
      modality: 'strength',
      title: 'Squats',
      sets: [{ exerciseId: 'ex1', reps: 5, loadKg: 100 }],
    },
  }

  it('appends a full-shape synth only when the key window matches', () => {
    const inWindow = applyWorkoutOps([], [createOp], (w) => w.performedAt.startsWith('2026-07'))
    expect(inWindow).toHaveLength(1)
    expect(inWindow[0]).toMatchObject({
      id: 'tmp_w',
      modality: 'strength',
      title: 'Squats',
      durationS: null,
      payload: null,
    })
    expect(inWindow[0]?.sets[0]).toMatchObject({ exerciseId: 'ex1', reps: 5, loadKg: 100 })

    const outOfWindow = applyWorkoutOps([], [createOp], () => false)
    expect(outOfWindow).toHaveLength(0)
  })

  it('is idempotent on re-application', () => {
    const once = applyWorkoutOps([], [createOp], () => true)
    const twice = applyWorkoutOps(once, [createOp], () => true)
    expect(twice).toHaveLength(1)
  })

  it('update patches carry sets replacement as synthesized rows', () => {
    const base = synthWorkout(createOp)
    const out = applyWorkoutOps(
      [base],
      [
        {
          type: 'workout:update',
          workoutId: 'tmp_w',
          patch: { title: 'Heavy squats', sets: [{ exerciseId: 'ex1', reps: 3, loadKg: 120 }] },
        },
      ],
      () => true,
    )
    expect(out[0]?.title).toBe('Heavy squats')
    expect(out[0]?.sets).toHaveLength(1)
    expect(out[0]?.sets[0]).toMatchObject({ reps: 3, loadKg: 120 })
  })

  it('plan item ops apply only to their plan scope', () => {
    const op: OutboxOp = {
      type: 'planItem:create',
      planId: 'p1',
      tmpId: 'tmp_pi',
      input: { dayKey: 'tue', position: 1, sourceKind: 'strength', note: 'squat day' },
    }
    expect(applyPlanItemOps([], [op], 'p1')).toHaveLength(1)
    expect(applyPlanItemOps([], [op], 'p2')).toHaveLength(0)
  })

  it('favorite ops toggle membership idempotently', () => {
    const star: OutboxOp = { type: 'favorite:set', exerciseId: 'ex1', starred: true }
    const unstar: OutboxOp = { type: 'favorite:set', exerciseId: 'ex1', starred: false }
    expect(applyFavoriteOps([], [star])).toEqual(['ex1'])
    expect(applyFavoriteOps(['ex1'], [star])).toEqual(['ex1'])
    expect(applyFavoriteOps(['ex1'], [unstar])).toEqual([])
    expect(applyFavoriteOps([], [star, unstar])).toEqual([])
  })
})

describe('food favorite ops', () => {
  const pin: OutboxOp = {
    type: 'foodFavorite:create',
    tmpId: 'tmp_ffav',
    input: {
      name: 'Greek yogurt',
      quantityGrams: 170,
      kcal: 100,
      proteinG: 17,
      carbsG: 6,
      fatG: 0.7,
      source: 'manual',
    },
  }

  it('prepends an optimistic pin, matching the server newest-first order', () => {
    const existing = [{ id: 'ffav_old', name: 'Oatmeal' } as never]
    const out = applyFoodFavoriteOps(existing, [pin])
    expect(out).toHaveLength(2)
    expect(out[0]?.id).toBe('tmp_ffav')
    expect(out[0]).toMatchObject({ name: 'Greek yogurt', quantityGrams: 170, kcal: 100 })
    expect(out[1]?.id).toBe('ffav_old')
  })

  it('fills the snapshot nullables the DTO requires', () => {
    const out = applyFoodFavoriteOps([], [
      { ...pin, input: { name: 'Coffee', kcal: 5, proteinG: 0, carbsG: 1, fatG: 0, source: 'drink' } },
    ])
    expect(out[0]).toMatchObject({
      foodItemId: null,
      quantityGrams: null,
      quantityUnit: null,
      quantityAmount: null,
    })
  })

  it('does not double-append the same pin', () => {
    expect(applyFoodFavoriteOps(applyFoodFavoriteOps([], [pin]), [pin])).toHaveLength(1)
  })

  it('delete filters the pin out', () => {
    const del: OutboxOp = { type: 'foodFavorite:delete', favoriteId: 'tmp_ffav' }
    expect(applyFoodFavoriteOps([], [pin, del])).toEqual([])
  })

  it('never coalesces pins — each must reach the server', () => {
    const second: OutboxOp = { ...pin, tmpId: 'tmp_ffav2' }
    expect(coalesceEntries([entry(pin, 1), entry(second, 2)])).toHaveLength(2)
  })

  it('remaps a delete that targets a pin created offline', () => {
    const del: OutboxOp = { type: 'foodFavorite:delete', favoriteId: 'tmp_ffav' }
    const [, remapped] = remapTmpId([entry(pin, 1), entry(del, 2)], 'tmp_ffav', 'ffav_real')
    expect(remapped?.op).toMatchObject({ type: 'foodFavorite:delete', favoriteId: 'ffav_real' })
  })

  it('resolves a queued delete tmp id through the session map', () => {
    const del: OutboxOp = { type: 'foodFavorite:delete', favoriteId: 'tmp_ffav' }
    const resolved = resolveOpTmpIds(del, (id) => (id === 'tmp_ffav' ? 'ffav_real' : id))
    expect(resolved).toMatchObject({ favoriteId: 'ffav_real' })
  })
})

describe('template synth', () => {
  it('discriminates wod vs strength inputs', () => {
    const wod = synthTemplate({
      type: 'template:create',
      tmpId: 'tmp_t',
      input: {
        name: 'Sprint AMRAP',
        wodType: 'amrap',
        body: { wodType: 'amrap', durationS: 600, movements: [] },
      } as never,
    })
    expect(wod).toMatchObject({ kind: 'wod', wodType: 'amrap', isCustom: true, isBenchmark: false })

    const strength = synthTemplate({
      type: 'template:create',
      tmpId: 'tmp_t2',
      input: { name: '5x5', body: { kind: 'strength', blocks: [] } } as never,
    })
    expect(strength).toMatchObject({ kind: 'strength', wodType: null, timeCapS: null })
  })
})
