// Pure lineup-change planner: turns rows of raw string tokens (from a
// CSV upload or an AI lineup extraction) into a create/update/delete
// preview against an event's current lineup. Extracted from
// apps/events-web lib/lineup-csv.ts (issue #191 Phase 3) so the server
// side (AI ingestion) and the browser (CSV import) share one planner.
// Artist names stay text here; callers resolve them to ids via
// find-or-create at apply time, so this remains a pure function.

import { LINEUP_TIERS } from './validators.js'

export type LineupPlanTier = (typeof LINEUP_TIERS)[number]

// HH:MM or HH:MM:SS, 24-hour. Values are normalized to HH:MM.
export const SET_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

// The bulk lineup endpoint caps slots and deletes at 200 each; the
// planner flags overflow so previews block apply instead of the server
// 400-ing.
export const LINEUP_PLAN_MAX_ROWS = 200

// Display label for rows/slots with no day assigned (unscheduled/TBA
// bookings — festivals announce artists before day splits).
export const UNSCHEDULED_DAY_LABEL = 'TBA'

// Structural refs — events-web's DayDto/StageDto/LineupSlotDto and the
// server's serialized records both satisfy these shapes.
export interface PlanDayRef {
  id: string
  day_label: string
  date: string
}

export interface PlanStageRef {
  id: string
  name: string
}

export interface PlanCurrentSlot {
  artist_id: string
  artist_name: string | null
  display_name: string | null
  // null = unscheduled/TBA slot.
  day_id: string | null
}

// One raw candidate row. All fields are unresolved string tokens; `day`
// matches a day by label (case-insensitive) or by YYYY-MM-DD date; an
// empty/absent day plans an unscheduled (TBA) row. `line` is the
// 1-based source position (CSV line / extraction index) used in error
// messages.
export interface LineupChangeRowInput {
  line: number
  artist: string
  day?: string | null | undefined
  stage?: string | null | undefined
  tier?: string | null | undefined
  genre?: string | null | undefined
  start?: string | null | undefined
  end?: string | null | undefined
  displayName?: string | null | undefined
}

export interface PlannedLineupRow {
  line: number
  action: 'create' | 'update'
  artistName: string
  // Set only when the row matched an existing slot (by artist name + day);
  // lets the apply step skip find-or-create for known artists.
  artistId: string | null
  // null = unscheduled/TBA row (dayLabel carries UNSCHEDULED_DAY_LABEL).
  dayId: string | null
  dayLabel: string
  stageId: string | null
  // Resolved stage name for review surfaces (null when unstaged).
  stageName: string | null
  tier: LineupPlanTier | null
  genre: string | null
  startTime: string | null
  endTime: string | null
  displayName: string | null
}

export interface LineupDeletePlan {
  artistId: string
  // null = the artist's unscheduled/TBA slot.
  dayId: string | null
  label: string
}

export interface LineupPlanError {
  line: number
  message: string
}

export interface LineupChangePlan {
  rows: PlannedLineupRow[]
  errors: LineupPlanError[]
  deletes: LineupDeletePlan[]
  summary: { create: number; update: number; delete: number; error: number }
}

function normTime(raw: string): string | null | undefined {
  const s = raw.trim()
  if (!s) return null
  if (!SET_TIME_RE.test(s)) return undefined // signal invalid
  return s.slice(0, 5)
}

const slotKey = (name: string, dayId: string | null) =>
  `${name.trim().toLowerCase()}\u0000${dayId ?? ''}`

export function planLineupChanges(input: {
  rows: LineupChangeRowInput[]
  days: PlanDayRef[]
  stages: PlanStageRef[]
  currentSlots: PlanCurrentSlot[]
  replace?: boolean
}): LineupChangePlan {
  const { rows: inputRows, days, stages, currentSlots, replace = false } = input
  const errors: LineupPlanError[] = []
  const rows: PlannedLineupRow[] = []

  const dayByLabel = new Map(days.map((d) => [d.day_label.trim().toLowerCase(), d]))
  const dayByDate = new Map(days.map((d) => [d.date, d]))
  const stageByName = new Map(stages.map((s) => [s.name.trim().toLowerCase(), s]))

  // Existing slots keyed by artist-name + day for create-vs-update detection.
  const currentByKey = new Map<string, PlanCurrentSlot>()
  for (const s of currentSlots) {
    const name = (s.artist_name ?? s.display_name ?? '').trim().toLowerCase()
    if (name) currentByKey.set(slotKey(name, s.day_id), s)
  }

  const seenKeys = new Set<string>()

  for (const raw of inputRows) {
    const line = raw.line
    const artistName = raw.artist.trim()
    if (!artistName) {
      errors.push({ line, message: 'Artist is required.' })
      continue
    }
    if (artistName.length > 200) {
      errors.push({ line, message: 'Artist name must be at most 200 characters.' })
      continue
    }

    // Empty/absent day = unscheduled (TBA) row; a NON-empty token that
    // matches no day is still a hard error (typo, not intent).
    const dayToken = (raw.day ?? '').trim()
    let day: PlanDayRef | null = null
    if (dayToken) {
      day = dayByLabel.get(dayToken.toLowerCase()) ?? dayByDate.get(dayToken) ?? null
      if (!day) {
        errors.push({ line, message: `Unknown day "${dayToken}".` })
        continue
      }
    }

    const stageToken = (raw.stage ?? '').trim()
    let stageId: string | null = null
    let stageName: string | null = null
    if (stageToken) {
      const stage = stageByName.get(stageToken.toLowerCase())
      if (!stage) {
        errors.push({ line, message: `Unknown stage "${stageToken}".` })
        continue
      }
      stageId = stage.id
      stageName = stage.name
    }

    const tierToken = (raw.tier ?? '').trim().toLowerCase()
    let tier: LineupPlanTier | null = null
    if (tierToken) {
      if (!LINEUP_TIERS.includes(tierToken as LineupPlanTier)) {
        errors.push({ line, message: `Tier must be headliner, support, or opener (got "${tierToken}").` })
        continue
      }
      tier = tierToken as LineupPlanTier
    }

    const startTime = normTime(raw.start ?? '')
    if (startTime === undefined) {
      errors.push({ line, message: 'Start time must be HH:MM (24-hour).' })
      continue
    }
    const endTime = normTime(raw.end ?? '')
    if (endTime === undefined) {
      errors.push({ line, message: 'End time must be HH:MM (24-hour).' })
      continue
    }

    const genreRaw = (raw.genre ?? '').trim()
    if (genreRaw.length > 100) {
      errors.push({ line, message: 'Genre must be at most 100 characters.' })
      continue
    }
    const displayRaw = (raw.displayName ?? '').trim()
    if (displayRaw.length > 200) {
      errors.push({ line, message: 'Display name must be at most 200 characters.' })
      continue
    }

    const key = slotKey(artistName, day?.id ?? null)
    if (seenKeys.has(key)) {
      errors.push({
        line,
        message: `Duplicate row for "${artistName}" on ${day?.day_label ?? UNSCHEDULED_DAY_LABEL}.`,
      })
      continue
    }
    seenKeys.add(key)

    const existing = currentByKey.get(key)
    rows.push({
      line,
      action: existing ? 'update' : 'create',
      artistName,
      artistId: existing?.artist_id ?? null,
      dayId: day?.id ?? null,
      dayLabel: day?.day_label ?? UNSCHEDULED_DAY_LABEL,
      stageId,
      stageName,
      tier,
      genre: genreRaw || null,
      startTime,
      endTime,
      displayName: displayRaw || null,
    })
  }

  const deletes: LineupDeletePlan[] = []
  if (replace) {
    for (const s of currentSlots) {
      const name = (s.artist_name ?? s.display_name ?? '').trim().toLowerCase()
      const key = slotKey(name, s.day_id)
      if (!name || !seenKeys.has(key)) {
        const label = (s.artist_name ?? s.display_name ?? s.artist_id).trim()
        deletes.push({ artistId: s.artist_id, dayId: s.day_id, label })
      }
    }
  }

  if (rows.length > LINEUP_PLAN_MAX_ROWS) {
    errors.push({
      line: 0,
      message: `Too many rows to import at once (${rows.length}); max is ${LINEUP_PLAN_MAX_ROWS}.`,
    })
  }
  if (deletes.length > LINEUP_PLAN_MAX_ROWS) {
    errors.push({
      line: 0,
      message: `Too many rows to remove at once (${deletes.length}); max is ${LINEUP_PLAN_MAX_ROWS}.`,
    })
  }

  return {
    rows,
    errors,
    deletes,
    summary: {
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      delete: deletes.length,
      error: errors.length,
    },
  }
}
