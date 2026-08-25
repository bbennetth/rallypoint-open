// The 2-level, training-practical muscle taxonomy — the single source the
// seed generator emits into muscle_groups + muscles, and the reference the
// API/insights resolve muscle ids against. 6 groups → 14 muscles. Coarse
// enough to be glanceable ("you've neglected hamstrings this month"), fine
// enough to be honest (back split lats/traps/erectors). No anatomical
// sub-heads beyond that — a second brain doesn't need
// vastus-lateralis-vs-rectus-femoris detail. (Collapsed from the original
// 19 in migration 0030: chest_upper/chest_lower → chest,
// front/side/rear_delt → delts, rhomboids → traps, adductors → glutes.)
//
// Slugs are the DB primary keys, so they are STABLE — renaming a slug is a
// breaking change. The display `name` can change freely.

export interface MuscleGroupSeed {
  id: string
  name: string
  sort: number
}

export interface MuscleSeed {
  id: string
  groupId: string
  name: string
  sort: number
}

export const MUSCLE_GROUPS: readonly MuscleGroupSeed[] = [
  { id: 'leg', name: 'Legs', sort: 1 },
  { id: 'back', name: 'Back', sort: 2 },
  { id: 'chest', name: 'Chest', sort: 3 },
  { id: 'shoulder', name: 'Shoulders', sort: 4 },
  { id: 'arm', name: 'Arms', sort: 5 },
  { id: 'core', name: 'Core', sort: 6 },
]

export const MUSCLES: readonly MuscleSeed[] = [
  // Legs
  { id: 'quads', groupId: 'leg', name: 'Quads', sort: 1 },
  { id: 'hamstrings', groupId: 'leg', name: 'Hamstrings', sort: 2 },
  { id: 'glutes', groupId: 'leg', name: 'Glutes', sort: 3 },
  { id: 'calves', groupId: 'leg', name: 'Calves', sort: 4 },
  // Back
  { id: 'lats', groupId: 'back', name: 'Lats', sort: 1 },
  { id: 'traps', groupId: 'back', name: 'Traps', sort: 2 },
  { id: 'erectors', groupId: 'back', name: 'Spinal Erectors', sort: 3 },
  // Chest
  { id: 'chest', groupId: 'chest', name: 'Chest', sort: 1 },
  // Shoulders
  { id: 'delts', groupId: 'shoulder', name: 'Delts', sort: 1 },
  // Arms
  { id: 'biceps', groupId: 'arm', name: 'Biceps', sort: 1 },
  { id: 'triceps', groupId: 'arm', name: 'Triceps', sort: 2 },
  { id: 'forearms', groupId: 'arm', name: 'Forearms', sort: 3 },
  // Core
  { id: 'abs', groupId: 'core', name: 'Abs', sort: 1 },
  { id: 'obliques', groupId: 'core', name: 'Obliques', sort: 2 },
]

// Retired slugs → their replacement, mirroring migration 0030. Kept so old
// cached/offline payloads referencing a retired id can still resolve.
export const LEGACY_MUSCLE_REMAP: Readonly<Record<string, string>> = {
  chest_upper: 'chest',
  chest_lower: 'chest',
  front_delt: 'delts',
  side_delt: 'delts',
  rear_delt: 'delts',
  rhomboids: 'traps',
  adductors: 'glutes',
}

// Lookup sets used by validators/tests to assert seed integrity.
export const MUSCLE_GROUP_IDS: ReadonlySet<string> = new Set(MUSCLE_GROUPS.map((g) => g.id))
export const MUSCLE_IDS: ReadonlySet<string> = new Set(MUSCLES.map((m) => m.id))
