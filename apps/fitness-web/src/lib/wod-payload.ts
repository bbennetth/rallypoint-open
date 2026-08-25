// Shared reader for the `workouts.payload` blob a finished WOD writes (see
// WodSessionPage / RepEntrySession handleSave). Both the history row and the
// detail sheet render this, so the shape + the label/score derivation live
// here in one place rather than being duplicated (and drifting) across the
// two components.

import type { WorkoutDto } from '@rallypoint/fitness-shared'

export interface WodPayload {
  templateName?: string
  wodType?:
    | 'for_time'
    | 'rounds_for_time'
    | 'amrap'
    | 'emom'
    | 'interval'
    | 'max_reps_rounds'
  // For Time / RFT
  timeS?: number | null
  dnf?: boolean
  // AMRAP
  completedRounds?: number
  partialReps?: number
  // EMOM
  intervalsCompleted?: number
  totalIntervals?: number
  // interval
  totalScore?: number
  // max_reps_rounds
  totalReps?: number
}

export function readWodPayload(w: WorkoutDto): WodPayload | null {
  const p = (w.payload as WodPayload | null | undefined) ?? null
  if (!p?.templateName || !p.wodType) return null
  return p
}

// Human label for the WOD type chip / summary line.
export function wodPayloadTypeLabel(p: WodPayload): string {
  switch (p.wodType) {
    case 'amrap':
      return 'AMRAP'
    case 'rounds_for_time':
      return 'Rounds for time'
    case 'emom':
      return 'EMOM'
    case 'interval':
      return 'Intervals'
    case 'max_reps_rounds':
      return 'Max reps'
    default:
      return 'For time'
  }
}

// The primary score string: "4:05" (time) / "12 + 14" (AMRAP) /
// "22/30" (EMOM) / "312 pts" (interval) / "88 reps" (max reps) / "DNF".
export function wodPayloadScore(p: WodPayload): string {
  if (p.wodType === 'amrap') {
    const r = p.completedRounds ?? 0
    const partial = p.partialReps ?? 0
    return partial > 0 ? `${r} + ${partial}` : `${r}`
  }
  if (p.wodType === 'emom') {
    // Matches fitness-shared's formatWodScore so the finish screen and the
    // history row show the same string for the same result.
    if (p.dnf) return `${p.intervalsCompleted ?? 0}/${p.totalIntervals ?? 0}`
    return `${p.intervalsCompleted ?? 0} rounds`
  }
  if (p.wodType === 'interval') {
    return `${p.totalScore ?? 0} pts`
  }
  if (p.wodType === 'max_reps_rounds') {
    return `${p.totalReps ?? 0} reps`
  }
  if (p.dnf) return 'DNF'
  if (typeof p.timeS === 'number') {
    const t = Math.floor(p.timeS)
    const m = Math.floor(t / 60)
    const s = t % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }
  return ''
}
