import { describe, it, expect } from 'vitest'
import {
  NOTHING_SCHEDULED_CTAS,
  computeStreak,
  doneTemplateCountsOn,
  computeWeekHits,
  dayOffsetFromToday,
  formatTodayEyebrow,
  nextMidnightMs,
  resolveTodayFallback,
  resolveTodayTraining,
  startableFromRow,
  trainingTileVm,
  trainingsThisWeek,
  upcomingPlanSessions,
  weekRange,
  weekStartMonday,
  weekVolumeKg,
  type StartableToday,
} from './today-view.js'
import type { WorkoutDto } from './api.js'
import type { DayKey, TrainingPlanItemDto } from '@rallypoint/fitness-shared'

// Minimal-shape fixture builder. The view helpers only read
// `performedAt`, so the rest of the DTO can be skipped via `as`.
function w(performedAt: string): WorkoutDto {
  return { performedAt } as unknown as WorkoutDto
}

// `upcomingPlanSessions` only reads id / dayKey / position; the rest of
// the DTO can be skipped via `as`.
function item(id: string, dayKey: DayKey, position: number): TrainingPlanItemDto {
  return { id, dayKey, position } as unknown as TrainingPlanItemDto
}

describe('weekStartMonday', () => {
  it('snaps a Thursday (2026-06-25) back to its Monday (2026-06-22)', () => {
    expect(weekStartMonday('2026-06-25')).toBe('2026-06-22')
  })
  it('returns the same date when called on a Monday', () => {
    expect(weekStartMonday('2026-06-22')).toBe('2026-06-22')
  })
  it('snaps a Sunday back to the *prior* Monday (not the next one)', () => {
    expect(weekStartMonday('2026-06-28')).toBe('2026-06-22')
  })
})

describe('weekRange', () => {
  it('returns a half-open [Mon, next-Mon) range', () => {
    expect(weekRange('2026-06-25')).toEqual({ start: '2026-06-22', end: '2026-06-29' })
  })
})

describe('computeWeekHits', () => {
  const today = '2026-06-25' // Thursday
  it('returns all-false for an empty workout list', () => {
    expect(computeWeekHits([], today)).toEqual([false, false, false, false, false, false, false])
  })
  it('flags Mon + Wed + Thu when the user trained on those days', () => {
    const ws = [
      w('2026-06-22T17:00:00Z'), // Mon
      w('2026-06-24T17:00:00Z'), // Wed
      w('2026-06-25T07:00:00Z'), // Thu
    ]
    expect(computeWeekHits(ws, today)).toEqual([true, false, true, true, false, false, false])
  })
  it('ignores workouts outside the current week', () => {
    const ws = [
      w('2026-06-15T17:00:00Z'), // prior week
      w('2026-06-29T17:00:00Z'), // next week
    ]
    expect(computeWeekHits(ws, today).filter(Boolean)).toHaveLength(0)
  })
  it('coalesces two-a-day workouts into a single hit', () => {
    const ws = [w('2026-06-23T07:00:00Z'), w('2026-06-23T18:00:00Z')]
    const hits = computeWeekHits(ws, today)
    expect(hits[1]).toBe(true)
    expect(hits.filter(Boolean)).toHaveLength(1)
  })
})

describe('trainingsThisWeek', () => {
  it('returns the count of distinct training days in the current Mon→Sun week', () => {
    const ws = [
      w('2026-06-22T17:00:00Z'),
      w('2026-06-23T17:00:00Z'),
      w('2026-06-23T19:00:00Z'),
      w('2026-06-25T07:00:00Z'),
    ]
    expect(trainingsThisWeek(ws, '2026-06-25')).toBe(3)
  })
})

describe('weekVolumeKg', () => {
  const today = '2026-06-25' // Thursday; week = Mon 22 → Sun 28

  // weekVolumeKg also reads `sets`, unlike the other helpers.
  function ws(
    performedAt: string,
    sets: { reps: number | null; loadKg: number | null; setType?: 'warmup' | 'working' }[],
  ): WorkoutDto {
    return {
      performedAt,
      sets: sets.map((s, i) => ({
        id: `s${i}`,
        exerciseId: 'fx',
        setIndex: i,
        reps: s.reps,
        loadKg: s.loadKg,
        distanceM: null,
        timeS: null,
        rounds: null,
        rpe: null,
        notes: null,
        setType: s.setType ?? 'working',
      })),
    } as unknown as WorkoutDto
  }

  it('sums reps × load for working sets inside the Mon→Sun week', () => {
    const kg = weekVolumeKg(
      [
        ws('2026-06-22T17:00:00Z', [{ reps: 5, loadKg: 100 }]),
        ws('2026-06-24T17:00:00Z', [{ reps: 10, loadKg: 40 }]),
      ],
      today,
    )
    expect(kg).toBe(900)
  })

  it('excludes workouts outside the week and warmup sets inside it', () => {
    const kg = weekVolumeKg(
      [
        ws('2026-06-21T17:00:00Z', [{ reps: 5, loadKg: 100 }]), // Sunday before
        ws('2026-06-29T07:00:00Z', [{ reps: 5, loadKg: 100 }]), // next Monday
        ws('2026-06-23T17:00:00Z', [
          { reps: 5, loadKg: 60, setType: 'warmup' },
          { reps: 5, loadKg: 100 },
        ]),
      ],
      today,
    )
    expect(kg).toBe(500)
  })

  it('returns 0 for no workouts or null-valued sets', () => {
    expect(weekVolumeKg([], today)).toBe(0)
    expect(weekVolumeKg([ws('2026-06-23T17:00:00Z', [{ reps: null, loadKg: 100 }])], today)).toBe(0)
  })
})

describe('computeStreak', () => {
  const today = '2026-06-25' // Thursday
  it('returns 0 when no workouts exist', () => {
    expect(computeStreak([], today)).toBe(0)
  })
  it('counts back-to-back days including today', () => {
    const ws = [w('2026-06-25T08:00:00Z'), w('2026-06-24T08:00:00Z'), w('2026-06-23T08:00:00Z')]
    expect(computeStreak(ws, today)).toBe(3)
  })
  it('falls back to "ends yesterday" when today is a rest day', () => {
    const ws = [w('2026-06-24T08:00:00Z'), w('2026-06-23T08:00:00Z')]
    expect(computeStreak(ws, today)).toBe(2)
  })
  it('stops at the first missed day', () => {
    const ws = [
      w('2026-06-25T08:00:00Z'),
      w('2026-06-24T08:00:00Z'),
      // 2026-06-23 missed
      w('2026-06-22T08:00:00Z'),
    ]
    expect(computeStreak(ws, today)).toBe(2)
  })
  it('handles a one-day streak', () => {
    expect(computeStreak([w('2026-06-25T08:00:00Z')], today)).toBe(1)
  })
})

describe('formatTodayEyebrow', () => {
  it('formats a Thursday as expected', () => {
    expect(formatTodayEyebrow(new Date(2026, 5, 25))).toBe('THURSDAY · 25 JUN')
  })
})

// Code-review F9/F10: a tab left open across midnight kept showing
// yesterday's TODAY plan items. nextMidnightMs drives the Today
// view's setTimeout-based rollover; tests pin the input clock so the
// DST seams are deterministic (TZ-agnostic — we read whatever the
// host TZ is and trust the wall-clock contract).
describe('nextMidnightMs', () => {
  it('rolls forward to the next local midnight on a normal day', () => {
    // 2026-06-25 14:30:00 local → midnight on 2026-06-26 local.
    const now = new Date(2026, 5, 25, 14, 30, 0, 0)
    const next = new Date(nextMidnightMs(now))
    expect(next.getFullYear()).toBe(2026)
    expect(next.getMonth()).toBe(5)
    expect(next.getDate()).toBe(26)
    expect(next.getHours()).toBe(0)
    expect(next.getMinutes()).toBe(0)
    expect(next.getSeconds()).toBe(0)
    expect(next.getMilliseconds()).toBe(0)
  })

  it('still resolves to the next calendar day at one second before midnight', () => {
    const now = new Date(2026, 5, 25, 23, 59, 59, 0)
    const next = new Date(nextMidnightMs(now))
    expect(next.getDate()).toBe(26)
    expect(next.getHours()).toBe(0)
  })

  it('crosses a month boundary cleanly', () => {
    const now = new Date(2026, 5, 30, 23, 0, 0, 0) // 30 Jun 23:00 local
    const next = new Date(nextMidnightMs(now))
    expect(next.getMonth()).toBe(6) // July
    expect(next.getDate()).toBe(1)
    expect(next.getHours()).toBe(0)
  })

  it('returns a future timestamp (delay > 0)', () => {
    const now = new Date(2026, 5, 25, 14, 30, 0, 0)
    expect(nextMidnightMs(now)).toBeGreaterThan(now.getTime())
  })
})

describe('resolveTodayFallback', () => {
  it('returns null when no day type is assigned for the given day', () => {
    expect(resolveTodayFallback('mon', {})).toBeNull()
    expect(resolveTodayFallback('mon', { tue: 'strength' })).toBeNull()
  })

  it('resolves strength to the composer quick-start CTA', () => {
    const result = resolveTodayFallback('mon', { mon: 'strength' })
    expect(result).toEqual({
      type: 'strength',
      label: 'Strength',
      blurb: expect.any(String),
      cta: { label: expect.any(String), to: '/composer?mode=strength' },
    })
  })

  it('resolves cardio to the run-log CTA', () => {
    const result = resolveTodayFallback('tue', { tue: 'cardio' })
    expect(result?.type).toBe('cardio')
    expect(result?.cta).toEqual({ label: expect.any(String), to: '/run/log' })
  })

  it('resolves hiit to the WOD library CTA', () => {
    const result = resolveTodayFallback('wed', { wed: 'hiit' })
    expect(result?.type).toBe('hiit')
    expect(result?.cta).toEqual({ label: expect.any(String), to: '/library/wods' })
  })

  it('resolves mobility to the library CTA', () => {
    const result = resolveTodayFallback('thu', { thu: 'mobility' })
    expect(result?.type).toBe('mobility')
    expect(result?.cta).toEqual({ label: expect.any(String), to: '/library' })
  })

  it('resolves rest to a null CTA', () => {
    const result = resolveTodayFallback('fri', { fri: 'rest' })
    expect(result?.type).toBe('rest')
    expect(result?.cta).toBeNull()
    expect(result?.blurb).toMatch(/recovery/i)
  })

  it('resolves a free-text day to its raw label with a null preset + no CTA', () => {
    const result = resolveTodayFallback('sat', { sat: 'CrossFit class' })
    expect(result).toEqual({
      type: null,
      label: 'CrossFit class',
      blurb: expect.any(String),
      cta: null,
    })
  })
})

describe('dayOffsetFromToday', () => {
  it('is 0 for the same day', () => {
    expect(dayOffsetFromToday('wed', 'wed')).toBe(0)
  })
  it('is 1 for tomorrow', () => {
    expect(dayOffsetFromToday('thu', 'wed')).toBe(1)
  })
  it('wraps across the week boundary (Sunday → Monday = 1)', () => {
    expect(dayOffsetFromToday('mon', 'sun')).toBe(1)
  })
  it('treats a past-this-week day as next week (Sunday → Wednesday = 3)', () => {
    expect(dayOffsetFromToday('wed', 'sun')).toBe(3)
  })
})

describe('upcomingPlanSessions', () => {
  it('surfaces the rest of the week from a Sunday, wrapping the boundary', () => {
    // The reported bug: a Sun view of a Mon/Tue/Wed plan must list those
    // sessions instead of collapsing to "No plan yet".
    const items = [item('a', 'mon', 0), item('b', 'tue', 0), item('c', 'wed', 0)]
    expect(upcomingPlanSessions(items, 'sun').map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('orders today ahead of later days regardless of input order', () => {
    const items = [item('wed', 'wed', 0), item('today', 'sun', 0), item('mon', 'mon', 0)]
    expect(upcomingPlanSessions(items, 'sun').map((i) => i.id)).toEqual(['today', 'mon', 'wed'])
  })

  it('drops the hero item via skipItemId', () => {
    const items = [item('hero', 'sun', 0), item('next', 'sun', 1)]
    expect(upcomingPlanSessions(items, 'sun', { skipItemId: 'hero' }).map((i) => i.id)).toEqual([
      'next',
    ])
  })

  it('orders two items on the same day by position', () => {
    const items = [item('second', 'mon', 1), item('first', 'mon', 0)]
    expect(upcomingPlanSessions(items, 'sun').map((i) => i.id)).toEqual(['first', 'second'])
  })

  it('caps the result at `limit`', () => {
    const items = [item('a', 'mon', 0), item('b', 'tue', 0), item('c', 'wed', 0)]
    expect(upcomingPlanSessions(items, 'sun', { limit: 2 }).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('returns [] for no items', () => {
    expect(upcomingPlanSessions([], 'sun')).toEqual([])
  })

  it('does not mutate the input array', () => {
    const items = [item('b', 'tue', 0), item('a', 'mon', 0)]
    upcomingPlanSessions(items, 'sun')
    expect(items.map((i) => i.id)).toEqual(['b', 'a'])
  })
})

describe('startableFromRow', () => {
  const base = { itemId: 'it_1', planId: 'tpl_1', note: null, run: false }

  it('routes a WOD row at the live timer and marks it WOD-kind', () => {
    expect(
      startableFromRow({
        ...base,
        template: { id: 'wt_1', name: 'Fran', kind: 'wod', wodType: 'rounds_for_time' },
      }),
    ).toEqual({
      itemId: 'it_1',
      name: 'Fran',
      meta: 'ROUNDS FOR TIME',
      to: '/live/wod/wt_1/run',
      templateId: 'wt_1',
      run: null,
    })
  })

  it('routes a strength row at the strength engine, and it is not WOD-kind', () => {
    expect(
      startableFromRow({
        ...base,
        template: { id: 'wt_2', name: 'Upper Strength', kind: 'strength', wodType: null },
      }),
    ).toEqual({
      itemId: 'it_1',
      name: 'Upper Strength',
      meta: 'STRENGTH',
      to: '/live/strength/new?templateId=wt_2',
      templateId: 'wt_2',
      run: null,
    })
  })

  it('routes a run row at the quick-log form, carrying the plan item so a save clears it', () => {
    const s = startableFromRow({ ...base, run: true, note: 'Easy 5k', template: null })
    expect(s?.name).toBe('Easy 5k')
    expect(s?.meta).toBe('RUN')
    expect(s?.to).toBe('/run/log?planId=tpl_1&planItemId=it_1&note=Easy+5k')
    // The structured ref an inline-sheet host uses instead of the route.
    expect(s?.run).toEqual({ planId: 'tpl_1', planItemId: 'it_1', note: 'Easy 5k' })
    expect(s?.templateId).toBeNull()
  })

  it('names an unlabelled run row', () => {
    expect(startableFromRow({ ...base, run: true, template: null })?.name).toBe('Run')
  })

  it('percent-encodes template ids into the route', () => {
    const s = startableFromRow({
      ...base,
      template: { id: 'wt/3 4', name: 'X', kind: 'strength', wodType: null },
    })
    expect(s?.to).toBe('/live/strength/new?templateId=wt%2F3%204')
  })

  it('has nothing to start when the template was deleted', () => {
    expect(startableFromRow({ ...base, template: null })).toBeNull()
  })
})

describe('resolveTodayTraining', () => {
  const wod: StartableToday = {
    itemId: 'it_wod',
    name: 'Fran',
    meta: 'FOR TIME',
    to: '/live/wod/wt_1/run',
    templateId: 'wt_1',
    run: null,
  }
  const strength: StartableToday = {
    itemId: 'it_str',
    name: 'Upper Strength',
    meta: 'STRENGTH',
    to: '/live/strength/new?templateId=wt_2',
    templateId: 'wt_2',
    run: null,
  }
  const fallback = {
    type: 'strength' as const,
    label: 'Strength',
    blurb: 'b',
    cta: { label: 'Start strength session', to: '/composer?mode=strength' },
  }

  it('starts the single scheduled session directly', () => {
    expect(resolveTodayTraining([wod], null)).toEqual({ kind: 'session', session: wod })
  })

  it('offers a choice when several sessions are scheduled and open', () => {
    expect(resolveTodayTraining([wod, strength], null)).toEqual({
      kind: 'choice',
      sessions: [wod, strength],
    })
  })

  it('narrows a multi-session day to a direct start once all but one are done', () => {
    expect(resolveTodayTraining([wod, strength], null, new Map([['wt_1', 1]]))).toEqual({
      kind: 'session',
      session: strength,
    })
  })

  it('reads complete once every scheduled session is logged', () => {
    expect(
      resolveTodayTraining(
        [wod, strength],
        null,
        new Map([
          ['wt_1', 1],
          ['wt_2', 1],
        ]),
      ),
    ).toEqual({ kind: 'complete' })
    // Complete beats the weekly-rhythm fallback: the day WAS trained.
    expect(resolveTodayTraining([wod], fallback, new Map([['wt_1', 1]]))).toEqual({
      kind: 'complete',
    })
  })

  it('consumes done counts row-by-row: a template scheduled twice needs two logs', () => {
    const wodAgain = { ...wod, itemId: 'it_wod_2' }
    expect(resolveTodayTraining([wod, wodAgain], null, new Map([['wt_1', 1]]))).toEqual({
      kind: 'session',
      session: wodAgain,
    })
    expect(resolveTodayTraining([wod, wodAgain], null, new Map([['wt_1', 2]]))).toEqual({
      kind: 'complete',
    })
  })

  it('never marks a run row done by template id — run rows self-delete on save', () => {
    const run: StartableToday = {
      itemId: 'it_run',
      name: 'Easy 5k',
      meta: 'RUN',
      to: '/run/log?planId=p&planItemId=it_run',
      templateId: null,
      run: { planId: 'p', planItemId: 'it_run', note: 'Easy 5k' },
    }
    expect(resolveTodayTraining([run], null, new Map([['wt_1', 1]]))).toEqual({
      kind: 'session',
      session: run,
    })
  })

  it('scans past a deleted template rather than showing an empty day behind it', () => {
    expect(resolveTodayTraining([null, strength], null)).toEqual({
      kind: 'session',
      session: strength,
    })
  })

  it('prefers a real scheduled session over the weekly-rhythm guess', () => {
    expect(resolveTodayTraining([wod], fallback)).toEqual({ kind: 'session', session: wod })
  })

  it('falls back to the weekly rhythm when nothing is scheduled', () => {
    expect(resolveTodayTraining([], fallback)).toEqual({ kind: 'fallback', fallback })
    // Rows that resolve to nothing are the same as no rows at all.
    expect(resolveTodayTraining([null, null], fallback)).toEqual({ kind: 'fallback', fallback })
  })

  it('offers direct-start CTAs when there is no plan and no rhythm', () => {
    expect(resolveTodayTraining([], null)).toEqual({
      kind: 'empty',
      ctas: NOTHING_SCHEDULED_CTAS,
    })
  })

  it('every empty-day CTA starts something — none of them just navigate to the planner', () => {
    expect(NOTHING_SCHEDULED_CTAS.map((c) => c.label)).toEqual([
      'Free strength',
      'Browse WODs',
      'Log cardio',
    ])
  })
})

describe('doneTemplateCountsOn', () => {
  function wp(performedAt: string, payload: Record<string, unknown> | null): WorkoutDto {
    return { performedAt, payload } as unknown as WorkoutDto
  }
  // Local (no-Z) timestamps: dateKey buckets by the host's local date, so
  // a zoned timestamp would flip days depending on the test machine's TZ.
  const NOON = '2026-06-25T12:00:00'

  it("counts template ids of today's workouts only", () => {
    const done = doneTemplateCountsOn(
      [
        wp(NOON, { templateId: 'wt_1' }),
        wp('2026-06-25T13:00:00', { templateId: 'wt_1' }),
        wp('2026-06-24T12:00:00', { templateId: 'wt_2' }), // yesterday
      ],
      '2026-06-25',
    )
    expect([...done]).toEqual([['wt_1', 2]])
  })

  it('prefers sourceTemplateId — the strength engine stamps benchmarks only there', () => {
    const done = doneTemplateCountsOn(
      [wp(NOON, { sourceTemplateId: 'wt_bench', templateId: 'wt_custom' })],
      '2026-06-25',
    )
    expect([...done]).toEqual([['wt_bench', 1]])
  })

  it('ignores workouts without a template id (free sessions, runs)', () => {
    const done = doneTemplateCountsOn(
      [
        wp(NOON, null),
        wp(NOON, { weather: {} }),
        wp(NOON, { templateId: 42 }), // malformed
      ],
      '2026-06-25',
    )
    expect(done.size).toBe(0)
  })
})

describe('the hero claim and the Upcoming list agree', () => {
  it('drops whatever the hero started from Upcoming, whichever kind it is', () => {
    // The widened hero pick changes what Upcoming shows: a strength item
    // that used to fall through to the list is now the hero, so it must
    // not also list below it.
    const rows = [
      {
        ...{ itemId: 'it_str', planId: 'p', note: null, run: false },
        template: { id: 'wt_2', name: 'Upper', kind: 'strength' as const, wodType: null },
      },
    ]
    const today = resolveTodayTraining(rows.map(startableFromRow), null)
    expect(today.kind).toBe('session')
    const heroId = today.kind === 'session' ? today.session.itemId : null
    const items = [item('it_str', 'mon', 0), item('it_other', 'tue', 0)]
    expect(upcomingPlanSessions(items, 'mon', { skipItemId: heroId }).map((i) => i.id)).toEqual([
      'it_other',
    ])
  })
})

describe('trainingTileVm', () => {
  const session: StartableToday = {
    itemId: 'it_1',
    name: 'Upper Strength',
    meta: 'STRENGTH',
    to: '/live/strength/new?templateId=wt_2',
    templateId: 'wt_2',
    run: null,
  }

  it('names the scheduled session', () => {
    expect(trainingTileVm({ kind: 'session', session })).toEqual({
      value: 'Upper Strength',
      sub: 'STRENGTH',
    })
  })

  it('counts the open sessions on a multi-workout day', () => {
    expect(trainingTileVm({ kind: 'choice', sessions: [session, session] })).toEqual({
      value: 'Start a workout',
      sub: '2 SCHEDULED',
    })
  })

  it('celebrates a completed day and offers another', () => {
    expect(trainingTileVm({ kind: 'complete' })).toEqual({
      value: 'Workout complete',
      sub: 'TAP TO START ANOTHER',
    })
  })

  it('invites a start on a day-typed day', () => {
    expect(
      trainingTileVm({
        kind: 'fallback',
        fallback: { type: 'strength', label: 'Strength', blurb: 'b', cta: null },
      }),
    ).toEqual({ value: 'Start a workout', sub: 'STRENGTH' })
  })

  it('does not urge a session on a rest day', () => {
    expect(
      trainingTileVm({
        kind: 'fallback',
        fallback: { type: 'rest', label: 'Rest', blurb: 'b', cta: null },
      }),
    ).toEqual({ value: 'Rest day', sub: 'RECOVERY' })
  })

  it('uses a free-text day label verbatim', () => {
    expect(
      trainingTileVm({
        kind: 'fallback',
        fallback: { type: null, label: 'CrossFit class', blurb: 'b', cta: null },
      }),
    ).toEqual({ value: 'Start a workout', sub: 'CROSSFIT CLASS' })
  })

  it('still invites a start with nothing scheduled at all', () => {
    expect(trainingTileVm({ kind: 'empty', ctas: NOTHING_SCHEDULED_CTAS })).toEqual({
      value: 'Start a workout',
      sub: 'NOTHING SCHEDULED',
    })
  })
})
