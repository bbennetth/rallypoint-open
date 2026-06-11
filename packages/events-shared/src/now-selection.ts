// Pure selectors for the attendee "Now" view (slice 13, design §13).
// Decoupled from the events-web DTO and the events-api record shapes
// — structural typing on the minimum fields each selector reads.
// Times are parsed against the device clock; festivals assume the
// attendee is in the event timezone, which is a fair V1 simplification
// (event.timezone is available if a future slice wants to convert).

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_LINEUP_BLOCK_MS = 60 * HOUR_MS / 60 // 1h
const DEFAULT_SESSION_BLOCK_MS = 2 * HOUR_MS // 2h

// --- Lineup ----------------------------------------------------------

export interface LineupSlot {
  // Identity. eventArtists are keyed by (event, artist, day); a
  // multi-stage artist on the same day collapses to one row, so
  // stageId is on the slot itself.
  artistId: string
  dayId: string
  stageId: string | null
  // 'HH:MM' or 'HH:MM:SS'. null = unscheduled (skipped by selectors).
  startTime: string | null
  endTime: string | null
  // Optional display label that overrides the artist name.
  displayName?: string | null
}

export interface LineupDay {
  id: string
  // YYYY-MM-DD. Combined with slot.startTime to compute the absolute
  // window. Slots whose day is missing from this list are skipped.
  date: string
}

export interface LineupStage {
  id: string
  name: string
  sortOrder: number
}

export interface LineupArtistSummary {
  id: string
  name: string
}

export interface LineupNowEntry {
  stageId: string | null
  stageName: string | null
  current: ResolvedLineupSlot | null
  next: ResolvedLineupSlot | null
}

export interface ResolvedLineupSlot extends LineupSlot {
  artistName: string
  startsAt: Date
  endsAt: Date
}

// Per-stage current + next set at `now`. Stages with no scheduled
// activity for the day(s) covering `now` are omitted entirely.
// "Day" matching is permissive: a slot whose start..end overlaps
// `now` is "current"; the next slot (chronologically) on the same
// stage with `startsAt > now` is "next". Slots across different
// days for the same stage are concatenated and sorted.
export function selectCurrentLineup(input: {
  slots: readonly LineupSlot[]
  days: readonly LineupDay[]
  stages: readonly LineupStage[]
  artists: readonly LineupArtistSummary[]
  now: Date
}): LineupNowEntry[] {
  const dayById = new Map(input.days.map((d) => [d.id, d]))
  const stageById = new Map(input.stages.map((s) => [s.id, s]))
  const artistById = new Map(input.artists.map((a) => [a.id, a]))

  const resolved: ResolvedLineupSlot[] = []
  for (const slot of input.slots) {
    const day = dayById.get(slot.dayId)
    if (!day) continue
    if (!slot.startTime) continue
    const startsAt = combineDayTime(day.date, slot.startTime)
    if (!startsAt) continue
    const endsAt = slot.endTime
      ? combineDayTime(day.date, slot.endTime) ?? new Date(startsAt.getTime() + DEFAULT_LINEUP_BLOCK_MS)
      : new Date(startsAt.getTime() + DEFAULT_LINEUP_BLOCK_MS)
    const artist = artistById.get(slot.artistId)
    resolved.push({
      ...slot,
      artistName: slot.displayName ?? artist?.name ?? 'Unknown artist',
      startsAt,
      endsAt,
    })
  }

  // Group by stageId (including null for "all stages" / TBD).
  const byStage = new Map<string | null, ResolvedLineupSlot[]>()
  for (const r of resolved) {
    const list = byStage.get(r.stageId) ?? []
    list.push(r)
    byStage.set(r.stageId, list)
  }

  const out: LineupNowEntry[] = []
  for (const [stageId, list] of byStage) {
    list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    const current = list.find((r) => r.startsAt <= input.now && input.now < r.endsAt) ?? null
    const afterNow = list.filter((r) => r.startsAt.getTime() > input.now.getTime())
    const next = afterNow[0] ?? null
    // Suppress stages with nothing of interest.
    if (!current && !next) continue
    out.push({
      stageId,
      stageName: stageId ? stageById.get(stageId)?.name ?? null : null,
      current,
      next,
    })
  }

  // Stable order: by sortOrder then name; stageless rows last.
  out.sort((a, b) => {
    if (a.stageId === null && b.stageId !== null) return 1
    if (a.stageId !== null && b.stageId === null) return -1
    const sa = a.stageId ? stageById.get(a.stageId)?.sortOrder ?? 0 : 0
    const sb = b.stageId ? stageById.get(b.stageId)?.sortOrder ?? 0 : 0
    if (sa !== sb) return sa - sb
    return (a.stageName ?? '').localeCompare(b.stageName ?? '')
  })
  return out
}

// --- Rallies ---------------------------------------------------------

export interface RallySlot {
  id: string
  title: string
  dayId: string | null
  // 'HH:MM' or 'HH:MM:SS'. null = unscheduled (skipped).
  startTime: string | null
  status: 'proposed' | 'active' | 'cancelled'
}

export interface ResolvedRally {
  id: string
  title: string
  startsAt: Date
  status: RallySlot['status']
}

// Rallies starting within `[now, now + horizonMs]`. Cancelled rallies
// are excluded; un-dated or un-timed rallies are excluded. Sorted by
// startsAt ascending, ties broken by id.
export function selectUpcomingRallies(input: {
  rallies: readonly RallySlot[]
  days: readonly LineupDay[]
  now: Date
  horizonMs: number
}): ResolvedRally[] {
  const dayById = new Map(input.days.map((d) => [d.id, d]))
  const horizonEnd = new Date(input.now.getTime() + input.horizonMs)
  const resolved: ResolvedRally[] = []
  for (const r of input.rallies) {
    if (r.status === 'cancelled') continue
    if (!r.dayId || !r.startTime) continue
    const day = dayById.get(r.dayId)
    if (!day) continue
    const startsAt = combineDayTime(day.date, r.startTime)
    if (!startsAt) continue
    if (startsAt < input.now) continue
    if (startsAt > horizonEnd) continue
    resolved.push({ id: r.id, title: r.title, startsAt, status: r.status })
  }
  resolved.sort((a, b) => {
    const t = a.startsAt.getTime() - b.startsAt.getTime()
    return t !== 0 ? t : a.id < b.id ? -1 : 1
  })
  return resolved
}

// --- Sessions --------------------------------------------------------

export interface SessionSlot {
  id: string
  title: string
  dayId: string | null
  startTime: string | null
  endTime: string | null
}

export interface ResolvedSession {
  id: string
  title: string
  startsAt: Date
  endsAt: Date
}

// Sessions whose start..end window covers `now`. Open-ended sessions
// (null endTime) get a 2h default window. Sessions without a day or
// start time are skipped.
export function selectActiveSessions(input: {
  sessions: readonly SessionSlot[]
  days: readonly LineupDay[]
  now: Date
}): ResolvedSession[] {
  const dayById = new Map(input.days.map((d) => [d.id, d]))
  const out: ResolvedSession[] = []
  for (const s of input.sessions) {
    if (!s.dayId || !s.startTime) continue
    const day = dayById.get(s.dayId)
    if (!day) continue
    const startsAt = combineDayTime(day.date, s.startTime)
    if (!startsAt) continue
    const endsAt = s.endTime
      ? combineDayTime(day.date, s.endTime) ?? new Date(startsAt.getTime() + DEFAULT_SESSION_BLOCK_MS)
      : new Date(startsAt.getTime() + DEFAULT_SESSION_BLOCK_MS)
    if (startsAt <= input.now && input.now < endsAt) {
      out.push({ id: s.id, title: s.title, startsAt, endsAt })
    }
  }
  out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return out
}

// --- shared helpers --------------------------------------------------

// 'YYYY-MM-DD' + 'HH:MM[:SS]' → Date in the local timezone. Returns
// null when either component is malformed. Times are parsed as local
// because festival attendees are usually in the event TZ — see the
// module-level note.
function combineDayTime(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const m = time.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const [yy, mm, dd] = date.split('-').map(Number)
  const hh = Number(m[1])
  const mi = Number(m[2])
  const ss = m[3] !== undefined ? Number(m[3]) : 0
  if ([yy, mm, dd, hh, mi, ss].some((n) => Number.isNaN(n))) return null
  const d = new Date(yy!, mm! - 1, dd!, hh, mi, ss, 0)
  return Number.isNaN(d.getTime()) ? null : d
}
