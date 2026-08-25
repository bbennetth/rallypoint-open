// Unit tests for exercise-view pure helpers. No DOM, no React, no network.
import { describe, it, expect } from 'vitest'
import {
  buildMuscleIndex,
  summarizePrimaryMuscleGroups,
  groupMusclesByRole,
  buildCreatePayload,
  groupToPrimaryMuscleId,
  buildMusclesPayload,
  buildMusclesPayloadV2,
  primaryGroupIdForMuscles,
  primaryMuscleIdForMuscles,
  secondaryGroupIdsForMuscles,
  secondaryMuscleIdsForMuscles,
  disciplineLabel,
  movementPatternLabel,
  metricShapeLabel,
  muscleRoleLabel,
} from './exercise-view.js'
import type { MuscleGroupDto } from './api.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GROUPS: MuscleGroupDto[] = [
  {
    id: 'leg',
    name: 'Legs',
    sort: 1,
    muscles: [
      { id: 'quads', name: 'Quads', sort: 1 },
      { id: 'hamstrings', name: 'Hamstrings', sort: 2 },
      { id: 'glutes', name: 'Glutes', sort: 3 },
    ],
  },
  {
    id: 'back',
    name: 'Back',
    sort: 2,
    muscles: [
      { id: 'lats', name: 'Lats', sort: 1 },
      { id: 'traps', name: 'Traps', sort: 2 },
    ],
  },
]

// ── buildMuscleIndex ──────────────────────────────────────────────────────────

describe('buildMuscleIndex', () => {
  it('maps every muscle id to its dto + group info', () => {
    const index = buildMuscleIndex(GROUPS)
    // 5 fixture muscles + 2 legacy aliases (rhomboids→traps, adductors→glutes).
    expect(index.size).toBe(7)
    const quads = index.get('quads')
    expect(quads?.name).toBe('Quads')
    expect(quads?.groupId).toBe('leg')
    expect(quads?.groupName).toBe('Legs')
  })

  it('returns an empty map for empty groups', () => {
    expect(buildMuscleIndex([]).size).toBe(0)
  })

  it('aliases retired pre-0029 slugs to their replacement entry', () => {
    const index = buildMuscleIndex(GROUPS)
    // rhomboids → traps per LEGACY_MUSCLE_REMAP; traps is in the fixture.
    expect(index.get('rhomboids')).toBe(index.get('traps'))
    // chest → chest replacement isn't in this fixture — no phantom entry.
    expect(index.has('chest_upper')).toBe(false)
  })
})

// ── summarizePrimaryMuscleGroups ──────────────────────────────────────────────

describe('summarizePrimaryMuscleGroups', () => {
  const index = buildMuscleIndex(GROUPS)

  it('returns only primary-role groups', () => {
    const muscles = [
      { muscleId: 'quads', role: 'primary' as const },
      { muscleId: 'hamstrings', role: 'secondary' as const },
      { muscleId: 'glutes', role: 'stabilizer' as const },
    ]
    const summary = summarizePrimaryMuscleGroups(muscles, index)
    expect(summary).toHaveLength(1)
    expect(summary[0]!.groupName).toBe('Legs')
    expect(summary[0]!.primaryNames).toEqual(['Quads'])
  })

  it('groups multiple primary muscles in the same group', () => {
    const muscles = [
      { muscleId: 'quads', role: 'primary' as const },
      { muscleId: 'hamstrings', role: 'primary' as const },
    ]
    const summary = summarizePrimaryMuscleGroups(muscles, index)
    expect(summary).toHaveLength(1)
    expect(summary[0]!.primaryNames).toEqual(expect.arrayContaining(['Quads', 'Hamstrings']))
  })

  it('returns groups from multiple muscle groups', () => {
    const muscles = [
      { muscleId: 'quads', role: 'primary' as const },
      { muscleId: 'lats', role: 'primary' as const },
    ]
    const summary = summarizePrimaryMuscleGroups(muscles, index)
    const names = summary.map((s) => s.groupName)
    expect(names).toContain('Legs')
    expect(names).toContain('Back')
  })

  it('silently skips unknown muscle ids', () => {
    const muscles = [{ muscleId: 'unknown_muscle', role: 'primary' as const }]
    expect(summarizePrimaryMuscleGroups(muscles, index)).toHaveLength(0)
  })

  it('returns empty array for no muscles', () => {
    expect(summarizePrimaryMuscleGroups([], index)).toHaveLength(0)
  })
})

// ── groupMusclesByRole ────────────────────────────────────────────────────────

describe('groupMusclesByRole', () => {
  const index = buildMuscleIndex(GROUPS)

  it('splits muscles into correct role buckets', () => {
    const muscles = [
      { muscleId: 'quads', role: 'primary' as const },
      { muscleId: 'hamstrings', role: 'secondary' as const },
      { muscleId: 'glutes', role: 'stabilizer' as const },
    ]
    const map = groupMusclesByRole(muscles, index)
    expect(map.primary).toHaveLength(1)
    expect(map.primary[0]!.muscleName).toBe('Quads')
    expect(map.secondary[0]!.muscleName).toBe('Hamstrings')
    expect(map.stabilizer[0]!.muscleName).toBe('Glutes')
  })

  it('uses raw muscleId as name for unknown muscles', () => {
    const muscles = [{ muscleId: 'mystery_muscle', role: 'primary' as const }]
    const map = groupMusclesByRole(muscles, index)
    expect(map.primary[0]!.muscleName).toBe('mystery_muscle')
  })

  it('returns empty buckets when no muscles given', () => {
    const map = groupMusclesByRole([], index)
    expect(map.primary).toHaveLength(0)
    expect(map.secondary).toHaveLength(0)
    expect(map.stabilizer).toHaveLength(0)
  })
})

// ── buildCreatePayload ────────────────────────────────────────────────────────

describe('buildCreatePayload', () => {
  const validForm = {
    name: '  Front Squat  ',
    discipline: 'barbell',
    movementPattern: 'squat',
    metricShape: 'load_reps',
    unilateral: false,
    muscles: [{ muscleId: 'quads', role: 'primary' as const }],
  }

  it('returns trimmed payload for a valid form', () => {
    const payload = buildCreatePayload(validForm)
    expect(payload).not.toBeNull()
    expect(payload?.name).toBe('Front Squat')
    expect(payload?.discipline).toBe('barbell')
    expect(payload?.muscles).toHaveLength(1)
  })

  it('returns null when name is blank', () => {
    expect(buildCreatePayload({ ...validForm, name: '   ' })).toBeNull()
  })

  it('returns null when discipline is missing', () => {
    expect(buildCreatePayload({ ...validForm, discipline: '' })).toBeNull()
  })

  it('returns null when movementPattern is missing', () => {
    expect(buildCreatePayload({ ...validForm, movementPattern: '' })).toBeNull()
  })

  it('returns null when metricShape is missing', () => {
    expect(buildCreatePayload({ ...validForm, metricShape: '' })).toBeNull()
  })

  it('passes through unilateral flag', () => {
    const payload = buildCreatePayload({ ...validForm, unilateral: true })
    expect(payload?.unilateral).toBe(true)
  })
})

// ── groupToPrimaryMuscleId ──────────────────────────────────────────────────

describe('groupToPrimaryMuscleId', () => {
  it('returns the lowest-sort muscle in the group', () => {
    expect(groupToPrimaryMuscleId(GROUPS[0]!)).toBe('quads')
    expect(groupToPrimaryMuscleId(GROUPS[1]!)).toBe('lats')
  })

  it('picks the lowest sort even if muscles are out of order', () => {
    const scrambled: MuscleGroupDto = {
      id: 'arm',
      name: 'Arms',
      sort: 3,
      muscles: [
        { id: 'triceps', name: 'Triceps', sort: 2 },
        { id: 'biceps', name: 'Biceps', sort: 1 },
      ],
    }
    expect(groupToPrimaryMuscleId(scrambled)).toBe('biceps')
  })

  it('returns null for a group with no muscles', () => {
    expect(groupToPrimaryMuscleId({ id: 'empty', name: 'Empty', sort: 9, muscles: [] })).toBeNull()
  })
})

// ── buildMusclesPayload ──────────────────────────────────────────────────────

describe('buildMusclesPayload', () => {
  it('maps a primary group to its representative muscle', () => {
    const payload = buildMusclesPayload({
      primaryGroupId: 'leg',
      secondaryGroupIds: [],
      groups: GROUPS,
    })
    expect(payload).toEqual([{ muscleId: 'quads', role: 'primary' }])
  })

  it('maps secondary groups after the primary', () => {
    const payload = buildMusclesPayload({
      primaryGroupId: 'leg',
      secondaryGroupIds: ['back'],
      groups: GROUPS,
    })
    expect(payload).toEqual([
      { muscleId: 'quads', role: 'primary' },
      { muscleId: 'lats', role: 'secondary' },
    ])
  })

  it('returns an empty array when nothing is selected', () => {
    expect(buildMusclesPayload({ primaryGroupId: null, secondaryGroupIds: [], groups: GROUPS })).toEqual(
      [],
    )
  })

  it('ignores an unknown group id', () => {
    const payload = buildMusclesPayload({
      primaryGroupId: 'not_a_group',
      secondaryGroupIds: ['also_not_a_group'],
      groups: GROUPS,
    })
    expect(payload).toEqual([])
  })

  it('dedupes when a secondary group would repeat the primary muscle', () => {
    const oneMuscleGroups: MuscleGroupDto[] = [
      { id: 'a', name: 'A', sort: 1, muscles: [{ id: 'shared', name: 'Shared', sort: 1 }] },
      { id: 'b', name: 'B', sort: 2, muscles: [{ id: 'shared', name: 'Shared', sort: 1 }] },
    ]
    const payload = buildMusclesPayload({
      primaryGroupId: 'a',
      secondaryGroupIds: ['b'],
      groups: oneMuscleGroups,
    })
    expect(payload).toEqual([{ muscleId: 'shared', role: 'primary' }])
  })
})

// ── primaryGroupIdForMuscles / secondaryGroupIdsForMuscles ──────────────────

// ── buildMusclesPayloadV2 ────────────────────────────────────────────────────

describe('buildMusclesPayloadV2', () => {
  it('uses the specific primary pick when it belongs to the primary group', () => {
    const payload = buildMusclesPayloadV2({
      primaryGroupId: 'leg',
      primaryMuscleId: 'glutes',
      secondaryGroupIds: [],
      secondaryMuscleIds: [],
      groups: GROUPS,
    })
    expect(payload).toEqual([{ muscleId: 'glutes', role: 'primary' }])
  })

  it('falls back to the group representative when no specific pick is made', () => {
    const payload = buildMusclesPayloadV2({
      primaryGroupId: 'leg',
      primaryMuscleId: null,
      secondaryGroupIds: [],
      secondaryMuscleIds: [],
      groups: GROUPS,
    })
    // Same behavior as the group-only builder.
    expect(payload).toEqual(
      buildMusclesPayload({ primaryGroupId: 'leg', secondaryGroupIds: [], groups: GROUPS }),
    )
  })

  it('ignores a stale primary pick from a different group', () => {
    const payload = buildMusclesPayloadV2({
      primaryGroupId: 'back',
      primaryMuscleId: 'quads', // stale — belongs to leg
      secondaryGroupIds: [],
      secondaryMuscleIds: [],
      groups: GROUPS,
    })
    expect(payload).toEqual([{ muscleId: 'lats', role: 'primary' }])
  })

  it('emits every specific secondary pick within its selected group', () => {
    const payload = buildMusclesPayloadV2({
      primaryGroupId: 'leg',
      primaryMuscleId: 'quads',
      secondaryGroupIds: ['back'],
      secondaryMuscleIds: ['lats', 'traps'],
      groups: GROUPS,
    })
    expect(payload).toEqual([
      { muscleId: 'quads', role: 'primary' },
      { muscleId: 'lats', role: 'secondary' },
      { muscleId: 'traps', role: 'secondary' },
    ])
  })

  it('secondary group without picks falls back to its representative', () => {
    const payload = buildMusclesPayloadV2({
      primaryGroupId: null,
      primaryMuscleId: null,
      secondaryGroupIds: ['back'],
      secondaryMuscleIds: [],
      groups: GROUPS,
    })
    expect(payload).toEqual([{ muscleId: 'lats', role: 'secondary' }])
  })

  it('dedupes against the primary — primary role wins', () => {
    const payload = buildMusclesPayloadV2({
      primaryGroupId: 'leg',
      primaryMuscleId: 'quads',
      secondaryGroupIds: ['leg'],
      secondaryMuscleIds: ['quads', 'hamstrings'],
      groups: GROUPS,
    })
    expect(payload).toEqual([
      { muscleId: 'quads', role: 'primary' },
      { muscleId: 'hamstrings', role: 'secondary' },
    ])
  })

  it('returns [] when nothing is selected', () => {
    expect(
      buildMusclesPayloadV2({
        primaryGroupId: null,
        primaryMuscleId: null,
        secondaryGroupIds: [],
        secondaryMuscleIds: [],
        groups: GROUPS,
      }),
    ).toEqual([])
  })
})

// ── muscle-level prefill helpers ─────────────────────────────────────────────

describe('primaryMuscleIdForMuscles / secondaryMuscleIdsForMuscles', () => {
  const index = buildMuscleIndex(GROUPS)

  it('returns the primary muscle id when known to the taxonomy', () => {
    expect(
      primaryMuscleIdForMuscles(
        [
          { muscleId: 'glutes', role: 'primary' },
          { muscleId: 'lats', role: 'secondary' },
        ],
        index,
      ),
    ).toBe('glutes')
  })

  it('returns null for an unknown or absent primary', () => {
    expect(primaryMuscleIdForMuscles([{ muscleId: 'mystery', role: 'primary' }], index)).toBeNull()
    expect(primaryMuscleIdForMuscles([{ muscleId: 'lats', role: 'secondary' }], index)).toBeNull()
  })

  it('returns known secondary ids only', () => {
    expect(
      secondaryMuscleIdsForMuscles(
        [
          { muscleId: 'quads', role: 'primary' },
          { muscleId: 'lats', role: 'secondary' },
          { muscleId: 'mystery', role: 'secondary' },
          { muscleId: 'traps', role: 'stabilizer' },
        ],
        index,
      ),
    ).toEqual(['lats'])
  })
})

describe('primaryGroupIdForMuscles', () => {
  const index = buildMuscleIndex(GROUPS)

  it('finds the group containing the primary-role muscle', () => {
    const muscles = [
      { muscleId: 'quads', role: 'primary' as const },
      { muscleId: 'lats', role: 'secondary' as const },
    ]
    expect(primaryGroupIdForMuscles(muscles, index)).toBe('leg')
  })

  it('returns null when there is no primary muscle', () => {
    expect(primaryGroupIdForMuscles([], index)).toBeNull()
  })

  it('returns null for an unknown primary muscle id', () => {
    expect(primaryGroupIdForMuscles([{ muscleId: 'ghost', role: 'primary' }], index)).toBeNull()
  })
})

describe('secondaryGroupIdsForMuscles', () => {
  const index = buildMuscleIndex(GROUPS)

  it('returns distinct groups for secondary-role muscles', () => {
    const muscles = [
      { muscleId: 'quads', role: 'primary' as const },
      { muscleId: 'hamstrings', role: 'secondary' as const },
      { muscleId: 'lats', role: 'secondary' as const },
    ]
    expect(secondaryGroupIdsForMuscles(muscles, index)).toEqual(['leg', 'back'])
  })

  it('dedupes multiple secondary muscles in the same group', () => {
    const muscles = [
      { muscleId: 'hamstrings', role: 'secondary' as const },
      { muscleId: 'glutes', role: 'secondary' as const },
    ]
    expect(secondaryGroupIdsForMuscles(muscles, index)).toEqual(['leg'])
  })

  it('caps at 3 groups', () => {
    const many: MuscleGroupDto[] = [
      { id: 'g1', name: 'G1', sort: 1, muscles: [{ id: 'm1', name: 'M1', sort: 1 }] },
      { id: 'g2', name: 'G2', sort: 2, muscles: [{ id: 'm2', name: 'M2', sort: 1 }] },
      { id: 'g3', name: 'G3', sort: 3, muscles: [{ id: 'm3', name: 'M3', sort: 1 }] },
      { id: 'g4', name: 'G4', sort: 4, muscles: [{ id: 'm4', name: 'M4', sort: 1 }] },
    ]
    const manyIndex = buildMuscleIndex(many)
    const muscles = [
      { muscleId: 'm1', role: 'secondary' as const },
      { muscleId: 'm2', role: 'secondary' as const },
      { muscleId: 'm3', role: 'secondary' as const },
      { muscleId: 'm4', role: 'secondary' as const },
    ]
    expect(secondaryGroupIdsForMuscles(muscles, manyIndex)).toEqual(['g1', 'g2', 'g3'])
  })

  it('returns empty array when there are no secondary muscles', () => {
    expect(secondaryGroupIdsForMuscles([], index)).toEqual([])
  })
})

// ── label formatters ──────────────────────────────────────────────────────────

describe('disciplineLabel', () => {
  it('maps known slugs', () => {
    expect(disciplineLabel('barbell')).toBe('Barbell')
    expect(disciplineLabel('bodyweight')).toBe('Bodyweight')
    expect(disciplineLabel('gymnastics')).toBe('Gymnastics')
  })
  it('falls back to raw slug for unknown values', () => {
    expect(disciplineLabel('unknown_discipline')).toBe('unknown_discipline')
  })
})

describe('movementPatternLabel', () => {
  it('maps known slugs with underscores', () => {
    expect(movementPatternLabel('horizontal_push')).toBe('Horizontal Push')
    expect(movementPatternLabel('vertical_pull')).toBe('Vertical Pull')
    expect(movementPatternLabel('squat')).toBe('Squat')
  })
  it('falls back to raw slug for unknown values', () => {
    expect(movementPatternLabel('unknown_pattern')).toBe('unknown_pattern')
  })
})

describe('metricShapeLabel', () => {
  it('maps known slugs', () => {
    expect(metricShapeLabel('load_reps')).toBe('Load × Reps')
    expect(metricShapeLabel('distance_time')).toBe('Distance + Time')
    expect(metricShapeLabel('rounds_reps')).toBe('Rounds / Reps')
    expect(metricShapeLabel('duration')).toBe('Duration')
  })
  it('falls back to raw slug for unknown values', () => {
    expect(metricShapeLabel('unknown')).toBe('unknown')
  })
})

describe('muscleRoleLabel', () => {
  it('maps known roles', () => {
    expect(muscleRoleLabel('primary')).toBe('Primary')
    expect(muscleRoleLabel('secondary')).toBe('Secondary')
    expect(muscleRoleLabel('stabilizer')).toBe('Stabilizer')
  })
  it('falls back for unknown', () => {
    expect(muscleRoleLabel('unknown')).toBe('unknown')
  })
})
