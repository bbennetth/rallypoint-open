// Pure view-layer helpers for the Exercise Library page. These functions
// contain the non-trivial logic extracted from the page component so it
// can be unit-tested without a DOM or network. All inputs/outputs are
// plain data — no React deps.

import { LEGACY_MUSCLE_REMAP, type ExerciseDto, type MuscleRole } from '@rallypoint/fitness-shared'
import type { MuscleGroupDto, MuscleDto } from './api.js'

// ---------------------------------------------------------------------------
// Muscle taxonomy lookup helpers
// ---------------------------------------------------------------------------

/** Index of muscleId → MuscleDto (flat lookup across all groups). */
export type MuscleIndex = Map<string, MuscleDto & { groupId: string; groupName: string }>

/** Build a flat muscleId → muscle+group index from the API muscle-groups
 * response. Retired slugs (pre-0030 taxonomy) alias to their replacement
 * entry so exercises from an old offline cache still resolve names/groups. */
export function buildMuscleIndex(groups: MuscleGroupDto[]): MuscleIndex {
  const index: MuscleIndex = new Map()
  for (const group of groups) {
    for (const muscle of group.muscles) {
      index.set(muscle.id, { ...muscle, groupId: group.id, groupName: group.name })
    }
  }
  for (const [legacyId, currentId] of Object.entries(LEGACY_MUSCLE_REMAP)) {
    const target = index.get(currentId)
    if (target && !index.has(legacyId)) index.set(legacyId, target)
  }
  return index
}

// ---------------------------------------------------------------------------
// Row-level muscle summary
// ---------------------------------------------------------------------------

export interface MuscleGroupSummary {
  /** Muscle group name, e.g. "Legs" */
  groupName: string
  /** Primary muscle names within this group on this exercise */
  primaryNames: string[]
}

/**
 * For a list-row summary: returns the distinct muscle group names for
 * primary-role muscles, with the specific muscle names per group.
 * Secondary / stabilizer muscles are omitted from the summary to keep it
 * scannable — the full map appears in the detail drawer.
 */
export function summarizePrimaryMuscleGroups(
  muscles: ExerciseDto['muscles'],
  index: MuscleIndex,
): MuscleGroupSummary[] {
  const byGroup = new Map<string, MuscleGroupSummary>()
  for (const { muscleId, role } of muscles) {
    if (role !== 'primary') continue
    const m = index.get(muscleId)
    if (!m) continue
    const existing = byGroup.get(m.groupId)
    if (existing) {
      existing.primaryNames.push(m.name)
    } else {
      byGroup.set(m.groupId, { groupName: m.groupName, primaryNames: [m.name] })
    }
  }
  return Array.from(byGroup.values())
}

// ---------------------------------------------------------------------------
// Detail-drawer muscle map grouped by role
// ---------------------------------------------------------------------------

export interface MuscleEntry {
  muscleId: string
  muscleName: string
  groupName: string
}

export interface MuscleMapByRole {
  primary: MuscleEntry[]
  secondary: MuscleEntry[]
  stabilizer: MuscleEntry[]
}

/**
 * Group exercise muscles by role, resolving each muscleId to its name + group.
 * Unknown muscleIds (not in the index) are included with the raw id as the name
 * so missing taxonomy never silently drops a mapping.
 */
export function groupMusclesByRole(
  muscles: ExerciseDto['muscles'],
  index: MuscleIndex,
): MuscleMapByRole {
  const result: MuscleMapByRole = { primary: [], secondary: [], stabilizer: [] }
  for (const { muscleId, role } of muscles) {
    const m = index.get(muscleId)
    const entry: MuscleEntry = {
      muscleId,
      muscleName: m?.name ?? muscleId,
      groupName: m?.groupName ?? '',
    }
    result[role as MuscleRole].push(entry)
  }
  return result
}

// ---------------------------------------------------------------------------
// Create-form payload builder
// ---------------------------------------------------------------------------

export interface MuscleMapEntry {
  muscleId: string
  role: MuscleRole
}

export interface CreateFormState {
  name: string
  discipline: string
  movementPattern: string
  metricShape: string
  unilateral: boolean
  muscles: MuscleMapEntry[]
}

/**
 * Build a validated create-exercise payload from the form state.
 * Returns null if the required fields are missing (so the submit handler can
 * guard without duplicating validation logic in the component).
 */
export function buildCreatePayload(
  form: CreateFormState,
): {
  name: string
  discipline: string
  movementPattern: string
  metricShape: string
  unilateral: boolean
  muscles: MuscleMapEntry[]
} | null {
  const name = form.name.trim()
  if (!name || !form.discipline || !form.movementPattern || !form.metricShape) return null
  return {
    name,
    discipline: form.discipline,
    movementPattern: form.movementPattern,
    metricShape: form.metricShape,
    unilateral: form.unilateral,
    muscles: form.muscles,
  }
}

// ---------------------------------------------------------------------------
// Group-level muscle picker (add/edit exercise form)
// ---------------------------------------------------------------------------

/**
 * The muscle taxonomy is muscle-level, but the add/edit exercise form picks
 * at group granularity (simpler UX than picking an exact muscle). This maps
 * a group to a single representative muscle — the first by sort order — so
 * a group-level selection still produces a valid per-muscle payload.
 */
export function groupToPrimaryMuscleId(group: MuscleGroupDto): string | null {
  if (group.muscles.length === 0) return null
  const sorted = [...group.muscles].sort((a, b) => a.sort - b.sort)
  return sorted[0]!.id
}

export interface MusclesPayloadInput {
  primaryGroupId: string | null
  secondaryGroupIds: string[]
  groups: MuscleGroupDto[]
}

/**
 * Build the create/patch `muscles` payload from a group-level picker
 * selection: one primary group + up to 3 secondary groups. Each group
 * resolves to its representative muscle id. Duplicate muscle ids (e.g. two
 * groups sharing a representative — shouldn't happen with a sane taxonomy,
 * but guarded anyway) are deduped, with the primary role winning.
 */
export function buildMusclesPayload({
  primaryGroupId,
  secondaryGroupIds,
  groups,
}: MusclesPayloadInput): MuscleMapEntry[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const result: MuscleMapEntry[] = []
  const seen = new Set<string>()

  const primaryGroup = primaryGroupId ? byId.get(primaryGroupId) : undefined
  const primaryMuscleId = primaryGroup ? groupToPrimaryMuscleId(primaryGroup) : null
  if (primaryMuscleId) {
    result.push({ muscleId: primaryMuscleId, role: 'primary' })
    seen.add(primaryMuscleId)
  }

  for (const groupId of secondaryGroupIds) {
    const group = byId.get(groupId)
    const muscleId = group ? groupToPrimaryMuscleId(group) : null
    if (!muscleId || seen.has(muscleId)) continue
    result.push({ muscleId, role: 'secondary' })
    seen.add(muscleId)
  }

  return result
}

// ---------------------------------------------------------------------------
// Muscle-level picker (progressive disclosure under the group chips)
// ---------------------------------------------------------------------------

export interface MusclesPayloadV2Input {
  primaryGroupId: string | null
  /** Specific primary muscle pick; null keeps the group's representative. */
  primaryMuscleId: string | null
  secondaryGroupIds: string[]
  /** Specific secondary muscle picks (any group); empty = representatives. */
  secondaryMuscleIds: string[]
  groups: MuscleGroupDto[]
}

/**
 * Build the create/patch `muscles` payload from the two-level picker: group
 * chips plus optional specific-muscle chips revealed under each selected
 * group. A specific pick replaces the group's representative muscle; a
 * group with no specific pick falls back to `groupToPrimaryMuscleId`
 * exactly like the group-only builder. Duplicates dedupe with the primary
 * role winning.
 */
export function buildMusclesPayloadV2({
  primaryGroupId,
  primaryMuscleId,
  secondaryGroupIds,
  secondaryMuscleIds,
  groups,
}: MusclesPayloadV2Input): MuscleMapEntry[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const muscleToGroup = new Map<string, string>()
  for (const g of groups) for (const m of g.muscles) muscleToGroup.set(m.id, g.id)

  const result: MuscleMapEntry[] = []
  const seen = new Set<string>()

  const primaryGroup = primaryGroupId ? byId.get(primaryGroupId) : undefined
  // A specific pick only counts if it actually belongs to the primary group
  // (stale state from a group switch must not leak through).
  const primaryPick =
    primaryMuscleId && muscleToGroup.get(primaryMuscleId) === primaryGroupId
      ? primaryMuscleId
      : primaryGroup
        ? groupToPrimaryMuscleId(primaryGroup)
        : null
  if (primaryPick) {
    result.push({ muscleId: primaryPick, role: 'primary' })
    seen.add(primaryPick)
  }

  for (const groupId of secondaryGroupIds) {
    const group = byId.get(groupId)
    if (!group) continue
    const picks = secondaryMuscleIds.filter((id) => muscleToGroup.get(id) === groupId)
    const ids = picks.length > 0 ? picks : [groupToPrimaryMuscleId(group)]
    for (const muscleId of ids) {
      if (!muscleId || seen.has(muscleId)) continue
      result.push({ muscleId, role: 'secondary' })
      seen.add(muscleId)
    }
  }

  return result
}

/** Prefill: the exercise's specific primary muscle id (if known to the taxonomy). */
export function primaryMuscleIdForMuscles(
  muscles: ExerciseDto['muscles'],
  index: MuscleIndex,
): string | null {
  const primary = muscles.find((m) => m.role === 'primary')
  if (!primary) return null
  return index.has(primary.muscleId) ? primary.muscleId : null
}

/** Prefill: the exercise's specific secondary muscle ids (known ones only). */
export function secondaryMuscleIdsForMuscles(
  muscles: ExerciseDto['muscles'],
  index: MuscleIndex,
): string[] {
  return muscles
    .filter((m) => m.role === 'secondary' && index.has(m.muscleId))
    .map((m) => m.muscleId)
}

/** Prefill: which group (if any) contains this exercise's primary muscle. */
export function primaryGroupIdForMuscles(
  muscles: ExerciseDto['muscles'],
  index: MuscleIndex,
): string | null {
  const primary = muscles.find((m) => m.role === 'primary')
  if (!primary) return null
  return index.get(primary.muscleId)?.groupId ?? null
}

/** Prefill: distinct groups (up to 3) containing this exercise's secondary muscles. */
export function secondaryGroupIdsForMuscles(
  muscles: ExerciseDto['muscles'],
  index: MuscleIndex,
): string[] {
  const ids: string[] = []
  for (const m of muscles) {
    if (m.role !== 'secondary') continue
    const groupId = index.get(m.muscleId)?.groupId
    if (groupId && !ids.includes(groupId)) ids.push(groupId)
  }
  return ids.slice(0, 3)
}

// ---------------------------------------------------------------------------
// Label formatters (pure, testable)
// ---------------------------------------------------------------------------

/** Human-readable label for a discipline slug. */
export function disciplineLabel(d: string): string {
  const MAP: Record<string, string> = {
    barbell: 'Barbell',
    dumbbell: 'Dumbbell',
    kettlebell: 'Kettlebell',
    bodyweight: 'Bodyweight',
    machine: 'Machine',
    cable: 'Cable',
    cardio: 'Cardio',
    gymnastics: 'Gymnastics',
  }
  return MAP[d] ?? d
}

/** Human-readable label for a movement-pattern slug. */
export function movementPatternLabel(p: string): string {
  const MAP: Record<string, string> = {
    squat: 'Squat',
    hinge: 'Hinge',
    horizontal_push: 'Horizontal Push',
    vertical_push: 'Vertical Push',
    horizontal_pull: 'Horizontal Pull',
    vertical_pull: 'Vertical Pull',
    lunge: 'Lunge',
    carry: 'Carry',
    gait: 'Gait',
    rotation: 'Rotation',
    core: 'Core',
    olympic: 'Olympic',
    isolation: 'Isolation',
    other: 'Other',
  }
  return MAP[p] ?? p
}

/** Human-readable label for a metric shape slug. */
export function metricShapeLabel(s: string): string {
  const MAP: Record<string, string> = {
    load_reps: 'Load × Reps',
    distance_time: 'Distance + Time',
    rounds_reps: 'Rounds / Reps',
    duration: 'Duration',
  }
  return MAP[s] ?? s
}

/** Human-readable label for a muscle role. */
export function muscleRoleLabel(r: string): string {
  const MAP: Record<string, string> = {
    primary: 'Primary',
    secondary: 'Secondary',
    stabilizer: 'Stabilizer',
  }
  return MAP[r] ?? r
}
