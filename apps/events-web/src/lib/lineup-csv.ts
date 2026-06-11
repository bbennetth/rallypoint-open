// Lineup CSV: template generation + a pure "dry-run" planner that turns an
// uploaded spreadsheet into a preview (issue #191 Phase 3). Artist names are
// kept as text here; the UI resolves them to ids via find-or-create at apply
// time, so this stays a pure function with no I/O.

import { headerIndex, parseCsv, toCsv } from './csv.js'
import type { DayDto, LineupSlotDto, LineupTier, StageDto } from './api.js'

export const LINEUP_CSV_HEADERS = [
  'artist',
  'day',
  'stage',
  'tier',
  'genre',
  'start',
  'end',
  'display_name',
] as const

const TIERS: readonly LineupTier[] = ['headliner', 'support', 'opener']
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

export interface PlannedLineupRow {
  line: number
  action: 'create' | 'update'
  artistName: string
  // Set only when the row matched an existing slot (by artist name + day);
  // lets the apply step skip find-or-create for known artists.
  artistId: string | null
  dayId: string
  dayLabel: string
  stageId: string | null
  tier: LineupTier | null
  genre: string | null
  startTime: string | null
  endTime: string | null
  displayName: string | null
}

export interface LineupDeletePlan {
  artistId: string
  dayId: string
  label: string
}

export interface ImportError {
  line: number
  message: string
}

export interface LineupImportPlan {
  rows: PlannedLineupRow[]
  errors: ImportError[]
  deletes: LineupDeletePlan[]
  summary: { create: number; update: number; delete: number; error: number }
}

// Build a downloadable template: header row + one illustrative example
// (using a real day/stage name when available so the columns are obvious).
export function lineupTemplateCsv(days: DayDto[] = [], stages: StageDto[] = []): string {
  const example = [
    'Aphex Twin',
    days[0]?.day_label ?? 'Day 1',
    stages[0]?.name ?? '',
    'headliner',
    'electronic',
    '21:00',
    '22:30',
    '',
  ]
  return toCsv([[...LINEUP_CSV_HEADERS], example])
}

function normTime(raw: string): string | null | undefined {
  const s = raw.trim()
  if (!s) return null
  if (!TIME_RE.test(s)) return undefined // signal invalid
  return s.slice(0, 5)
}

export function planLineupImport(input: {
  text: string
  days: DayDto[]
  stages: StageDto[]
  currentSlots: LineupSlotDto[]
  replace?: boolean
}): LineupImportPlan {
  const { text, days, stages, currentSlots, replace = false } = input
  const errors: ImportError[] = []
  const rows: PlannedLineupRow[] = []

  const grid = parseCsv(text)
  const header = grid[0]
  if (!header) {
    return {
      rows,
      errors: [{ line: 0, message: 'The file is empty.' }],
      deletes: [],
      summary: { ...zero(), error: 1 },
    }
  }

  const idx = headerIndex(header)
  for (const required of ['artist', 'day'] as const) {
    if (!idx.has(required)) {
      errors.push({ line: 1, message: `Missing required column "${required}".` })
    }
  }
  if (errors.length > 0) return { rows, errors, deletes: [], summary: { ...zero(), error: errors.length } }

  const dayByLabel = new Map(days.map((d) => [d.day_label.trim().toLowerCase(), d]))
  const dayByDate = new Map(days.map((d) => [d.date, d]))
  const stageByName = new Map(stages.map((s) => [s.name.trim().toLowerCase(), s]))

  // Existing slots keyed by artist-name + day for create-vs-update detection.
  const slotKey = (name: string, dayId: string) => `${name.trim().toLowerCase()}\u0000${dayId}`
  const currentByKey = new Map<string, LineupSlotDto>()
  for (const s of currentSlots) {
    const name = (s.artist_name ?? s.display_name ?? '').trim().toLowerCase()
    if (name) currentByKey.set(slotKey(name, s.day_id), s)
  }

  const seenKeys = new Set<string>()
  const cell = (r: string[], col: string) => {
    const i = idx.get(col)
    return i === undefined ? '' : (r[i] ?? '')
  }

  for (let g = 1; g < grid.length; g++) {
    const line = g + 1 // 1-based, header is line 1
    const r = grid[g]
    if (!r) continue
    const artistName = cell(r, 'artist').trim()
    if (!artistName) {
      errors.push({ line, message: 'Artist is required.' })
      continue
    }
    if (artistName.length > 200) {
      errors.push({ line, message: 'Artist name must be at most 200 characters.' })
      continue
    }

    const dayToken = cell(r, 'day').trim()
    const day = dayByLabel.get(dayToken.toLowerCase()) ?? dayByDate.get(dayToken)
    if (!day) {
      errors.push({ line, message: `Unknown day "${dayToken}".` })
      continue
    }

    const stageToken = cell(r, 'stage').trim()
    let stageId: string | null = null
    if (stageToken) {
      const stage = stageByName.get(stageToken.toLowerCase())
      if (!stage) {
        errors.push({ line, message: `Unknown stage "${stageToken}".` })
        continue
      }
      stageId = stage.id
    }

    const tierToken = cell(r, 'tier').trim().toLowerCase()
    let tier: LineupTier | null = null
    if (tierToken) {
      if (!TIERS.includes(tierToken as LineupTier)) {
        errors.push({ line, message: `Tier must be headliner, support, or opener (got "${tierToken}").` })
        continue
      }
      tier = tierToken as LineupTier
    }

    const startTime = normTime(cell(r, 'start'))
    if (startTime === undefined) {
      errors.push({ line, message: 'Start time must be HH:MM (24-hour).' })
      continue
    }
    const endTime = normTime(cell(r, 'end'))
    if (endTime === undefined) {
      errors.push({ line, message: 'End time must be HH:MM (24-hour).' })
      continue
    }

    const genreRaw = cell(r, 'genre').trim()
    if (genreRaw.length > 100) {
      errors.push({ line, message: 'Genre must be at most 100 characters.' })
      continue
    }
    const displayRaw = cell(r, 'display_name').trim()
    if (displayRaw.length > 200) {
      errors.push({ line, message: 'Display name must be at most 200 characters.' })
      continue
    }

    const key = slotKey(artistName, day.id)
    if (seenKeys.has(key)) {
      errors.push({ line, message: `Duplicate row for "${artistName}" on ${day.day_label}.` })
      continue
    }
    seenKeys.add(key)

    const existing = currentByKey.get(key)
    rows.push({
      line,
      action: existing ? 'update' : 'create',
      artistName,
      artistId: existing?.artist_id ?? null,
      dayId: day.id,
      dayLabel: day.day_label,
      stageId,
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

  // The bulk endpoint caps slots and deletes at 200 each; flag here so the
  // preview blocks apply instead of the server 400-ing.
  if (rows.length > 200) {
    errors.push({ line: 0, message: `Too many rows to import at once (${rows.length}); max is 200.` })
  }
  if (deletes.length > 200) {
    errors.push({ line: 0, message: `Too many rows to remove at once (${deletes.length}); max is 200.` })
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

function zero() {
  return { create: 0, update: 0, delete: 0, error: 0 }
}
