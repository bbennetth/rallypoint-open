import { useCallback, useEffect, useRef, useState } from 'react'
import {
  listDays,
  listLineup,
  listStages,
  listStarredSets,
  starSet,
  unstarSet,
  type DayDto,
  type LineupSlotDto,
  type SetStarKeyDto,
  type StageDto,
} from '../../lib/api.js'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Attendee-side Lineup tab (issue #194). Shows all lineup slots grouped
// by day. Each slot has a star toggle — clicking it stars/unstars that
// set. Stars are personal and optimistic-updated with a server refetch.
//
// This page is READ-ONLY aside from the star toggle. No editor controls.

// ---- helpers --------------------------------------------------------

function fmtTime(t: string | null): string {
  if (!t) return ''
  // 'HH:MM:SS' → 'HH:MM'
  return t.slice(0, 5)
}

function tierBadge(tier: string | null): string {
  if (!tier) return ''
  return tier.toUpperCase()
}

// ---- slot resolution ------------------------------------------------

interface SlotView {
  artistId: string
  dayId: string
  artistName: string
  stageName: string | null
  tier: string | null
  startTime: string | null
  endTime: string | null
  isStarred: boolean
}

interface DayGroup {
  day: DayDto
  slots: SlotView[]
}

function buildGroups(
  slots: LineupSlotDto[],
  days: DayDto[],
  stages: StageDto[],
  starred: Set<string>,
): DayGroup[] {
  const stageById = new Map(stages.map((s) => [s.id, s]))

  // Only show days that have at least one slot.
  const slotsByDay = new Map<string, LineupSlotDto[]>()
  for (const slot of slots) {
    const list = slotsByDay.get(slot.day_id) ?? []
    list.push(slot)
    slotsByDay.set(slot.day_id, list)
  }

  const orderedDays = [...days].sort((a, b) => a.sort_order - b.sort_order)

  return orderedDays
    .map((day) => {
      const daySlots = (slotsByDay.get(day.id) ?? []).sort((a, b) => {
        const ta = a.start_time ?? ''
        const tb = b.start_time ?? ''
        return ta < tb ? -1 : ta > tb ? 1 : 0
      })
      const slotViews: SlotView[] = daySlots.map((s) => ({
        artistId: s.artist_id,
        dayId: s.day_id,
        artistName: s.display_name ?? s.artist_name ?? s.artist_id,
        stageName: s.stage_id ? (stageById.get(s.stage_id)?.name ?? null) : null,
        tier: s.tier,
        startTime: s.start_time,
        endTime: s.end_time,
        isStarred: starred.has(`${s.artist_id}:${s.day_id}`),
      }))
      return { day, slots: slotViews }
    })
    .filter((g) => g.slots.length > 0)
}

function starKey(artistId: string, dayId: string): string {
  return `${artistId}:${dayId}`
}

// ---- component -------------------------------------------------------

export function SoloLineupPage() {
  const { event } = useSoloEventOutlet()
  const eventId = event.id

  const [days, setDays] = useState<DayDto[]>([])
  const [slots, setSlots] = useState<LineupSlotDto[]>([])
  const [stages, setStages] = useState<StageDto[]>([])
  const [starred, setStarred] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  // Track in-flight star/unstar calls to prevent double-taps.
  const pending = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([
      listDays(eventId).catch(() => [] as DayDto[]),
      listLineup(eventId).catch(() => [] as LineupSlotDto[]),
      listStages(eventId).catch(() => [] as StageDto[]),
      listStarredSets(eventId).catch(() => [] as SetStarKeyDto[]),
    ]).then(([dy, sl, st, stars]) => {
      if (cancelled) return
      setDays(dy)
      setSlots(sl)
      setStages(st)
      setStarred(new Set(stars.map((s) => starKey(s.artist_id, s.day_id))))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [eventId])

  const toggleStar = useCallback(
    async (artistId: string, dayId: string) => {
      const k = starKey(artistId, dayId)
      if (pending.current.has(k)) return
      pending.current.add(k)

      // Optimistic toggle.
      const wasStarred = starred.has(k)
      setStarred((prev) => {
        const next = new Set(prev)
        if (wasStarred) next.delete(k)
        else next.add(k)
        return next
      })

      try {
        if (wasStarred) {
          await unstarSet(eventId, artistId, dayId)
        } else {
          await starSet(eventId, artistId, dayId)
        }
        // Refetch the authoritative star list.
        const fresh = await listStarredSets(eventId)
        setStarred(new Set(fresh.map((s) => starKey(s.artist_id, s.day_id))))
      } catch {
        // Revert optimistic update on error.
        setStarred((prev) => {
          const next = new Set(prev)
          if (wasStarred) next.add(k)
          else next.delete(k)
          return next
        })
      } finally {
        pending.current.delete(k)
      }
    },
    [eventId, starred],
  )

  const groups = buildGroups(slots, days, stages, starred)

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <p className="mono text-xs uppercase tracking-widest" style={{ color: 'var(--acid)' }}>
            Lineup
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
          {starred.size > 0 && (
            <p className="mono text-xs" style={{ color: 'var(--ink-dim)' }}>
              {starred.size} set{starred.size === 1 ? '' : 's'} starred
            </p>
          )}
        </header>

        {loading && (
          <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
            Loading lineup…
          </p>
        )}

        {!loading && groups.length === 0 && (
          <div
            className="p-6 text-center"
            style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
          >
            <p className="mono text-xs uppercase tracking-widest" style={{ color: 'var(--ink-mute)' }}>
              No lineup published yet
            </p>
          </div>
        )}

        {groups.map(({ day, slots: daySlots }) => (
          <section key={day.id} className="space-y-2">
            <h2
              className="mono text-xs uppercase tracking-widest"
              style={{ color: 'var(--acid)' }}
            >
              {day.day_label}
              {day.date && (
                <span style={{ color: 'var(--ink-mute)', marginLeft: 8 }}>{day.date}</span>
              )}
            </h2>
            <div
              style={{
                border: '1.5px solid var(--line)',
                background: 'var(--surface)',
              }}
            >
              {daySlots.map((slot, i) => (
                <SlotRow
                  key={`${slot.artistId}:${slot.dayId}`}
                  slot={slot}
                  isLast={i === daySlots.length - 1}
                  onToggleStar={() => void toggleStar(slot.artistId, slot.dayId)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  )
}

function SlotRow({
  slot,
  isLast,
  onToggleStar,
}: {
  slot: SlotView
  isLast: boolean
  onToggleStar: () => void
}) {
  const timeLabel =
    slot.startTime
      ? slot.endTime
        ? `${fmtTime(slot.startTime)} – ${fmtTime(slot.endTime)}`
        : fmtTime(slot.startTime)
      : ''

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderBottom: isLast ? 'none' : '1px solid var(--line)',
      }}
    >
      {/* Left: artist info */}
      <div className="space-y-0.5 min-w-0">
        <div className="text-sm" style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {slot.artistName}
        </div>
        <div
          className="mono text-[10px] uppercase tracking-wide"
          style={{ color: 'var(--ink-mute)' }}
        >
          {[slot.stageName, tierBadge(slot.tier), timeLabel].filter(Boolean).join(' · ')}
        </div>
      </div>

      {/* Right: star toggle */}
      <button
        type="button"
        onClick={onToggleStar}
        aria-label={slot.isStarred ? 'Unstar set' : 'Star set'}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px 6px',
          color: slot.isStarred ? 'var(--acid)' : 'var(--ink-mute)',
          fontSize: 18,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        {slot.isStarred ? '★' : '☆'}
      </button>
    </div>
  )
}
