import { describe, expect, it } from 'vitest'
import {
  createWodTemplateSchema,
  patchWodTemplateSchema,
  strengthBodySchema,
  wodBodySchema,
  formatWodScheme,
  formatWodScore,
  formatWodTime,
} from './wods.js'

const FRAN_BODY = {
  wodType: 'for_time' as const,
  rounds: 1,
  schemeRounds: [21, 15, 9],
  movements: [
    { exerciseId: 'fx_seed_thruster', reps: 1, loadKg: 43 },
    { exerciseId: 'fx_seed_pull_up', reps: 1 },
  ],
}

const CINDY_BODY = {
  wodType: 'amrap' as const,
  durationS: 20 * 60,
  movements: [
    { exerciseId: 'fx_seed_pull_up', reps: 5 },
    { exerciseId: 'fx_seed_push_up', reps: 10 },
    { exerciseId: 'fx_seed_air_squat', reps: 15 },
  ],
}

describe('wodBodySchema', () => {
  it('accepts a valid For Time ladder', () => {
    expect(wodBodySchema.safeParse(FRAN_BODY).success).toBe(true)
  })

  it('accepts a valid AMRAP', () => {
    expect(wodBodySchema.safeParse(CINDY_BODY).success).toBe(true)
  })

  it('rejects an AMRAP with duration below 60s or above 90 min', () => {
    expect(wodBodySchema.safeParse({ ...CINDY_BODY, durationS: 30 }).success).toBe(false)
    expect(
      wodBodySchema.safeParse({ ...CINDY_BODY, durationS: 91 * 60 }).success,
    ).toBe(false)
  })

  it('rejects a body with zero or duplicate-shape movements', () => {
    expect(wodBodySchema.safeParse({ ...CINDY_BODY, movements: [] }).success).toBe(false)
  })

  it('accepts a prescribed calorie movement (20 cal Assault Bike)', () => {
    const body = {
      ...FRAN_BODY,
      movements: [{ exerciseId: 'fx_seed_assault_bike', calories: 20 }],
    }
    expect(wodBodySchema.safeParse(body).success).toBe(true)
  })

  it('rejects zero, negative, or fractional calories', () => {
    for (const calories of [0, -5, 12.5]) {
      const body = {
        ...FRAN_BODY,
        movements: [{ exerciseId: 'fx_seed_assault_bike', calories }],
      }
      expect(wodBodySchema.safeParse(body).success).toBe(false)
    }
  })

  it('rejects Infinity / NaN on numeric movement fields', () => {
    const bad = {
      ...FRAN_BODY,
      movements: [{ exerciseId: 'fx_seed_thruster', reps: 1, loadKg: Infinity }],
    }
    expect(wodBodySchema.safeParse(bad).success).toBe(false)

    const nan = {
      ...FRAN_BODY,
      movements: [{ exerciseId: 'fx_seed_thruster', reps: 1, loadKg: NaN }],
    }
    expect(wodBodySchema.safeParse(nan).success).toBe(false)
  })
})

describe('createWodTemplateSchema', () => {
  it('accepts a valid Fran-style template', () => {
    const r = createWodTemplateSchema.safeParse({
      name: 'Fran',
      wodType: 'for_time',
      timeCapS: 600,
      description: '21-15-9 thrusters + pull-ups',
      body: FRAN_BODY,
    })
    expect(r.success).toBe(true)
  })

  it('accepts a valid Cindy-style AMRAP', () => {
    const r = createWodTemplateSchema.safeParse({
      name: 'Cindy',
      wodType: 'amrap',
      timeCapS: CINDY_BODY.durationS, // matches body.durationS
      description: 'AMRAP 20 of 5/10/15',
      body: CINDY_BODY,
    })
    expect(r.success).toBe(true)
  })

  it('rejects mismatch between top-level wodType and body.wodType', () => {
    const r = createWodTemplateSchema.safeParse({
      name: 'Frankenstein',
      wodType: 'amrap',
      body: FRAN_BODY, // says for_time
    })
    expect(r.success).toBe(false)
  })

  it('rejects AMRAP timeCapS that disagrees with body.durationS', () => {
    const r = createWodTemplateSchema.safeParse({
      name: 'Disagreeing Cindy',
      wodType: 'amrap',
      timeCapS: 999, // body.durationS is 1200
      body: CINDY_BODY,
    })
    expect(r.success).toBe(false)
  })

  it('rejects empty / oversized names', () => {
    expect(
      createWodTemplateSchema.safeParse({
        name: '   ',
        wodType: 'for_time',
        body: FRAN_BODY,
      }).success,
    ).toBe(false)
    expect(
      createWodTemplateSchema.safeParse({
        name: 'x'.repeat(81),
        wodType: 'for_time',
        body: FRAN_BODY,
      }).success,
    ).toBe(false)
  })
})

describe('patchWodTemplateSchema', () => {
  it('accepts a name-only patch and a clear-description patch', () => {
    expect(patchWodTemplateSchema.safeParse({ name: 'Fran v2' }).success).toBe(true)
    expect(patchWodTemplateSchema.safeParse({ description: undefined }).success).toBe(true)
    expect(patchWodTemplateSchema.safeParse({ timeCapS: null }).success).toBe(true)
  })
})

describe('formatters', () => {
  it('formatWodScheme covers ladder, plain rounds, AMRAP', () => {
    expect(formatWodScheme(FRAN_BODY)).toBe('21-15-9')
    expect(formatWodScheme(CINDY_BODY)).toBe('20 min AMRAP')
    expect(
      formatWodScheme({
        wodType: 'rounds_for_time',
        rounds: 5,
        movements: [{ exerciseId: 'fx', reps: 10 }],
      }),
    ).toBe('5 rounds for time')
    expect(
      formatWodScheme({
        wodType: 'for_time',
        rounds: 1,
        movements: [{ exerciseId: 'fx', reps: 30 }],
      }),
    ).toBe('For time')
  })

  it('formatWodTime renders m:ss + h:mm:ss', () => {
    expect(formatWodTime(0)).toBe('0:00')
    expect(formatWodTime(5)).toBe('0:05')
    expect(formatWodTime(245)).toBe('4:05')
    expect(formatWodTime(3600)).toBe('1:00:00')
    expect(formatWodTime(3725)).toBe('1:02:05')
    expect(formatWodTime(NaN)).toBe('—')
    expect(formatWodTime(-1)).toBe('—')
  })

  it('formatWodScore renders For Time, AMRAP, and DNF', () => {
    expect(
      formatWodScore({
        wodType: 'for_time',
        templateId: 'wt_fran',
        templateName: 'Fran',
        timeS: 245,
        dnf: false,
        perMovementReps: [45, 45],
        asPrescribed: true,
      }),
    ).toBe('4:05')

    expect(
      formatWodScore({
        wodType: 'for_time',
        templateId: 'wt_fran',
        templateName: 'Fran',
        timeS: null,
        dnf: true,
        perMovementReps: [21, 18],
        asPrescribed: false,
      }),
    ).toBe('DNF (39 reps)')

    expect(
      formatWodScore({
        wodType: 'amrap',
        templateId: 'wt_cindy',
        templateName: 'Cindy',
        completedRounds: 12,
        partialReps: 14,
        totalReps: 12 * 30 + 14,
        perMovementReps: [60, 120, 188],
        asPrescribed: true,
      }),
    ).toBe('12 + 14')

    expect(
      formatWodScore({
        wodType: 'amrap',
        templateId: 'wt_cindy',
        templateName: 'Cindy',
        completedRounds: 12,
        partialReps: 0,
        totalReps: 360,
        perMovementReps: [60, 120, 180],
        asPrescribed: true,
      }),
    ).toBe('12')
  })
})

// ── Benchmark-coverage expansion: new body types + formatters ───────────────

describe('new WOD body types', () => {
  it('accepts a valid EMOM (Chelsea)', () => {
    const body = {
      wodType: 'emom' as const,
      intervalS: 60,
      totalIntervals: 30,
      movements: [
        { exerciseId: 'fx_seed_pull_up', reps: 5 },
        { exerciseId: 'fx_seed_push_up', reps: 10 },
        { exerciseId: 'fx_seed_air_squat', reps: 15 },
      ],
    }
    expect(wodBodySchema.safeParse(body).success).toBe(true)
  })

  it('rejects an EMOM interval under 5s', () => {
    const body = {
      wodType: 'emom' as const,
      intervalS: 2,
      totalIntervals: 30,
      movements: [{ exerciseId: 'fx_seed_pull_up', reps: 5 }],
    }
    expect(wodBodySchema.safeParse(body).success).toBe(false)
  })

  it('accepts a valid interval (Fight Gone Bad) with a calorie station', () => {
    const body = {
      wodType: 'interval' as const,
      rounds: 3,
      workS: 60,
      restBetweenRoundsS: 60,
      movements: [
        { exerciseId: 'fx_seed_wall_ball', reps: 1, loadKg: 9, scoreUnit: 'reps' as const },
        { exerciseId: 'fx_seed_rowing_erg', scoreUnit: 'calories' as const },
      ],
    }
    expect(wodBodySchema.safeParse(body).success).toBe(true)
  })

  it('accepts max_reps_rounds with and without a duration cap', () => {
    const lynne = {
      wodType: 'max_reps_rounds' as const,
      rounds: 5,
      movements: [
        { exerciseId: 'fx_seed_barbell_bench_press', loadBwMultiple: 1, scored: true },
        { exerciseId: 'fx_seed_pull_up', scored: true },
      ],
    }
    const nicole = {
      wodType: 'max_reps_rounds' as const,
      rounds: 6,
      durationS: 1200,
      movements: [
        { exerciseId: 'fx_seed_run', distanceM: 400, scored: false },
        { exerciseId: 'fx_seed_pull_up', scored: true },
      ],
    }
    expect(wodBodySchema.safeParse(lynne).success).toBe(true)
    expect(wodBodySchema.safeParse(nicole).success).toBe(true)
  })

  it('accepts a cumulative for_time ladder and a perMinuteBuyIn', () => {
    const xmas = {
      wodType: 'for_time' as const,
      rounds: 3,
      ladder: 'cumulative' as const,
      movements: [
        { exerciseId: 'fx_seed_sumo_deadlift_high_pull', reps: 1 },
        { exerciseId: 'fx_seed_thruster', reps: 2 },
        { exerciseId: 'fx_seed_push_press', reps: 3 },
      ],
    }
    const kalsu = {
      wodType: 'for_time' as const,
      rounds: 1,
      perMinuteBuyIn: { exerciseId: 'fx_seed_burpee', reps: 5 },
      movements: [{ exerciseId: 'fx_seed_thruster', reps: 100, loadKg: 61 }],
    }
    expect(wodBodySchema.safeParse(xmas).success).toBe(true)
    expect(wodBodySchema.safeParse(kalsu).success).toBe(true)
  })

  it('rejects a cumulative ladder whose rounds disagree with the movement count', () => {
    const bad = {
      wodType: 'for_time' as const,
      rounds: 5, // 3 movements below — must match
      ladder: 'cumulative' as const,
      movements: [
        { exerciseId: 'a', reps: 1 },
        { exerciseId: 'b', reps: 2 },
        { exerciseId: 'c', reps: 3 },
      ],
    }
    expect(wodBodySchema.safeParse(bad).success).toBe(false)
  })

  it('accepts a movement carrying a bodyweight-relative load (Linda)', () => {
    const linda = {
      wodType: 'for_time' as const,
      rounds: 1,
      schemeRounds: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      movements: [
        { exerciseId: 'fx_seed_conventional_deadlift', reps: 1, loadBwMultiple: 1.5 },
        { exerciseId: 'fx_seed_barbell_bench_press', reps: 1, loadBwMultiple: 1 },
        { exerciseId: 'fx_seed_squat_clean', reps: 1, loadBwMultiple: 0.75 },
      ],
    }
    expect(wodBodySchema.safeParse(linda).success).toBe(true)
  })
})

describe('formatWodScheme / formatWodScore for new types', () => {
  it('labels the new scheme types', () => {
    expect(
      formatWodScheme({
        wodType: 'emom',
        intervalS: 60,
        totalIntervals: 30,
        movements: [{ exerciseId: 'x', reps: 5 }],
      }),
    ).toBe('EMOM 30')
    expect(
      formatWodScheme({
        wodType: 'interval',
        rounds: 3,
        workS: 60,
        movements: [{ exerciseId: 'x' }],
      }),
    ).toBe('3 rounds')
    expect(
      formatWodScheme({
        wodType: 'max_reps_rounds',
        rounds: 5,
        movements: [{ exerciseId: 'x', scored: true }],
      }),
    ).toBe('5 rounds max reps')
  })

  it('formats the new score shapes', () => {
    expect(
      formatWodScore({
        wodType: 'emom',
        templateId: null,
        templateName: 'Chelsea',
        intervalsCompleted: 22,
        totalIntervals: 30,
        dnf: true,
        perMovementReps: [],
        asPrescribed: true,
      }),
    ).toBe('22/30')
    expect(
      formatWodScore({
        wodType: 'interval',
        templateId: null,
        templateName: 'FGB',
        roundStationScores: [],
        totalScore: 312,
        perMovementReps: [],
        asPrescribed: true,
      }),
    ).toBe('312 pts')
    expect(
      formatWodScore({
        wodType: 'max_reps_rounds',
        templateId: null,
        templateName: 'Lynne',
        roundMovementReps: [],
        totalReps: 88,
        perMovementReps: [],
        asPrescribed: true,
      }),
    ).toBe('88 reps')
  })
})

describe('strengthBodySchema restS', () => {
  const block = {
    exerciseId: 'fx_seed_back_squat',
    name: 'Back squat',
    sets: [{ reps: 5, loadKg: 100 }],
  }

  it('accepts a block without restS (legacy bodies stay valid)', () => {
    expect(
      strengthBodySchema.safeParse({ kind: 'strength', blocks: [block] }).success,
    ).toBe(true)
  })

  it('accepts a block with an in-range restS', () => {
    expect(
      strengthBodySchema.safeParse({
        kind: 'strength',
        blocks: [{ ...block, restS: 120 }],
      }).success,
    ).toBe(true)
  })

  it('accepts restS of 0 (no rest prescribed)', () => {
    expect(
      strengthBodySchema.safeParse({
        kind: 'strength',
        blocks: [{ ...block, restS: 0 }],
      }).success,
    ).toBe(true)
  })

  it('rejects restS above 600s, negative, or fractional', () => {
    for (const restS of [601, -1, 90.5]) {
      expect(
        strengthBodySchema.safeParse({
          kind: 'strength',
          blocks: [{ ...block, restS }],
        }).success,
      ).toBe(false)
    }
  })
})

describe('strength builder block fields (composer Builder)', () => {
  const block = {
    exerciseId: 'fx_seed_back_squat',
    name: 'Back squat',
    sets: [{ reps: 5, loadKg: 100 }],
  }
  const body = (blocks: unknown[]) =>
    strengthBodySchema.safeParse({ kind: 'strength', blocks })

  it('accepts group / kind / restAfterS / per-set rpe', () => {
    expect(
      body([
        {
          ...block,
          group: 'A',
          kind: 'load',
          restAfterS: 150,
          restS: 60,
          sets: [{ reps: 5, loadKg: 100, rpe: 8.5 }],
        },
        { ...block, name: 'Pull-up', exerciseId: 'fx_seed_pull_up', group: 'A', kind: 'body' },
      ]).success,
    ).toBe(true)
  })

  it('accepts null group (explicit ungroup) and absent fields (legacy)', () => {
    expect(body([{ ...block, group: null }]).success).toBe(true)
    expect(body([block]).success).toBe(true)
  })

  it('rejects out-of-range rpe and non-half-point steps', () => {
    for (const rpe of [0.5, 10.5, 7.25]) {
      expect(body([{ ...block, sets: [{ reps: 5, rpe }] }]).success).toBe(false)
    }
  })

  it('rejects a group key longer than 4 chars and an unknown kind', () => {
    expect(body([{ ...block, group: 'ABCDE' }]).success).toBe(false)
    expect(body([{ ...block, kind: 'barbell' }]).success).toBe(false)
  })

  it('rejects restAfterS outside 0–600 or fractional', () => {
    for (const restAfterS of [-1, 601, 45.5]) {
      expect(body([{ ...block, restAfterS }]).success).toBe(false)
    }
  })

  it('accepts intraRestS in 0–600, rejects out-of-range/fractional', () => {
    expect(body([{ ...block, group: 'A', intraRestS: 0 }]).success).toBe(true)
    expect(body([{ ...block, group: 'A', intraRestS: 600 }]).success).toBe(true)
    for (const intraRestS of [-1, 601, 30.5]) {
      expect(body([{ ...block, group: 'A', intraRestS }]).success).toBe(false)
    }
    // Legacy bodies without the field still parse.
    expect(body([{ ...block, group: 'A' }]).success).toBe(true)
  })
})

describe('patchWodTemplateSchema wod-body edits', () => {
  it('accepts a wod body + wodType patch (custom-row structural edit)', () => {
    expect(
      patchWodTemplateSchema.safeParse({
        wodType: 'amrap',
        body: {
          wodType: 'amrap',
          durationS: 1200,
          movements: [{ exerciseId: 'fx_seed_pull_up', reps: 5 }],
        },
      }).success,
    ).toBe(true)
  })

  it('still accepts a strength body patch', () => {
    expect(
      patchWodTemplateSchema.safeParse({
        body: {
          kind: 'strength',
          blocks: [
            { exerciseId: 'fx', name: 'Squat', sets: [{ reps: 5, loadKg: 100, rpe: 8 }] },
          ],
        },
      }).success,
    ).toBe(true)
  })

  it('rejects a malformed wod body', () => {
    expect(
      patchWodTemplateSchema.safeParse({
        body: { wodType: 'amrap', movements: [] },
      }).success,
    ).toBe(false)
  })
})

describe('strengthSetTargetSchema work units', () => {
  function body(sets: unknown[]) {
    return {
      kind: 'strength',
      blocks: [{ exerciseId: 'fx_seed_assault_bike', name: 'Assault Bike', sets }],
    }
  }

  it('accepts calorie / distance / time set targets', () => {
    expect(strengthBodySchema.safeParse(body([{ calories: 15 }])).success).toBe(true)
    expect(strengthBodySchema.safeParse(body([{ distanceM: 500 }])).success).toBe(true)
    expect(strengthBodySchema.safeParse(body([{ timeS: 120 }])).success).toBe(true)
  })

  it('legacy reps × load targets stay valid', () => {
    expect(strengthBodySchema.safeParse(body([{ reps: 5, loadKg: 100 }])).success).toBe(true)
  })

  it('accepts rpe alongside exactly one unit (rpe is orthogonal)', () => {
    expect(strengthBodySchema.safeParse(body([{ reps: 5, rpe: 8 }])).success).toBe(true)
    expect(strengthBodySchema.safeParse(body([{ calories: 15, rpe: 8 }])).success).toBe(true)
  })

  it('rejects a set with no work unit or with two', () => {
    expect(strengthBodySchema.safeParse(body([{ loadKg: 100 }])).success).toBe(false)
    expect(strengthBodySchema.safeParse(body([{ reps: 5, calories: 15 }])).success).toBe(false)
  })

  it('rejects zero or fractional calories', () => {
    expect(strengthBodySchema.safeParse(body([{ calories: 0 }])).success).toBe(false)
    expect(strengthBodySchema.safeParse(body([{ calories: 12.5 }])).success).toBe(false)
  })

  describe('running (distance + time + incline) sets', () => {
    it('accepts distance and time together ("5 km in 30:00")', () => {
      expect(
        strengthBodySchema.safeParse(body([{ distanceM: 5000, timeS: 1800 }])).success,
      ).toBe(true)
    })
    it('accepts inclinePct alongside distance and/or time work', () => {
      expect(
        strengthBodySchema.safeParse(body([{ distanceM: 5000, inclinePct: 2 }])).success,
      ).toBe(true)
      expect(
        strengthBodySchema.safeParse(body([{ timeS: 600, inclinePct: 12.5 }])).success,
      ).toBe(true)
      expect(
        strengthBodySchema.safeParse(
          body([{ distanceM: 8046.7, timeS: 3600, inclinePct: 1, rpe: 7 }]),
        ).success,
      ).toBe(true)
    })
    it('rejects inclinePct on rep / calorie work', () => {
      expect(strengthBodySchema.safeParse(body([{ reps: 5, inclinePct: 2 }])).success).toBe(false)
      expect(
        strengthBodySchema.safeParse(body([{ calories: 15, inclinePct: 2 }])).success,
      ).toBe(false)
    })
    it('rejects out-of-range or non-finite incline', () => {
      expect(
        strengthBodySchema.safeParse(body([{ distanceM: 5000, inclinePct: -1 }])).success,
      ).toBe(false)
      expect(
        strengthBodySchema.safeParse(body([{ distanceM: 5000, inclinePct: 101 }])).success,
      ).toBe(false)
      expect(
        strengthBodySchema.safeParse(body([{ distanceM: 5000, inclinePct: Infinity }])).success,
      ).toBe(false)
    })
    it('still rejects reps or calories mixed with distance/time', () => {
      expect(
        strengthBodySchema.safeParse(body([{ reps: 5, distanceM: 5000 }])).success,
      ).toBe(false)
      expect(
        strengthBodySchema.safeParse(body([{ calories: 15, timeS: 600 }])).success,
      ).toBe(false)
    })
  })

  describe('max-effort (amrap) sets', () => {
    it('accepts an amrap set with no work unit at all', () => {
      expect(strengthBodySchema.safeParse(body([{ amrap: true }])).success).toBe(true)
      expect(strengthBodySchema.safeParse(body([{ amrap: true, loadKg: 100 }])).success).toBe(true)
    })
    it('accepts an amrap set with a rep hint', () => {
      expect(strengthBodySchema.safeParse(body([{ amrap: true, reps: 12 }])).success).toBe(true)
    })
    it('rejects an amrap set prescribed in a non-rep unit', () => {
      expect(strengthBodySchema.safeParse(body([{ amrap: true, calories: 15 }])).success).toBe(false)
      expect(strengthBodySchema.safeParse(body([{ amrap: true, timeS: 60 }])).success).toBe(false)
    })
    it('amrap: false behaves exactly like an absent flag', () => {
      expect(strengthBodySchema.safeParse(body([{ amrap: false }])).success).toBe(false)
      expect(strengthBodySchema.safeParse(body([{ amrap: false, reps: 5 }])).success).toBe(true)
    })
  })
})
