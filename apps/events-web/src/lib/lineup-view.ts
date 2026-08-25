import type { DayDto, LineupSlotDto, StageDto } from './api.js'

// Pure shaping for the attendee Lineup tab — resolves raw slots against
// days and stages into the day-grouped view the UI renders. Shared by
// the solo and group-joined Lineup routes via `ui/EventLineup.tsx`.

export function fmtTime(t: string | null): string {
  if (!t) return ''
  // 'HH:MM:SS' → 'HH:MM'
  return t.slice(0, 5)
}

export function tierBadge(tier: string | null): string {
  if (!tier) return ''
  return tier.toUpperCase()
}

// Artist names for the "Lineup now" selector. The lineup endpoint carries
// each slot's `artist_name` inline and has no separate artists call, so the
// summaries come off the slots themselves — without this the selector only
// sees `display_name` and falls back to "Unknown artist" for every slot the
// organiser didn't give a custom billing name.
export function artistSummaries(
  slots: readonly Pick<LineupSlotDto, 'artist_id' | 'artist_name'>[],
): { id: string; name: string }[] {
  const byId = new Map<string, string>()
  for (const s of slots) {
    if (s.artist_name && !byId.has(s.artist_id)) byId.set(s.artist_id, s.artist_name)
  }
  return [...byId].map(([id, name]) => ({ id, name }))
}

// Music/social profile services in display order.
export const LINK_KINDS = [
  'spotify',
  'soundcloud',
  'apple_music',
  'youtube_music',
  'instagram',
] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export interface ArtistLink {
  kind: LinkKind
  url: string
}

// Profile links for a slot, in LINK_KINDS order. Null/absent fields are
// skipped (older API deployments omit them entirely), and only http(s)
// URLs pass — catalog rows imported from CSV may hold junk.
export function artistLinks(
  slot: Partial<Pick<LineupSlotDto, LinkKind>>,
): ArtistLink[] {
  const links: ArtistLink[] = []
  for (const kind of LINK_KINDS) {
    const url = slot[kind]
    if (url && /^https?:\/\//i.test(url)) links.push({ kind, url })
  }
  return links
}

export interface SlotView {
  artistId: string
  // null = unscheduled (TBA) slot.
  dayId: string | null
  artistName: string
  stageName: string | null
  tier: string | null
  // Per-slot override, falling back to the artist's catalog genre.
  genre: string | null
  links: ArtistLink[]
  startTime: string | null
  endTime: string | null
}

export interface DayGroup {
  // null = the trailing "TBA" pseudo-group of unscheduled slots.
  day: DayDto | null
  slots: SlotView[]
}

export function buildGroups(
  slots: LineupSlotDto[],
  days: DayDto[],
  stages: StageDto[],
): DayGroup[] {
  const stageById = new Map(stages.map((s) => [s.id, s]))

  // Only show days that have at least one slot. Slots with day_id null
  // are unscheduled (TBA) bookings — they collect into a trailing
  // pseudo-group instead of silently vanishing.
  const slotsByDay = new Map<string | null, LineupSlotDto[]>()
  for (const slot of slots) {
    const key = slot.day_id ?? null
    const list = slotsByDay.get(key) ?? []
    list.push(slot)
    slotsByDay.set(key, list)
  }

  const orderedDays = [...days].sort((a, b) => a.sort_order - b.sort_order)

  const byTime = (a: LineupSlotDto, b: LineupSlotDto) => {
    const ta = a.start_time ?? ''
    const tb = b.start_time ?? ''
    return ta < tb ? -1 : ta > tb ? 1 : 0
  }
  const toView = (s: LineupSlotDto): SlotView => ({
    artistId: s.artist_id,
    dayId: s.day_id ?? null,
    artistName: s.display_name ?? s.artist_name ?? s.artist_id,
    stageName: s.stage_id ? (stageById.get(s.stage_id)?.name ?? null) : null,
    tier: s.tier,
    genre: s.genre ?? s.artist_genre ?? null,
    links: artistLinks(s),
    startTime: s.start_time,
    endTime: s.end_time,
  })

  const groups: DayGroup[] = orderedDays
    .map((day) => ({ day: day as DayDto | null, slots: (slotsByDay.get(day.id) ?? []).sort(byTime).map(toView) }))
    .filter((g) => g.slots.length > 0)

  const unscheduled = (slotsByDay.get(null) ?? []).sort(byTime).map(toView)
  if (unscheduled.length > 0) groups.push({ day: null, slots: unscheduled })

  return groups
}
