import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  selectActiveSessions,
  selectCurrentLineup,
  selectUpcomingRallies,
  type LineupNowEntry,
  type ResolvedRally,
  type ResolvedSession,
} from '@rallypoint/events-shared'
import {
  getGroup,
  getEventWeather,
  listChatMessages,
  listDays,
  listLineup,
  listRallies,
  listSessions,
  listStages,
  type GroupDetailDto,
  type DayDto,
  type LineupSlotDto,
  type RallyDto,
  type SessionDtoFull,
  type StageDto,
} from '../lib/api.js'
import { useCachedFetch } from '../lib/cached-fetch.js'
import {
  readGroupDetail,
  readGroupRallies,
  readEventLineup,
  readEventSessions,
  writeGroupDetail,
  writeGroupRallies,
  writeEventLineup,
  writeEventSessions,
} from '../lib/cache.js'
import { WeatherSection } from './PublicEventPage.js'

// "Now" view (slice 13). Aggregates the five most-immediate signals an
// attendee cares about into a single tab: what's playing right now,
// next rallies, sessions happening now, weather snapshot, and an
// unread-chat badge. Each widget loads independently with inline
// degradation — a 502 on the chat endpoint shouldn't blank the
// lineup tile.

const RALLY_HORIZON_MS = 3 * 60 * 60 * 1000 // 3h
const CHAT_PEEK_LIMIT = 20

export function NowPage() {
  const { groupId } = useParams<{ groupId: string }>()
  if (!groupId) {
    return (
      <main className="page-pad">
        <p className="text-sm text-[color:var(--ink-dim)]">Missing group.</p>
      </main>
    )
  }
  return <NowBody groupId={groupId} />
}

function NowBody({ groupId }: { groupId: string }) {
  const group = useCachedFetch<GroupDetailDto>({
    key: `group:${groupId}`,
    loadFromCache: () => readGroupDetail<GroupDetailDto>(groupId),
    saveToCache: (v) => writeGroupDetail(groupId, v),
    revalidate: () => getGroup(groupId),
  })

  // Group detail might fail entirely on a cold cache + offline. Render
  // a thin shell either way; widgets that need eventId wait for it.
  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">
            Now · {group.data?.name ?? '—'}
          </p>
          <h1 className="display text-2xl">What's happening</h1>
        </header>

        {group.error && !group.data && (
          <p className="text-sm text-[color:var(--ink-dim)]">Couldn't load this group. Retrying…</p>
        )}

        {group.data && (
          <>
            <LineupNowWidget eventId={group.data.event_id} />
            <UpcomingRalliesWidget groupId={groupId} />
            <ActiveSessionsWidget eventId={group.data.event_id} />
            <WeatherSection fetcher={() => getEventWeather(group.data!.event_id)} />
            <ChatUnreadBadge groupId={groupId} userId={group.data.viewer_role ? null : null} />
          </>
        )}
      </div>
    </main>
  )
}

// --- Lineup-now ----------------------------------------------------

function LineupNowWidget({ eventId }: { eventId: string }) {
  const stages = useCachedFetch<StageDto[]>({
    key: `stages:${eventId}`,
    loadFromCache: async () =>
      (await readEventLineup<{ stages: StageDto[] }>(`stages:${eventId}`))?.stages ?? null,
    saveToCache: (v) => writeEventLineup(`stages:${eventId}`, { stages: v }),
    revalidate: () => listStages(eventId),
  })
  const days = useCachedFetch<DayDto[]>({
    key: `days:${eventId}`,
    loadFromCache: async () =>
      (await readEventLineup<{ days: DayDto[] }>(`days:${eventId}`))?.days ?? null,
    saveToCache: (v) => writeEventLineup(`days:${eventId}`, { days: v }),
    revalidate: () => listDays(eventId),
  })
  const slots = useCachedFetch<LineupSlotDto[]>({
    key: `slots:${eventId}`,
    loadFromCache: async () =>
      (await readEventLineup<{ slots: LineupSlotDto[] }>(`slots:${eventId}`))?.slots ?? null,
    saveToCache: (v) => writeEventLineup(`slots:${eventId}`, { slots: v }),
    revalidate: () => listLineup(eventId),
  })

  const isLoading = !stages.data && !days.data && !slots.data
  const errored = stages.error || days.error || slots.error
  const dataReady = stages.data && days.data && slots.data
  const now = useNow()

  let entries: LineupNowEntry[] = []
  if (dataReady) {
    entries = selectCurrentLineup({
      slots: slots.data!.map((s) => ({
        artistId: s.artist_id,
        dayId: s.day_id,
        stageId: s.stage_id,
        startTime: s.start_time,
        endTime: s.end_time,
        displayName: s.display_name,
      })),
      days: days.data!.map((d) => ({ id: d.id, date: d.date })),
      stages: stages.data!.map((s) => ({ id: s.id, name: s.name, sortOrder: s.sort_order })),
      artists: [], // names come from displayName fallback; lineup endpoint
                   // doesn't currently include artist names. The selector
                   // gracefully falls back to 'Unknown artist'.
      now,
    })
  }

  return (
    <Widget title="Lineup now">
      {isLoading && <p className="text-sm text-[color:var(--ink-dim)]">Loading…</p>}
      {errored && !dataReady && (
        <p className="text-sm text-[color:var(--ink-dim)]">Lineup is unavailable right now.</p>
      )}
      {dataReady && entries.length === 0 && (
        <p className="text-sm text-[color:var(--ink-dim)]">Nothing scheduled around now.</p>
      )}
      {dataReady && entries.length > 0 && (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.stageId ?? '—'} className="grid grid-cols-[80px_1fr] gap-3 text-sm items-baseline">
              <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                {e.stageName ?? '—'}
              </span>
              <span className="text-[color:var(--ink)]">
                {e.current ? (
                  <>
                    <span style={{ color: 'var(--accent)' }}>● </span>
                    {e.current.artistName}
                  </>
                ) : e.next ? (
                  <>
                    <span className="text-[color:var(--ink-mute)]">next: </span>
                    {e.next.artistName}{' '}
                    <span className="text-[color:var(--ink-mute)]">@ {formatTime(e.next.startsAt)}</span>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}

// --- Rallies-3h ----------------------------------------------------

function UpcomingRalliesWidget({ groupId }: { groupId: string }) {
  const rallies = useCachedFetch<RallyDto[]>({
    key: `rallies:${groupId}`,
    loadFromCache: () => readGroupRallies<RallyDto[]>(groupId),
    saveToCache: (v) => writeGroupRallies(groupId, v),
    revalidate: () => listRallies(groupId),
  })

  // Days come from the event tied to this group — we already fetched
  // them via the lineup widget, but cache-keyed independently. Doing
  // a small re-fetch keeps the widgets standalone.
  const days = useCachedFetch<DayDto[]>({
    // Tie cache to a single shared key so the lineup + rallies + sessions
    // widgets all hit the same Dexie row for days.
    key: `days-for-rallies:${groupId}`,
    loadFromCache: async () => {
      // Best-effort: derive event id from a cached group detail.
      const cached = await readGroupDetail<GroupDetailDto>(groupId)
      if (!cached) return null
      return (await readEventLineup<{ days: DayDto[] }>(`days:${cached.event_id}`))?.days ?? null
    },
    saveToCache: async (v) => {
      const cached = await readGroupDetail<GroupDetailDto>(groupId)
      if (!cached) return
      await writeEventLineup(`days:${cached.event_id}`, { days: v })
    },
    revalidate: async () => {
      const cached = await readGroupDetail<GroupDetailDto>(groupId)
      if (!cached) return []
      return listDays(cached.event_id)
    },
  })

  const now = useNow()
  const upcoming: ResolvedRally[] =
    rallies.data && days.data
      ? selectUpcomingRallies({
          rallies: (rallies.data ?? []).map((r) => ({
            id: r.id,
            title: r.title,
            dayId: r.day_id,
            startTime: r.start_time,
            status: r.status,
          })),
          days: (days.data ?? []).map((d) => ({ id: d.id, date: d.date })),
          now,
          horizonMs: RALLY_HORIZON_MS,
        })
      : []

  return (
    <Widget title="Rallies (next 3h)">
      {!rallies.data && rallies.error && (
        <p className="text-sm text-[color:var(--ink-dim)]">Rallies are unavailable right now.</p>
      )}
      {rallies.data && upcoming.length === 0 && (
        <p className="text-sm text-[color:var(--ink-dim)]">No rallies in the next 3 hours.</p>
      )}
      {upcoming.length > 0 && (
        <ul className="space-y-2">
          {upcoming.map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-3 text-sm">
              <Link
                to={`/groups/${encodeURIComponent(groupIdFromUrl())}/rallies`}
                className="text-[color:var(--ink)] hover:text-[color:var(--ink)]"
              >
                {r.title}
              </Link>
              <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                {formatTime(r.startsAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}

// useParams isn't reachable here; we accept it via prop on the parent.
// This helper keeps the link href readable.
function groupIdFromUrl(): string {
  // Read from window.location to avoid prop-drilling to leaf nodes.
  // Inside the events-web SPA this is reliable; the URL always has
  // /groups/<id>/now.
  const match = (typeof window === 'undefined' ? '' : window.location.pathname).match(
    /\/groups\/([^/]+)/,
  )
  return match ? match[1]! : ''
}

// --- Sessions-now --------------------------------------------------

function ActiveSessionsWidget({ eventId }: { eventId: string }) {
  const sessions = useCachedFetch<SessionDtoFull[]>({
    key: `sessions:${eventId}`,
    loadFromCache: () => readEventSessions<SessionDtoFull[]>(eventId),
    saveToCache: (v) => writeEventSessions(eventId, v),
    revalidate: () => listSessions(eventId, { approvalStatus: 'approved' }),
  })
  const days = useCachedFetch<DayDto[]>({
    key: `days-for-sessions:${eventId}`,
    loadFromCache: async () =>
      (await readEventLineup<{ days: DayDto[] }>(`days:${eventId}`))?.days ?? null,
    saveToCache: (v) => writeEventLineup(`days:${eventId}`, { days: v }),
    revalidate: () => listDays(eventId),
  })

  const now = useNow()
  const active: ResolvedSession[] =
    sessions.data && days.data
      ? selectActiveSessions({
          sessions: sessions.data!.map((s) => ({
            id: s.id,
            title: s.title,
            dayId: s.day_id,
            startTime: s.start_time,
            endTime: s.end_time,
          })),
          days: days.data!.map((d) => ({ id: d.id, date: d.date })),
          now,
        })
      : []

  return (
    <Widget title="Sessions now">
      {!sessions.data && sessions.error && (
        <p className="text-sm text-[color:var(--ink-dim)]">Sessions are unavailable right now.</p>
      )}
      {sessions.data && active.length === 0 && (
        <p className="text-sm text-[color:var(--ink-dim)]">Nothing happening right now.</p>
      )}
      {active.length > 0 && (
        <ul className="space-y-2">
          {active.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-[color:var(--ink)]">{s.title}</span>
              <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                {formatTime(s.startsAt)} – {formatTime(s.endsAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}

// --- Chat unread badge ---------------------------------------------

function ChatUnreadBadge({ groupId, userId }: { groupId: string; userId: string | null }) {
  // We don't have a "last read" cursor on the group yet, so we render
  // the last N messages as a peek instead. This is a stand-in until a
  // dedicated read-marker API ships.
  const peek = useCachedFetch<{ items: { id: string; user_id: string; body: string }[] }>({
    key: `chatpeek:${groupId}`,
    loadFromCache: async () => null,
    saveToCache: async () => {},
    revalidate: async () => {
      const page = await listChatMessages(groupId, { limit: CHAT_PEEK_LIMIT })
      return { items: page.items }
    },
  })

  const count = peek.data?.items.length ?? 0
  return (
    <Widget title="Chat">
      <div className="flex items-baseline justify-between gap-3">
        <Link
          to={`/groups/${encodeURIComponent(groupId)}/chat`}
          className="text-sm text-[color:var(--ink)] hover:text-[color:var(--ink-dim)]"
        >
          Open group chat →
        </Link>
        {count > 0 && (
          <span
            className="text-[10px] font-medium"
            style={{ color: 'var(--ink-mute)' }}
          >
            {count} recent
          </span>
        )}
      </div>
      {userId === null && null /* Suppress unused-var lint */}
    </Widget>
  )
}

// --- shared helpers -----------------------------------------------

function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="p-4 space-y-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <h2 className="text-xs font-medium text-[color:var(--ink-mute)]">{title}</h2>
      {children}
    </section>
  )
}

// Re-renders every minute so the widgets shift over as time passes.
// Cheap: just a tick state; the selectors are pure and fast.
function useNow(intervalMs: number = 60 * 1000): Date {
  const [now, setNow] = useState<Date>(() => new Date())
  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(handle)
  }, [intervalMs])
  return now
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
