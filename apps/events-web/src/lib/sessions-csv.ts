// Sessions CSV: template + a pure dry-run planner (issue #191 Phase 3).
// A non-empty `id` column drives an update of that session; a blank `id`
// is a create. On updates, only non-empty cells are patched (a blank cell
// means "leave unchanged"), so a sparse spreadsheet can't accidentally
// wipe fields. The planner is pure and assembles the exact bulk payload so
// the UI just hands it to the bulk endpoint.

import { headerIndex, parseCsv, toCsv } from './csv.js'
import type {
  BulkSessionCreate,
  BulkSessionUpdate,
  DayDto,
  SessionDtoFull,
  SessionVisibility,
  StageDto,
} from './api.js'

export const SESSIONS_CSV_HEADERS = [
  'id',
  'title',
  'day',
  'start',
  'end',
  'stage',
  'location',
  'category',
  'host',
  'visibility',
  'description',
] as const

const VISIBILITIES: readonly SessionVisibility[] = ['admin', 'private', 'group', 'custom']
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

export interface ImportError {
  line: number
  message: string
}

export interface PlannedSessionRow {
  line: number
  action: 'create' | 'update'
  id: string | null
  title: string
  dayLabel: string | null
}

export interface SessionsImportPlan {
  rows: PlannedSessionRow[]
  errors: ImportError[]
  creates: BulkSessionCreate[]
  updates: BulkSessionUpdate[]
  deletes: string[]
  summary: { create: number; update: number; delete: number; error: number }
}

export function sessionsTemplateCsv(days: DayDto[] = [], stages: StageDto[] = []): string {
  const example = [
    '', // id blank → create
    'Sunrise Yoga',
    days[0]?.day_label ?? 'Day 1',
    '07:00',
    '08:00',
    stages[0]?.name ?? '',
    'Wellness Tent',
    'wellness',
    'Jane Doe',
    'group',
    'Gentle flow to start the day',
  ]
  return toCsv([[...SESSIONS_CSV_HEADERS], example])
}

function normTime(raw: string): string | null | undefined {
  const s = raw.trim()
  if (!s) return null
  if (!TIME_RE.test(s)) return undefined
  return s.slice(0, 5)
}

export function planSessionsImport(input: {
  text: string
  days: DayDto[]
  stages?: StageDto[]
  currentSessions: SessionDtoFull[]
  replace?: boolean
}): SessionsImportPlan {
  const { text, days, stages = [], currentSessions, replace = false } = input
  const errors: ImportError[] = []
  const rows: PlannedSessionRow[] = []
  const creates: BulkSessionCreate[] = []
  const updates: BulkSessionUpdate[] = []

  const grid = parseCsv(text)
  const header = grid[0]
  if (!header) {
    return empty([{ line: 0, message: 'The file is empty.' }])
  }

  const idx = headerIndex(header)
  if (!idx.has('title')) {
    return empty([{ line: 1, message: 'Missing required column "title".' }])
  }

  const dayByLabel = new Map(days.map((d) => [d.day_label.trim().toLowerCase(), d]))
  const dayByDate = new Map(days.map((d) => [d.date, d]))
  const stageByName = new Map(stages.map((st) => [st.name.trim().toLowerCase(), st]))
  const byId = new Map(currentSessions.map((s) => [s.id, s]))

  const cell = (r: string[], col: string) => {
    const i = idx.get(col)
    return i === undefined ? '' : (r[i] ?? '')
  }

  const seenIds = new Set<string>()

  for (let g = 1; g < grid.length; g++) {
    const line = g + 1
    const r = grid[g]
    if (!r) continue
    const id = cell(r, 'id').trim()
    const title = cell(r, 'title').trim()
    const isUpdate = id.length > 0

    if (isUpdate && !byId.has(id)) {
      errors.push({ line, message: `Unknown session id "${id}".` })
      continue
    }
    if (isUpdate && seenIds.has(id)) {
      errors.push({ line, message: `Duplicate row for session "${id}".` })
      continue
    }
    if (!isUpdate && !title) {
      errors.push({ line, message: 'Title is required for new sessions.' })
      continue
    }
    if (title.length > 200) {
      errors.push({ line, message: 'Title must be at most 200 characters.' })
      continue
    }

    // Resolve day (blank = no change / no day).
    const dayToken = cell(r, 'day').trim()
    let dayId: string | null | undefined
    let dayLabel: string | null = null
    if (dayToken) {
      const day = dayByLabel.get(dayToken.toLowerCase()) ?? dayByDate.get(dayToken)
      if (!day) {
        errors.push({ line, message: `Unknown day "${dayToken}".` })
        continue
      }
      dayId = day.id
      dayLabel = day.day_label
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

    // Resolve stage by name (blank = no change / no stage).
    const stageToken = cell(r, 'stage').trim()
    let stageId: string | null | undefined
    if (stageToken) {
      const stage = stageByName.get(stageToken.toLowerCase())
      if (!stage) {
        errors.push({ line, message: `Unknown stage "${stageToken}".` })
        continue
      }
      stageId = stage.id
    }

    const visToken = cell(r, 'visibility').trim().toLowerCase()
    let visibility: SessionVisibility | undefined
    if (visToken) {
      if (!VISIBILITIES.includes(visToken as SessionVisibility)) {
        errors.push({ line, message: `Visibility must be admin, private, group, or custom (got "${visToken}").` })
        continue
      }
      visibility = visToken as SessionVisibility
    }

    const location = cell(r, 'location').trim()
    const category = cell(r, 'category').trim()
    const host = cell(r, 'host').trim()
    const description = cell(r, 'description').trim()

    if (location.length > 200) {
      errors.push({ line, message: 'Location must be at most 200 characters.' })
      continue
    }
    if (category.length > 100) {
      errors.push({ line, message: 'Category must be at most 100 characters.' })
      continue
    }
    if (host.length > 200) {
      errors.push({ line, message: 'Host must be at most 200 characters.' })
      continue
    }
    if (description.length > 5000) {
      errors.push({ line, message: 'Description must be at most 5000 characters.' })
      continue
    }

    if (isUpdate) {
      // Only non-empty cells are patched (blank = leave unchanged).
      const patch: BulkSessionUpdate['patch'] = {}
      if (title) patch.title = title
      if (dayToken) patch.dayId = dayId ?? null
      if (cell(r, 'start').trim()) patch.startTime = startTime
      if (cell(r, 'end').trim()) patch.endTime = endTime
      // Patch writes stageId whenever the cell is non-empty; the create
      // path below intentionally skips a null stageId (undefined and null
      // both mean "no stage" on create, but only null clears on patch).
      if (stageToken) patch.stageId = stageId ?? null
      if (location) patch.location = location
      if (category) patch.category = category
      if (host) patch.host = host
      if (visibility) patch.visibility = visibility
      if (description) patch.description = description
      if (Object.keys(patch).length === 0) {
        errors.push({ line, message: 'Update row has no values to change.' })
        continue
      }
      // Mark seen only once the update is real, so an error row (no values,
      // bad field) doesn't suppress a replace-mode delete of that session.
      seenIds.add(id)
      updates.push({ id, patch })
      rows.push({ line, action: 'update', id, title: title || byId.get(id)!.title, dayLabel })
    } else {
      const create: BulkSessionCreate = { title }
      if (dayId) create.dayId = dayId
      if (startTime) create.startTime = startTime
      if (endTime) create.endTime = endTime
      if (stageId) create.stageId = stageId
      if (location) create.location = location
      if (category) create.category = category
      if (host) create.host = host
      if (visibility) create.visibility = visibility
      if (description) create.description = description
      creates.push(create)
      rows.push({ line, action: 'create', id: null, title, dayLabel })
    }
  }

  const deletes: string[] = []
  if (replace) {
    for (const s of currentSessions) {
      if (!seenIds.has(s.id)) deletes.push(s.id)
    }
  }

  // The bulk endpoint caps creates/updates/deletes at 200 each; flag here so
  // the preview blocks apply instead of the server 400-ing.
  if (creates.length > 200) {
    errors.push({ line: 0, message: `Too many new sessions to import at once (${creates.length}); max is 200.` })
  }
  if (updates.length > 200) {
    errors.push({ line: 0, message: `Too many session updates at once (${updates.length}); max is 200.` })
  }
  if (deletes.length > 200) {
    errors.push({ line: 0, message: `Too many sessions to delete at once (${deletes.length}); max is 200.` })
  }

  return {
    rows,
    errors,
    creates,
    updates,
    deletes,
    summary: {
      create: creates.length,
      update: updates.length,
      delete: deletes.length,
      error: errors.length,
    },
  }
}

function empty(errors: ImportError[]): SessionsImportPlan {
  return {
    rows: [],
    errors,
    creates: [],
    updates: [],
    deletes: [],
    summary: { create: 0, update: 0, delete: 0, error: errors.length },
  }
}
