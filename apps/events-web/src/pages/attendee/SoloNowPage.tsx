import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAsyncTask } from '@rallypoint/web-kit'
import {
  selectActiveSessions,
  selectCurrentLineup,
  type LineupNowEntry,
  type ResolvedSession,
} from '@rallypoint/events-shared'
import {
  listDays,
  listLineup,
  listSessions,
  listStages,
  type DayDto,
  type LineupSlotDto,
  type SessionDtoFull,
  type StageDto,
} from '../../lib/api.js'
import {
  buildHourGroups,
  defaultDateForEvent,
  hm,
  todayIso,
} from '../../lib/attendee-day.js'
import { artistSummaries } from '../../lib/lineup-view.js'
import { DayPicker } from '../../ui/DayPicker.js'
import { WeatherPanel } from '../../ui/WeatherPanel.js'
import { useSoloEventOutlet } from './_solo-event-outlet.js'

// Solo-attendee "Now" tab — the same merged shape as the group NowPage:
// live signals on today's view, plus a day picker and that day's agenda.
// Everything is driven from the event id alone; the group-coupled pieces
// (rallies, tasks, conflicts) simply don't exist here.

interface AgendaRow {
  key: string
  kind: 'set' | 'session'
  time: string | null
  title: React.ReactNode
  sub: React.ReactNode
}

export function SoloNowPage() {
  const { event } = useSoloEventOutlet()
  const eventId = event.id
  const [stages, setStages] = useState<StageDto[]>([])
  const [days, setDays] = useState<DayDto[]>([])
  const [slots, setSlots] = useState<LineupSlotDto[]>([])
  const [sessions, setSessions] = useState<SessionDtoFull[]>([])
  const [now, setNow] = useState<Date>(() => new Date())
  const [loading, setLoading] = useState(true)

  const today = todayIso()
  const [date, setDate] = useState<string>(today)
  // Once the user picks a day themselves, stop auto-snapping.
  const userPicked = useRef(false)

  const run = useAsyncTask()
  useEffect(() => {
    setLoading(true)
    void run(async (ctx) => {
      const [st, dy, sl, ss] = await Promise.all([
        listStages(eventId).catch(() => [] as StageDto[]),
        listDays(eventId).catch(() => [] as DayDto[]),
        listLineup(eventId).catch(() => [] as LineupSlotDto[]),
        listSessions(eventId, { approvalStatus: 'approved' }).catch(
          () => [] as SessionDtoFull[],
        ),
      ])
      if (ctx.stale()) return
      setStages(st)
      setDays(dy)
      setSlots(sl)
      setSessions(ss)
      setLoading(false)
      // Open on today when the event is running, otherwise its first day
      // so the page doesn't render empty well before the gates open.
      if (!userPicked.current && dy.length > 0) {
        setDate(defaultDateForEvent(dy, todayIso()))
      }
    })
  }, [eventId, run])

  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 60 * 1000)
    return () => window.clearInterval(tick)
  }, [])

  const onDateChange = useCallback((next: string) => {
    userPicked.current = true
    setDate(next)
  }, [])

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
    artists: artistSummaries(slots),
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

  const dayId = useMemo(() => days.find((d) => d.date === date)?.id ?? null, [days, date])
  const agendaGroups = useMemo(() => {
    const rows: AgendaRow[] = []
    for (const s of slots.filter((x) => x.day_id === dayId)) {
      const stageName = stages.find((st) => st.id === s.stage_id)?.name ?? null
      rows.push({
        key: `s-${s.artist_id}`,
        kind: 'set',
        time: s.start_time,
        title: s.display_name ?? s.artist_name,
        sub: (
          <>
            {stageName && <span className="text-[color:var(--ink-mute)]">{stageName}</span>}
            {s.end_time && (
              <span className="text-[color:var(--ink-mute)]">
                {stageName ? ' · ' : ''}until {hm(s.end_time)}
              </span>
            )}
          </>
        ),
      })
    }
    for (const s of sessions.filter((x) => x.day_id === dayId)) {
      rows.push({
        key: `x-${s.id}`,
        kind: 'session',
        time: s.start_time,
        title: s.title,
        sub: s.end_time ? (
          <span className="text-[color:var(--ink-mute)]">until {hm(s.end_time)}</span>
        ) : null,
      })
    }
    return buildHourGroups(rows)
  }, [slots, sessions, stages, dayId])

  const isToday = date === today

  return (
    <main className="page-pad">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <p className="text-xs font-medium" style={{ color: 'var(--acid)' }}>
            Now
          </p>
          <h1 className="display text-2xl">{event.name}</h1>
        </header>

        {loading && <p className="text-sm text-[color:var(--ink-dim)]">Loading…</p>}

        <DayPicker days={days} value={date} onChange={onDateChange} fallbackToday={today} />

        {/* Live signals are only meaningful on today's view. */}
        {isToday && (
          <>
            <Widget title="Lineup now">
              {lineupEntries.length === 0 ? (
                <p className="text-sm text-[color:var(--ink-dim)]">Nothing scheduled around now.</p>
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
                            <span className="text-[color:var(--ink-mute)]">
                              @ {formatTime(e.next.startsAt)}
                            </span>
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
                <p className="text-sm text-[color:var(--ink-dim)]">Nothing happening right now.</p>
              ) : (
                <ul className="space-y-2">
                  {activeSessions.map((s) => (
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
          </>
        )}

        <WeatherPanel eventId={eventId} dayIso={date} />

        {agendaGroups.length === 0 ? (
          <p className="text-sm text-[color:var(--ink-dim)]">Nothing scheduled for this day.</p>
        ) : (
          <section
            className="p-4 space-y-3 pl-card"
          >
            <h2 className="text-xs font-medium text-[color:var(--ink-mute)]">Agenda</h2>
            <div className="space-y-3">
              {agendaGroups.map((g) => (
                <div key={g.hour} className="space-y-1">
                  <div
                    style={{
                      fontSize: 9,
                      color: 'var(--ink-mute)',
                      borderBottom: '1px solid var(--hairline-soft)',
                      paddingBottom: 2,
                    }}
                  >
                    {g.hour === '—' ? 'No time' : g.hour}
                  </div>
                  <ul className="space-y-1">
                    {g.rows.map((r) => (
                      <li key={r.key} className="flex items-baseline gap-3 text-sm py-1">
                        <KindChip kind={r.kind} />
                        {r.time && (
                          <span className="font-mono w-12 shrink-0 tabular-nums text-[color:var(--ink-mute)]">
                            {hm(r.time)}
                          </span>
                        )}
                        <span className="flex-1">
                          {r.title}
                          {r.sub && <> · {r.sub}</>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  )
}

function KindChip({ kind }: { kind: 'set' | 'session' }) {
  const label = kind === 'set' ? 'SET' : 'SESS'
  const color = kind === 'set' ? 'var(--ev-warn)' : 'var(--ink-dim)'
  return (
    <span
      style={{
        fontSize: 9,
        color,
        border: `1px solid ${color}`,
        padding: '0 4px',
        lineHeight: '14px',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  )
}

function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="p-4 space-y-3 pl-card"
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
