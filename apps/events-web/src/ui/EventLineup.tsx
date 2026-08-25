import { useCallback, useEffect, useRef, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import { Avatar, Icon } from '@rallypoint/ui'
import {
  favoriteArtist,
  listDays,
  listFavoriteArtists,
  listGroupArtistFavorites,
  listLineup,
  listStages,
  unfavoriteArtist,
  type ArtistFavoriteKeyDto,
  type DayDto,
  type GroupArtistFavoriteDto,
  type LineupSlotDto,
  type StageDto,
} from '../lib/api.js'
import { buildGroups, fmtTime, tierBadge, type SlotView } from '../lib/lineup-view.js'
import { useRefreshBus } from '../lib/refresh-bus.js'
import { useSession } from '../lib/session.js'
import { SERVICE_LABELS, ServiceIcon } from './service-icons.js'

// Attendee-side Lineup body (issue #194). Shows all lineup slots grouped
// by day, two lines per row — artist · genre · links over stage · time —
// with the ♥ favorite right-anchored.
//
// The heart favorites the ARTIST for the event — day-agnostic, so it
// works while the whole lineup is still TBA. It is optimistic-updated
// with a server refetch. (The older per-set ★ star was retired from this
// view: nothing else in events-web surfaced a starred set, so it did
// nothing the heart doesn't. Its API + tables are still in place.)
//
// Keyed on `eventId` alone so both attendee shells render the same view:
// the solo route passes the event from its outlet, the group route passes
// the event behind the active group plus `groupId`, which turns on the
// group overlay (which members favorited each artist).
//
// This view is READ-ONLY aside from the favorite toggle.

export function EventLineup({
  eventId,
  title,
  groupId,
}: {
  eventId: string
  title: string
  groupId?: string | undefined
}) {
  const { userId } = useSession()
  const [days, setDays] = useState<DayDto[]>([])
  const [slots, setSlots] = useState<LineupSlotDto[]>([])
  const [stages, setStages] = useState<StageDto[]>([])
  const [favorited, setFavorited] = useState<Set<string>>(new Set())
  // artistId → other group members who favorited it (self excluded).
  const [groupFavs, setGroupFavs] = useState<Map<string, GroupArtistFavoriteDto[]>>(new Map())
  const [loading, setLoading] = useState(true)
  // Track in-flight favorite calls to prevent double-taps.
  const pending = useRef(new Set<string>())

  const buildGroupFavs = useCallback(
    (rows: GroupArtistFavoriteDto[]): Map<string, GroupArtistFavoriteDto[]> => {
      const map = new Map<string, GroupArtistFavoriteDto[]>()
      for (const r of rows) {
        if (userId && r.user_id === userId) continue
        const list = map.get(r.artist_id) ?? []
        list.push(r)
        map.set(r.artist_id, list)
      }
      return map
    },
    [userId],
  )

  const run = useAsyncTask()
  const load = useCallback(() => {
    setLoading(true)
    void run(async (ctx) => {
      const [dy, sl, st, favs, gfavs] = await Promise.all([
        listDays(eventId).catch(() => [] as DayDto[]),
        listLineup(eventId).catch(() => [] as LineupSlotDto[]),
        listStages(eventId).catch(() => [] as StageDto[]),
        listFavoriteArtists(eventId).catch(() => [] as ArtistFavoriteKeyDto[]),
        groupId
          ? listGroupArtistFavorites(groupId).catch(() => [] as GroupArtistFavoriteDto[])
          : Promise.resolve([] as GroupArtistFavoriteDto[]),
      ])
      if (ctx.stale()) return
      setDays(dy)
      setSlots(sl)
      setStages(st)
      setFavorited(new Set(favs.map((f) => f.artist_id)))
      setGroupFavs(buildGroupFavs(gfavs))
      setLoading(false)
    })
  }, [eventId, groupId, run, buildGroupFavs])

  useEffect(() => {
    load()
  }, [load])

  // Each list call swallows its own failure into an empty array, so a failed
  // fetch renders as "No lineup published yet". Pull-to-refresh is the way
  // back from that — without this the empty state would be permanent.
  useRefreshBus(load)

  const toggleFavorite = useCallback(
    async (artistId: string) => {
      const k = `fav:${artistId}`
      if (pending.current.has(k)) return
      pending.current.add(k)

      // Optimistic toggle.
      const wasFavorited = favorited.has(artistId)
      setFavorited((prev) => {
        const next = new Set(prev)
        if (wasFavorited) next.delete(artistId)
        else next.add(artistId)
        return next
      })

      try {
        if (wasFavorited) {
          await unfavoriteArtist(eventId, artistId)
        } else {
          await favoriteArtist(eventId, artistId)
        }
        // Refetch the authoritative favorite list.
        const fresh = await listFavoriteArtists(eventId)
        setFavorited(new Set(fresh.map((f) => f.artist_id)))
      } catch {
        // Revert optimistic update on error.
        setFavorited((prev) => {
          const next = new Set(prev)
          if (wasFavorited) next.add(artistId)
          else next.delete(artistId)
          return next
        })
      } finally {
        pending.current.delete(k)
      }
    },
    [eventId, favorited],
  )

  const groups = buildGroups(slots, days, stages)

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <p className="mono text-xs uppercase tracking-widest" style={{ color: 'var(--acid)' }}>
            Lineup
          </p>
          <h1 className="display text-2xl">{title}</h1>
          {favorited.size > 0 && (
            <p className="mono text-xs" style={{ color: 'var(--ink-dim)' }}>
              {favorited.size} artist{favorited.size === 1 ? '' : 's'} favorited
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
            className="p-6 text-center pl-card"
          >
            <p className="mono text-xs uppercase tracking-widest" style={{ color: 'var(--ink-mute)' }}>
              No lineup published yet
            </p>
          </div>
        )}

        {groups.map(({ day, slots: daySlots }) => (
          // day null = the trailing TBA group of unscheduled bookings.
          <section key={day?.id ?? 'tba'} className="space-y-2">
            <h2
              className="mono text-xs uppercase tracking-widest"
              style={{ color: 'var(--acid)' }}
            >
              {day?.day_label ?? 'TBA'}
              {day?.date && (
                <span style={{ color: 'var(--ink-mute)', marginLeft: 8 }}>{day.date}</span>
              )}
            </h2>
            <div>
              {daySlots.map((slot) => (
                <SlotRow
                  key={`${slot.artistId}:${slot.dayId ?? 'none'}`}
                  slot={slot}
                  isFavorited={favorited.has(slot.artistId)}
                  favoritedBy={groupFavs.get(slot.artistId) ?? []}
                  onToggleFavorite={() => void toggleFavorite(slot.artistId)}
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
  isFavorited,
  favoritedBy,
  onToggleFavorite,
}: {
  slot: SlotView
  isFavorited: boolean
  // Other group members who favorited this artist (empty outside groups).
  favoritedBy: GroupArtistFavoriteDto[]
  onToggleFavorite: () => void
}) {
  const timeLabel =
    slot.startTime
      ? slot.endTime
        ? `${fmtTime(slot.startTime)} – ${fmtTime(slot.endTime)}`
        : fmtTime(slot.startTime)
      : ''

  // Redesigned row (map/social handoff §4): grid 1fr/auto with
  // align-items:start so a long artist name wraps (never truncates)
  // without reflowing the star/avatars column. Left column stacks
  // artist+genre, meta, then social links; right column stacks the
  // star over the crew avatars.
  return (
    <div className={'lu-row' + (isFavorited ? ' starred' : '')}>
      <div className="lu-info">
        <div>
          <span className="lu-artist">{slot.artistName}</span>
          {slot.genre && <span className="lu-genre"> {slot.genre}</span>}
        </div>
        <div className="lu-meta">
          {[timeLabel || 'TBA', slot.stageName, tierBadge(slot.tier)]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {slot.links.length > 0 && (
          <div className="lu-links">
            {slot.links.map(({ kind, url }) => (
              <a
                key={kind}
                className="lu-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${slot.artistName} on ${SERVICE_LABELS[kind]}`}
                title={SERVICE_LABELS[kind]}
              >
                <ServiceIcon kind={kind} size={14} />
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="lu-side">
        {/* One SVG path in both states, filled or not — a glyph pair
            would come from different fallback fonts and change size. */}
        <button
          type="button"
          className={'lu-star' + (isFavorited ? ' on' : '')}
          onClick={onToggleFavorite}
          aria-label={isFavorited ? 'Unfavorite artist' : 'Favorite artist'}
        >
          <Icon name="star" size={20} filled={isFavorited} />
        </button>
        {favoritedBy.length > 0 && (
          <div
            className="lu-crew"
            title={favoritedBy.map((m) => m.display_name ?? 'member').join(', ')}
          >
            {favoritedBy.slice(0, 3).map((m) => (
              <Avatar key={m.user_id} name={m.display_name} size={20} />
            ))}
            {favoritedBy.length > 3 && <span className="more">+{favoritedBy.length - 3}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
