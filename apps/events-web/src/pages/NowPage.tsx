import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsyncTask } from '@rallypoint/web-kit'
import {
  selectActiveSessions,
  selectCurrentLineup,
  selectUpcomingRallies,
  type LineupNowEntry,
  type ResolvedRally,
  type ResolvedSession,
} from '@rallypoint/events-shared'
import {
  ApiError,
  getGroup,
  getGroupDay,
  listDays,
  listLineup,
  listRallies,
  listSessions,
  listStages,
  type GroupDayDto,
  type GroupDetailDto,
  type DayDto,
  type LineupSlotDto,
  type RallyDto,
  type SessionDtoFull,
  type StageDto,
} from '../lib/api.js'
import { defaultDateForEvent, todayIso } from '../lib/attendee-day.js'
import { artistSummaries } from '../lib/lineup-view.js'
import { useCachedFetch } from '../lib/cached-fetch.js'
import { useRefreshBus } from '../lib/refresh-bus.js'
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
import { DayPicker } from '../ui/DayPicker.js'
import { GroupDayAgenda } from '../ui/GroupDayAgenda.js'
import { WeatherPanel } from '../ui/WeatherPanel.js'

// "Now" — the group attendee's home tab. Merges what used to be two tabs:
// the live signals (what's playing, next rallies, sessions on now)
// and the day plan that was "My Day". A day picker sits under the header;
// the live widgets only make sense for today, so they render on today's
// view and drop out when you look ahead at another day. The day's agenda
// (rallies + sets + tasks + conflicts) renders for every day.
//
// Each widget loads independently with inline degradation — a 502 on one
// endpoint shouldn't blank the lineup tile.

const RALLY_HORIZON_MS = 3 * 60 * 60 * 1000 // 3h

type DayLoadState =
  | { status: 'loading' }
  | { status: 'ready'; day: GroupDayDto }
  | { status: 'error'; code: string; message: string }

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
  const eventId = group.data?.event_id ?? null

  // Event days drive the picker. Shares the `days:<eventId>` cache row with
  // the widgets below, so this doesn't cost an extra round trip in practice.
  const days = useCachedFetch<DayDto[]>({
    key: `days:${eventId ?? 'pending'}`,
    loadFromCache: async () =>
      eventId
        ? ((await readEventLineup<{ days: DayDto[] }>(`days:${eventId}`))?.days ?? null)
        : null,
    saveToCache: async (v) => {
      if (eventId) await writeEventLineup(`days:${eventId}`, { days: v })
    },
    revalidate: async () => (eventId ? listDays(eventId) : []),
  })

  const today = todayIso()
  const [date, setDate] = useState<string>(today)
  // Once the user picks a day themselves, stop auto-snapping — otherwise a
  // late-landing days fetch would yank them back off their pick.
  const userPicked = useRef(false)
  const dayList = days.data

  useEffect(() => {
    if (userPicked.current || !dayList || dayList.length === 0) return
    setDate(defaultDateForEvent(dayList, todayIso()))
  }, [dayList])

  const onDateChange = useCallback((next: string) => {
    userPicked.current = true
    setDate(next)
  }, [])

  // The day's plan — rallies/sets/tasks/conflicts for the picked date.
  const [dayState, setDayState] = useState<DayLoadState>({ status: 'loading' })
  const run = useAsyncTask()
  const loadDay = useCallback(() => {
    setDayState({ status: 'loading' })
    void run(async (ctx) => {
      try {
        const day = await getGroupDay(groupId, date)
        if (ctx.stale()) return
        setDayState({ status: 'ready', day })
      } catch (err) {
        if (ctx.stale()) return
        if (err instanceof ApiError && err.status === 404) {
          setDayState({ status: 'error', code: 'not_found', message: 'Group not found.' })
        } else {
          setDayState({
            status: 'error',
            code: err instanceof ApiError ? err.code : 'unexpected_error',
            message: err instanceof Error ? err.message : 'Unknown error.',
          })
        }
      }
    })
  }, [groupId, date, run])

  useEffect(() => {
    loadDay()
  }, [loadDay])

  // Pull-to-refresh in the chrome revalidates the day view alongside the
  // cached widgets, which subscribe to the same bus themselves.
  useRefreshBus(loadDay)

  const isToday = date === today

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <p className="text-xs font-medium text-[color:var(--ink-mute)]">
            Now · {group.data?.name ?? '—'}
          </p>
          <h1 className="display text-2xl">What's happening</h1>
        </header>

        {Boolean(group.error) && !group.data && (
          <p className="text-sm text-[color:var(--ink-dim)]">Couldn't load this group. Retrying…</p>
        )}

        {/* Held back until the event is known: with no eventId the days fetch
            resolves to [] immediately, which would flash the picker's
            no-days-published date input before the real days land. */}
        {eventId && (
          <DayPicker
            days={days.data ?? []}
            value={date}
            onChange={onDateChange}
            fallbackToday={today}
          />
        )}

        {/* Live signals are only meaningful on today's view. */}
        {group.data && isToday && (
          <>
            <LineupNowWidget eventId={group.data.event_id} />
            <UpcomingRalliesWidget groupId={groupId} />
            <ActiveSessionsWidget eventId={group.data.event_id} />
          </>
        )}

        {eventId && <WeatherPanel eventId={eventId} dayIso={date} />}

        {dayState.status === 'loading' && (
          <p className="text-sm text-[color:var(--ink-dim)]">Loading…</p>
        )}

        {dayState.status === 'error' && (
          <div
            className="p-4"
            style={{
              background: 'var(--hot-soft)',
              color: 'var(--hot-text)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <p className="text-sm text-[color:var(--ink)]">{dayState.message}</p>
          </div>
        )}

        {dayState.status === 'ready' && (
          <GroupDayAgenda day={dayState.day} isToday={isToday} />
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
  const errored = Boolean(stages.error) || Boolean(days.error) || Boolean(slots.error)
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
      artists: artistSummaries(slots.data!),
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
      {!rallies.data && Boolean(rallies.error) && (
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
                to={`/groups/${encodeURIComponent(groupId)}/rallies`}
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
      {!sessions.data && Boolean(sessions.error) && (
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

// --- shared helpers -----------------------------------------------

function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="p-4 space-y-3 pl-card"
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
