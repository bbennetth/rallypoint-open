import { useEffect, useState } from 'react'
import {
  selectActiveSessions,
  selectCurrentLineup,
  type LineupNowEntry,
  type ResolvedSession,
} from '@rallypoint/events-shared'
import {
  getEventWeather,
  listDays,
  listLineup,
  listSessions,
  listStages,
  type DayDto,
  type LineupSlotDto,
  type SessionDtoFull,
  type StageDto,
} from '../../lib/api.js'
import { WeatherSection } from '../PublicEventPage.js'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Phase 4 (#16). Solo-attendee "Now" view: lineup-now + sessions-now +
// weather, all driven from the event id alone (no group context). The
// existing group-aware NowPage stays in place for group attendees;
// this variant exists so the solo flow is self-contained and the
// group-coupled widgets (rallies / chat) drop out cleanly.

export function SoloNowPage() {
  const { event } = useSoloEventOutlet()
  const eventId = event.id
  const [stages, setStages] = useState<StageDto[]>([])
  const [days, setDays] = useState<DayDto[]>([])
  const [slots, setSlots] = useState<LineupSlotDto[]>([])
  const [sessions, setSessions] = useState<SessionDtoFull[]>([])
  const [now, setNow] = useState<Date>(() => new Date())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([
      listStages(eventId).catch(() => [] as StageDto[]),
      listDays(eventId).catch(() => [] as DayDto[]),
      listLineup(eventId).catch(() => [] as LineupSlotDto[]),
      listSessions(eventId, { approvalStatus: 'approved' }).catch(
        () => [] as SessionDtoFull[],
      ),
    ]).then(([st, dy, sl, ss]) => {
      if (cancelled) return
      setStages(st)
      setDays(dy)
      setSlots(sl)
      setSessions(ss)
      setLoading(false)
    })
    const tick = window.setInterval(() => setNow(new Date()), 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(tick)
    }
  }, [eventId])

  const lineupEntries: LineupNowEntry[] = selectCurrentLineup({
    slots: slots.map((s) => ({
      artistId: s.artist_id,
      dayId: s.day_id,
      stageId: s.stage_id,
      startTime: s.start_time,
      endTime: s.end_time,
      displayName: s.display_name,
    })),
    days: days.map((d) => ({ id: d.id, date: d.date })),
    stages: stages.map((s) => ({ id: s.id, name: s.name, sortOrder: s.sort_order })),
    artists: [],
    now,
  })

  const activeSessions: ResolvedSession[] = selectActiveSessions({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      dayId: s.day_id,
      startTime: s.start_time,
      endTime: s.end_time,
    })),
    days: days.map((d) => ({ id: d.id, date: d.date })),
    now,
  })

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <p className="text-xs font-medium" style={{ color: 'var(--acid)' }}>
            Now · solo
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
        </header>

        {loading && (
          <p className="text-sm text-white/60">Loading…</p>
        )}

        <Widget title="Lineup now">
          {lineupEntries.length === 0 ? (
            <p className="text-sm text-white/60">Nothing scheduled around now.</p>
          ) : (
            <ul className="space-y-2">
              {lineupEntries.map((e) => (
                <li
                  key={e.stageId ?? '—'}
                  className="grid grid-cols-[80px_1fr] gap-3 text-sm items-baseline"
                >
                  <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                    {e.stageName ?? '—'}
                  </span>
                  <span className="text-white/85">
                    {e.current ? (
                      <>
                        <span style={{ color: 'var(--accent)' }}>● </span>
                        {e.current.artistName}
                      </>
                    ) : e.next ? (
                      <>
                        <span className="text-white/40">next: </span>
                        {e.next.artistName}{' '}
                        <span className="text-white/40">@ {formatTime(e.next.startsAt)}</span>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Widget>

        <Widget title="Sessions now">
          {activeSessions.length === 0 ? (
            <p className="text-sm text-white/60">Nothing happening right now.</p>
          ) : (
            <ul className="space-y-2">
              {activeSessions.map((s) => (
                <li
                  key={s.id}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="text-white/85">{s.title}</span>
                  <span className="text-[10px] font-medium text-[color:var(--ink-mute)]">
                    {formatTime(s.startsAt)} – {formatTime(s.endsAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Widget>

        <WeatherSection fetcher={() => getEventWeather(event.id)} />
      </div>
    </main>
  )
}

function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="p-4 space-y-3"
      style={{ border: '1.5px solid var(--line)', background: 'var(--surface)' }}
    >
      <h2 className="text-xs font-medium" style={{ color: 'var(--acid)' }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
