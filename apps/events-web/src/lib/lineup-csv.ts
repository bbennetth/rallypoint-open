// Lineup CSV: template generation + a pure "dry-run" planner that turns an
// uploaded spreadsheet into a preview (issue #191 Phase 3). This file owns
// only the CSV concerns (headers, parsing, required-column checks); the
// row-level planning core lives in @rallypoint/events-shared's
// planLineupChanges so the server-side AI ingestion shares it. Artist
// names are kept as text here; the UI resolves them to ids via
// find-or-create at apply time, so this stays a pure function with no I/O.

import { headerIndex, parseCsv, toCsv } from './csv.js'
import { planLineupChanges } from '@rallypoint/events-shared'
import type { LineupChangeRowInput } from '@rallypoint/events-shared'
import type { DayDto, LineupSlotDto, StageDto } from './api.js'

// The planner's row/plan types, re-exported under this module's historical
// names for existing imports.
export type {
  PlannedLineupRow,
  LineupDeletePlan,
  LineupPlanError as ImportError,
  LineupChangePlan as LineupImportPlan,
} from '@rallypoint/events-shared'

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

export function planLineupImport(input: {
  text: string
  days: DayDto[]
  stages: StageDto[]
  currentSlots: LineupSlotDto[]
  replace?: boolean
}): ReturnType<typeof planLineupChanges> {
  const { text, days, stages, currentSlots, replace = false } = input

  const grid = parseCsv(text)
  const header = grid[0]
  if (!header) {
    return {
      rows: [],
      errors: [{ line: 0, message: 'The file is empty.' }],
      deletes: [],
      summary: { create: 0, update: 0, delete: 0, error: 1 },
    }
  }

  const idx = headerIndex(header)
  const headerErrors: { line: number; message: string }[] = []
  // Only `artist` is required — a file without a day column (or with
  // empty day cells) imports as unscheduled (TBA) rows.
  for (const required of ['artist'] as const) {
    if (!idx.has(required)) {
      headerErrors.push({ line: 1, message: `Missing required column "${required}".` })
    }
  }
  if (headerErrors.length > 0) {
    return {
      rows: [],
      errors: headerErrors,
      deletes: [],
      summary: { create: 0, update: 0, delete: 0, error: headerErrors.length },
    }
  }

  const cell = (r: string[], col: string) => {
    const i = idx.get(col)
    return i === undefined ? '' : (r[i] ?? '')
  }

  const rows: LineupChangeRowInput[] = []
  for (let g = 1; g < grid.length; g++) {
    const r = grid[g]
    if (!r) continue
    rows.push({
      line: g + 1, // 1-based, header is line 1
      artist: cell(r, 'artist'),
      day: cell(r, 'day'),
      stage: cell(r, 'stage'),
      tier: cell(r, 'tier'),
      genre: cell(r, 'genre'),
      start: cell(r, 'start'),
      end: cell(r, 'end'),
      displayName: cell(r, 'display_name'),
    })
  }

  return planLineupChanges({ rows, days, stages, currentSlots, replace })
}
